//! Tests for the filter's interval-context fields (ANL-013): `malloc.calls`,
//! `malloc.spans`, `malloc.span_ids` and their `free.*` twins.
//!
//! The lowered plan reads load-time columns and marks interval chains; the
//! tree-walking oracle reads `filter_eval::context_names`, which follows the
//! spec's definition with `stack_at` and a scan of the thread's spans. Every
//! expression here goes through both.

use crate::parse::Parser;
use crate::store::*;
use crate::{filter_eval, filter_plan, App, Engine};

fn load(input: &str) -> App {
    let mut a = App::new();
    let mut p = Parser::new();
    for chunk in input.as_bytes().chunks(11) {
        p.chunk(chunk);
    }
    p.finish();
    a.store = p.store;
    a.view.reset(&a.store);
    a
}

/// The creator seqs `source` matches through the plan, asserted equal to the
/// oracle's answer.
fn matching(a: &App, source: &str) -> Vec<u32> {
    let expr = heap_visualizer_filter_dsl::parse(source)
        .unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let base = filter_eval::Ctx::new(&a.store, &[], &a.names);
    filter_eval::check(&expr, &base).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let fields = filter_eval::FieldValues::resolve(&expr, &a.store);
    let full = base.with_fields(&fields);
    let plan =
        filter_plan::lower(&expr, &full).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let mut bits = vec![0u64; a.store.row_words().max(1)];
    let matched = filter_plan::scan(&plan, &full, &mut bits);
    let mut oracle = Vec::new();
    for e in 0..a.store.len() {
        if matches!(a.store.op[e as usize], OP_M | OP_R)
            && filter_eval::evaluate(&expr, &full, e).unwrap()
        {
            oracle.push(e);
        }
    }
    let got: Vec<u32> = a.store.row_bits_events(&bits).collect();
    assert_eq!(got, oracle, "plan and oracle disagree on `{source}`");
    assert_eq!(matched as usize, oracle.len());
    got
}

fn check_error(a: &App, source: &str) -> String {
    let expr = heap_visualizer_filter_dsl::parse(source).unwrap();
    let ctx = filter_eval::Ctx::new(&a.store, &[], &a.names);
    filter_eval::check(&expr, &ctx)
        .err()
        .unwrap_or_else(|| panic!("`{source}` should not check"))
        .message
}

fn complete(a: &App, source: &str, cursor: usize) -> String {
    let mut out = String::new();
    let ctx = filter_eval::Ctx::new(&a.store, &[], &a.names);
    filter_eval::push_completions_json(&mut out, source, cursor, &ctx);
    out
}

/// A request span on thread 1, a parse span on thread 2 under it, calls
/// nested on both threads, and allocations inside, between and after them.
const TRACE: &str = r#"{"op":"H","v":2,"unit":"ns"}
{"op":"M","t":1,"thr":1,"id":1,"addr":"0x1000","size":16}
{"op":"B","t":2,"thr":1,"span":"r1","name":"request"}
{"op":"B","t":3,"thr":1,"name":"handle"}
{"op":"B","t":4,"thr":1,"name":"parse_body"}
{"op":"M","t":5,"thr":1,"id":2,"addr":"0x2000","size":16}
{"op":"B","t":6,"thr":2,"span":"r1.p","parent":"r1","name":"parse"}
{"op":"M","t":7,"thr":2,"id":3,"addr":"0x3000","size":16}
{"op":"X","t":8,"thr":1,"name":"parse_body"}
{"op":"M","t":9,"thr":1,"id":4,"addr":"0x4000","size":16}
{"op":"F","t":10,"thr":1,"id":1}
{"op":"F","t":11,"thr":2,"id":3}
{"op":"X","t":12,"thr":2,"span":"r1.p"}
{"op":"X","t":13,"thr":1,"name":"handle"}
{"op":"X","t":14,"thr":1,"span":"r1"}
{"op":"M","t":15,"thr":1,"id":5,"addr":"0x5000","size":16}
{"op":"F","t":16,"thr":1,"id":2}
"#;

#[test]
fn context_fields_match_the_worked_example() {
    let a = load(TRACE);
    // seqs: M1=0, M2=4, M3=6, M4=8, M5=14
    assert_eq!(matching(&a, r#""parse_body" in malloc.calls"#), vec![4]);
    assert_eq!(matching(&a, r#""handle" in malloc.calls"#), vec![4, 8]);
    assert_eq!(matching(&a, r#""request" in malloc.spans"#), vec![4, 6, 8]);
    // thread 2 is inside `parse`, whose parent is `request`
    assert_eq!(matching(&a, r#""parse" in malloc.spans"#), vec![6]);
    assert_eq!(matching(&a, r#""r1.p" in malloc.span_ids"#), vec![6]);
    assert_eq!(matching(&a, r#""r1" in malloc.span_ids"#), vec![4, 6, 8]);
    // nothing open on thread 2's calls
    assert_eq!(matching(&a, r#""handle" in malloc.calls and malloc.thread == 2"#), Vec::<u32>::new());
    // death context: M1 freed inside `handle`, M3 freed inside `parse`
    assert_eq!(matching(&a, r#""handle" in free.calls"#), vec![0]);
    assert_eq!(matching(&a, r#""parse" in free.spans"#), vec![6]);
    assert_eq!(matching(&a, r#""request" in free.spans"#), vec![0, 6]);
    // M2 is freed after every interval closed
    assert_eq!(matching(&a, r#"not "request" in free.spans"#), vec![4, 8, 14]);
    // missing: never freed
    assert_eq!(matching(&a, "free.calls is None"), vec![8, 14]);
    assert_eq!(matching(&a, "free.spans is not None"), vec![0, 4, 6]);
    // an unknown name matches nothing, and is not an error
    assert_eq!(matching(&a, r#""nope" in malloc.calls"#), Vec::<u32>::new());
}

#[test]
fn a_trace_without_intervals_has_empty_contexts() {
    let v1 = r#"{"op":"H","v":1}
{"op":"M","t":1,"id":1,"addr":"0x1000","size":16,"thr":1}
{"op":"F","t":2,"id":1}
"#;
    let a = load(v1);
    let ctx = &a.store.dom.intervals.heap_ctx;
    assert!(ctx.call.is_empty() && ctx.span.is_empty());
    assert!(ctx.death_call.is_empty() && ctx.death_span.is_empty());
    // empty, not missing: membership is false and its negation true
    assert_eq!(matching(&a, r#""x" in malloc.calls"#), Vec::<u32>::new());
    assert_eq!(matching(&a, r#"not "x" in malloc.spans"#), vec![0]);
    assert_eq!(matching(&a, r#"not "x" in free.calls"#), vec![0]);
    // only the death side is optional
    assert!(check_error(&a, "malloc.calls is None").contains("optional"));

    // calls without spans: only the call columns are built
    let calls_only = r#"{"op":"H","v":2}
{"op":"B","thr":1,"name":"f"}
{"op":"M","thr":1,"id":1,"addr":"0x1000","size":16}
"#;
    let a = load(calls_only);
    let ctx = &a.store.dom.intervals.heap_ctx;
    assert_eq!(ctx.call.len(), 1);
    assert!(ctx.span.is_empty());
    assert_eq!(matching(&a, r#""f" in malloc.calls"#), vec![1]);
    assert_eq!(matching(&a, r#""f" in malloc.spans"#), Vec::<u32>::new());
}

#[test]
fn context_fields_support_membership_only() {
    let a = load(TRACE);
    assert!(check_error(&a, "malloc.calls == {\"a\"}").contains("supports only membership"));
    assert!(check_error(&a, "len(malloc.spans) > 1").contains("supports only membership"));
    assert!(check_error(&a, "malloc.site in malloc.calls").contains("string constant"));
    assert!(check_error(&a, "1 in malloc.calls").contains("string constant"));
    assert!(check_error(&a, "alloc.calls").contains("`calls` is on `malloc`"));
    // a referenced allocation's context is a constant
    let mut a = a;
    a.names = vec![(4, "inner".into())];
    assert_eq!(
        matching(&a, r#""parse_body" in named("inner").malloc.calls and malloc.thread == 2"#),
        vec![6]
    );
    assert_eq!(matching(&a, r#""parse" in allocation(3).malloc.spans"#), vec![0, 4, 6, 8, 14]);
}

#[test]
fn context_fields_complete_with_observed_names() {
    let a = load(TRACE);
    let members = complete(&a, "malloc.", 7);
    for field in ["calls", "spans", "span_ids"] {
        assert!(members.contains(&format!("\"label\":\"{field}\"")), "{members}");
    }
    let free = complete(&a, "free.", 5);
    assert!(free.contains("\"label\":\"calls\""), "{free}");
    // the member is written before its collection, so completion reads ahead
    let source = r#""" in malloc.calls"#;
    let calls = complete(&a, source, 1);
    assert!(calls.contains("\"label\":\"parse_body\""), "{calls}");
    assert!(calls.contains("\"label\":\"handle\""));
    assert!(!calls.contains("\"label\":\"request\""), "a span is not a call: {calls}");
    assert!(calls.contains(r#""insertText":"\"parse_body\"""#), "{calls}");
    let spans = complete(&a, r#""re" in free.spans"#, 3);
    assert!(spans.contains("\"label\":\"request\""), "{spans}");
    assert!(!spans.contains("\"label\":\"parse\""), "prefix filtered: {spans}");
    let ids = complete(&a, r#""" in malloc.span_ids"#, 1);
    assert!(ids.contains("\"label\":\"r1.p\""), "{ids}");
    // after `"x" in`, both record objects are offered
    let objects = complete(&a, r#""x" in "#, 7);
    assert!(objects.contains("\"label\":\"malloc\"") && objects.contains("\"label\":\"free\""), "{objects}");
}

#[test]
fn context_name_completion_is_bounded() {
    let mut trace = String::from("{\"op\":\"H\",\"v\":2}\n");
    for i in 0..80 {
        trace.push_str(&format!("{{\"op\":\"B\",\"thr\":1,\"name\":\"fn_{i:02}\"}}\n"));
    }
    let a = load(&trace);
    let source = r#""" in malloc.calls"#;
    let out = complete(&a, source, 1);
    assert_eq!(out.matches("\"kind\":\"value\"").count(), 50);
    assert!(out.contains("\"hasMore\":true"));
}

#[test]
fn the_schema_lists_the_context_fields() {
    let mut e = Engine::new();
    e.parse_begin();
    e.parse_chunk(TRACE.as_bytes());
    e.parse_end();
    let schema = e.agent_filter_schema(0, 10);
    let fields = |ns: usize| -> Vec<(String, String)> {
        schema["namespaces"][ns]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["name"].as_str().unwrap().to_string(), f["type"].as_str().unwrap().to_string()))
            .collect()
    };
    for ns in [1, 2] {
        for name in ["calls", "spans", "span_ids"] {
            assert!(
                fields(ns).contains(&(name.to_string(), "string-collection".to_string())),
                "{name} in {}",
                schema["namespaces"][ns]
            );
        }
    }
    assert!(!fields(0).iter().any(|(n, _)| n == "calls"));
}

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
}

/// Random interleavings of calls (with named and implicit closes), spans
/// begun and ended on different threads with random parents, and heap
/// records: the plan's columns and marks must agree with the oracle's
/// definition for every name in every field.
#[test]
fn context_plan_matches_the_oracle_on_random_traces() {
    let names = ["a", "b", "c", "d"];
    let mut hits = [0usize; 4];
    for seed in 1..=16u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let mut text = String::from("{\"op\":\"H\",\"v\":2}\n");
        let (mut next_id, mut live, mut next_span) = (1u64, Vec::new(), 0u32);
        let mut open_spans: Vec<u32> = Vec::new();
        for _ in 0..500 {
            let thr = rng.below(3);
            match rng.below(12) {
                0..=2 => {
                    let name = names[rng.below(4) as usize];
                    text.push_str(&format!("{{\"op\":\"B\",\"thr\":{thr},\"name\":\"{name}\"}}\n"));
                }
                3 => text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr}}}\n")),
                4 => {
                    let name = names[rng.below(4) as usize];
                    text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr},\"name\":\"{name}\"}}\n"));
                }
                5 => {
                    next_span += 1;
                    let name = names[rng.below(4) as usize];
                    let parent = if next_span > 1 && rng.below(3) > 0 {
                        format!(",\"parent\":\"s{}\"", 1 + rng.below(next_span as u64 - 1))
                    } else {
                        String::new()
                    };
                    text.push_str(&format!(
                        "{{\"op\":\"B\",\"thr\":{thr},\"span\":\"s{next_span}\",\"name\":\"{name}\"{parent}}}\n"
                    ));
                    open_spans.push(next_span);
                }
                6 if !open_spans.is_empty() => {
                    let id = open_spans.remove(rng.below(open_spans.len() as u64) as usize);
                    text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr},\"span\":\"s{id}\"}}\n"));
                }
                7 | 8 if !live.is_empty() => {
                    let id: u64 = live.remove(rng.below(live.len() as u64) as usize);
                    text.push_str(&format!("{{\"op\":\"F\",\"thr\":{thr},\"id\":{id}}}\n"));
                }
                _ => {
                    text.push_str(&format!(
                        "{{\"op\":\"M\",\"thr\":{thr},\"id\":{next_id},\"addr\":\"0x{:x}\",\"size\":16}}\n",
                        next_id * 0x100
                    ));
                    live.push(next_id);
                    next_id += 1;
                }
            }
        }
        let a = load(&text);
        for name in names {
            for (k, field) in ["malloc.calls", "malloc.spans", "free.calls", "free.spans"].iter().enumerate() {
                hits[k] += matching(&a, &format!("\"{name}\" in {field}")).len();
            }
            matching(&a, &format!("\"{name}\" in malloc.calls and not \"{name}\" in free.calls"));
        }
        for id in 1..=next_span.min(6) {
            matching(&a, &format!("\"s{id}\" in malloc.span_ids or \"s{id}\" in free.span_ids"));
        }
        matching(&a, "free.span_ids is None");
    }
    // the traces exercise every field, not just the empty answer
    assert!(hits.iter().all(|&n| n > 50), "{hits:?}");
}
