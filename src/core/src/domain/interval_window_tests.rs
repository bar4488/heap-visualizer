//! The interval window (IVL-008) against brute force, the tracks document,
//! and the process-track thread fix.

use serde_json::{json, Value};

use super::interval::*;
use super::interval_window::{culled, extent, Lane};
use crate::store::{Store, NONE_U32};
use crate::Engine;

fn engine(input: &str) -> Engine {
    let mut engine = Engine::new();
    engine.parse_begin();
    engine.parse_chunk(input.as_bytes());
    engine.parse_end();
    engine
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A random v2 trace: nested calls (with named ends that close frames
/// above, and unmatched ends) on three threads, spans begun and ended on
/// any thread, CPU switches, heap records between, and time ties.
fn random_trace(seed: u64, n: usize) -> String {
    let mut r = Rng(seed);
    let mut out = String::from("{\"op\":\"H\",\"v\":2,\"pid\":1}\n");
    let mut t = 0u64;
    let mut stacks: [Vec<String>; 3] = Default::default();
    let mut open_spans: Vec<u32> = Vec::new();
    let mut next_span = 0u32;
    for k in 0..n {
        t += r.below(3); // ties are common
        let thr = r.below(3) as usize;
        match r.below(10) {
            0..=3 => {
                let name = format!("f{}", r.below(6));
                out += &format!("{{\"op\":\"B\",\"t\":{t},\"thr\":{thr},\"name\":\"{name}\"}}\n");
                stacks[thr].push(name);
            }
            4..=5 => {
                if r.below(4) == 0 && !stacks[thr].is_empty() {
                    let at = r.below(stacks[thr].len() as u64) as usize;
                    let name = stacks[thr][at].clone();
                    let at = stacks[thr].iter().rposition(|n| *n == name).unwrap();
                    stacks[thr].truncate(at);
                    out += &format!("{{\"op\":\"X\",\"t\":{t},\"thr\":{thr},\"name\":\"{name}\"}}\n");
                } else {
                    stacks[thr].pop();
                    out += &format!("{{\"op\":\"X\",\"t\":{t},\"thr\":{thr}}}\n");
                }
            }
            6 => {
                let parent = open_spans.last().map(|p| format!(",\"parent\":{p}")).unwrap_or_default();
                out += &format!("{{\"op\":\"B\",\"t\":{t},\"thr\":{thr},\"span\":{next_span},\"name\":\"s\"{parent}}}\n");
                open_spans.push(next_span);
                next_span += 1;
            }
            7 if !open_spans.is_empty() => {
                let id = open_spans.remove(r.below(open_spans.len() as u64) as usize);
                out += &format!("{{\"op\":\"X\",\"t\":{t},\"thr\":{thr},\"span\":{id}}}\n");
            }
            8 => {
                let cpu = r.below(2);
                if r.below(5) == 0 {
                    out += &format!("{{\"op\":\"C\",\"t\":{t},\"cpu\":{cpu}}}\n");
                } else {
                    out += &format!("{{\"op\":\"C\",\"t\":{t},\"cpu\":{cpu},\"thr\":{thr}}}\n");
                }
            }
            _ => out += &format!("{{\"op\":\"M\",\"t\":{t},\"thr\":{thr},\"id\":{k},\"addr\":\"0x{:x}\",\"size\":8}}\n", 0x1000 + k * 16),
        }
    }
    out
}

/// The window by definition: every listed interval overlapping `[lo, hi]`,
/// drawn or culled one at a time.
fn brute(s: &Store, req: &WindowRequest) -> Window {
    let st = &s.dom.intervals;
    let mut lists: Vec<(Vec<u32>, Lane)> = Vec::new();
    let want = |c: u8| req.category.is_none_or(|x| x == c);
    match req.track {
        WindowTrack::Thread(t) => {
            if want(CAT_CALL) {
                lists.push(((0..st.len()).filter(|&i| st.cat[i as usize] == CAT_CALL && st.track[i as usize] == t as u32).collect(), Lane::Call));
            }
            if want(CAT_SPAN) {
                lists.push(((0..st.len()).filter(|&i| st.cat[i as usize] == CAT_SPAN && st.track[i as usize] == t as u32).collect(), Lane::Span));
            }
        }
        WindowTrack::Cpu(c) if want(CAT_SCHED) => {
            lists.push(((0..st.len()).filter(|&i| st.cat[i as usize] == CAT_SCHED && st.track[i as usize] == c as u32).collect(), Lane::Slice));
        }
        _ => {}
    }
    let mut w = Window::default();
    for (list, lane) in lists {
        for i in list {
            let (a, b) = extent(s, st, req.axis, i);
            if a > req.hi || b < req.lo {
                continue;
            }
            if culled(req, a, b) {
                w.culled += 1;
            } else if w.rows.len() == WINDOW_ROWS_MAX {
                w.truncated = true;
                return w;
            } else {
                w.rows.push((i, lane));
            }
        }
    }
    w
}

#[test]
fn the_window_matches_brute_force_on_random_traces() {
    for seed in 1..=6u64 {
        let engine = engine(&random_trace(seed, 3000 + seed as usize * 500));
        let s = &engine.app.store;
        let st = &s.dom.intervals;
        assert!(st.len() > 500);
        let mut r = Rng(seed * 77);
        let mut tracks: Vec<Value> = (0..3).map(|t| json!({ "thr": t, "pid": 1 })).collect();
        tracks.extend((0..2).map(|c| json!({ "cpu": c })));
        let mut drawn = 0;
        for k in 0..200 {
            let axis = if k % 2 == 0 { "seq" } else { "t" };
            let span = if axis == "seq" { s.len() as u64 } else { s.t_max + 1 };
            let a = r.below(span + 20) as f64 - 10.0;
            let b = a + r.below(span / [1, 4, 50, 1000][k % 4] + 1) as f64;
            let width = [1.0, 37.0, 800.0, 4000.0][r.below(4) as usize];
            let category = [Value::Null, json!("call"), json!("span"), json!("sched")][r.below(4) as usize].clone();
            let request = json!({ "track": tracks[k % tracks.len()], "axis": axis, "lo": a, "hi": b, "width": width, "category": category });
            let req = WindowRequest::parse(s, &request).unwrap();
            let got = engine.interval_window(&request).unwrap();
            let want = brute(s, &req);
            assert_eq!(got, want, "seed {seed} request {request}");
            drawn += got.rows.len();
            // calls carry their nesting depth: the calls on the track enclosing them
            let end = |j: u32| if st.end[j as usize] == NONE_U32 { s.len() } else { st.end[j as usize] };
            for &(i, lane) in &got.rows {
                if lane != Lane::Call {
                    continue;
                }
                let enclosing = st.calls[&(st.track[i as usize] as u16)]
                    .iter()
                    .filter(|&&j| st.begin[j as usize] < st.begin[i as usize] && end(j) >= end(i))
                    .count();
                assert_eq!(st.depth[i as usize] as usize, enclosing, "depth of {i}");
            }
        }
        assert!(drawn > 1000, "the windows drew something: {drawn}");
    }
}

#[test]
fn the_window_culls_the_narrow_and_caps_rows() {
    // one long call, never closed, around 30,000 one-record calls
    let mut input = String::from("{\"op\":\"H\",\"v\":2}\n{\"op\":\"B\",\"t\":0,\"thr\":1,\"name\":\"long\"}\n");
    for k in 0..30_000 {
        input += &format!("{{\"op\":\"B\",\"t\":{},\"thr\":1,\"name\":\"tiny\"}}\n{{\"op\":\"X\",\"t\":{},\"thr\":1}}\n", 2 * k, 2 * k + 1);
    }
    let mut engine = engine(&input);
    let n = engine.len() as f64;
    // zoomed out: every tiny call is under half a pixel; the open one is drawn
    let w: Value = serde_json::from_str(&engine.interval_window_json(&json!({
        "track": { "thr": 1 }, "axis": "seq", "lo": 0, "hi": n, "width": 1000
    }).to_string())).unwrap();
    assert_eq!(w["culled"], 30_000);
    assert_eq!(w["truncated"], false);
    let rows = w["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "long");
    assert_eq!(rows[0]["open"], true);
    assert_eq!(rows[0]["end"], n as u64, "an open interval ends at the trace end");
    assert_eq!(rows[0]["lane"], "call");
    assert_eq!(rows[0]["depth"], 0);
    // zoomed in far enough that every call is wide: the cap holds
    let w = engine
        .interval_window(&json!({ "track": { "thr": 1 }, "axis": "t", "lo": 0, "hi": 60_000, "width": 1e9 }))
        .unwrap();
    assert_eq!(w.rows.len(), WINDOW_ROWS_MAX);
    assert!(w.truncated);
}

#[test]
fn window_requests_are_validated() {
    let mut engine = engine("{\"op\":\"H\",\"v\":2}\n{\"op\":\"C\",\"t\":1,\"cpu\":0,\"thr\":1}\n{\"op\":\"C\",\"t\":5,\"cpu\":0}\n{\"op\":\"E\",\"t\":9,\"title\":\"end\"}\n");
    let window = |e: &mut Engine, v: Value| -> Value { serde_json::from_str(&e.interval_window_json(&v.to_string())).unwrap() };
    let ok = window(&mut engine, json!({ "track": { "cpu": 0 }, "axis": "t", "lo": 0, "hi": 10, "width": 100 }));
    let rows = ok["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0]["thr"].clone(), rows[0]["idle"].clone(), rows[0]["lane"].clone()), (json!(1), json!(false), json!("slice")));
    assert_eq!((rows[1]["name"].clone(), rows[1]["idle"].clone(), rows[1]["thr"].clone()), (json!("idle"), json!(true), Value::Null));
    assert_eq!((rows[0]["seq"].clone(), rows[1]["seq"].clone()), (json!(0), json!(1)), "the begin edge's seq");
    assert_eq!(rows[0]["start"], 1.0);
    assert_eq!(rows[0]["end"], 5.0);
    for bad in [
        json!({ "track": { "cpu": 0 }, "axis": "t", "lo": 0, "hi": 10, "width": 100, "zoom": 2 }),
        json!({ "track": { "cpu": 0 }, "axis": "x", "lo": 0, "hi": 10, "width": 100 }),
        json!({ "track": { "cpu": 0 }, "axis": "t", "lo": 10, "hi": 0, "width": 100 }),
        json!({ "track": { "cpu": 0 }, "axis": "t", "lo": 0, "hi": 10, "width": 0 }),
        json!({ "track": {}, "axis": "t", "lo": 0, "hi": 10, "width": 10 }),
        json!({ "track": { "cpu": 0 }, "axis": "t", "lo": 0, "hi": 10, "width": 10, "category": "heap" }),
    ] {
        let v = window(&mut engine, bad.clone());
        assert!(v["error"].is_string(), "{bad} → {v}");
        assert_eq!(v["rows"], json!([]));
    }
    // a track the trace does not have is an empty window, not an error
    let none = window(&mut engine, json!({ "track": { "thr": 9 }, "axis": "seq", "lo": 0, "hi": 10, "width": 10 }));
    assert_eq!(none, json!({ "rows": [], "culled": 0, "truncated": false }));
}

#[test]
fn tracks_list_threads_with_calls_or_spans_and_cpus() {
    let mut engine = engine(
        r#"{"op":"H","v":2,"pid":7}
{"op":"T","pid":7,"thr":1,"name":"main"}
{"op":"B","t":1,"thr":1,"name":"a"}
{"op":"B","t":2,"thr":2,"span":"s","name":"req"}
{"op":"X","t":3,"thr":1}
{"op":"C","t":4,"cpu":3,"thr":1}
"#,
    );
    let v: Value = serde_json::from_str(&engine.tracks_json()).unwrap();
    assert_eq!(
        v,
        json!({
            "threads": [
                { "thr": 1, "pid": 7, "name": "main", "calls": 1, "spans": 0 },
                { "thr": 2, "pid": 7, "name": "thread 2", "calls": 0, "spans": 1 },
            ],
            "cpus": [{ "cpu": 3, "slices": 1 }],
        })
    );
    let domains: Value = serde_json::from_str(&engine.domains_json()).unwrap();
    assert_eq!(domains[3]["tracks"], v, "the descriptor's tracks are the same document");
    let w: Value = serde_json::from_str(&engine.interval_window_json(r#"{"track":{"thr":2,"pid":7},"axis":"seq","lo":0,"hi":4,"width":100}"#)).unwrap();
    assert_eq!(
        w,
        json!({ "rows": [{ "ivl": 1, "name": "req", "category": "span", "lane": "span", "depth": 0, "seq": 1, "start": 1, "end": 4,
                           "open": true, "thr": 2, "pid": 7, "span": "s" }], "culled": 0, "truncated": false })
    );
}

/// A record on a process track (`pid` without `thr`) has no thread: the
/// filter reads `malloc.thread` as None and the address map's label as
/// null, not the track's placeholder 0.
#[test]
fn a_process_track_has_no_thread() {
    let mut engine = engine(
        r#"{"op":"H","v":2}
{"op":"M","t":1,"pid":7,"id":1,"addr":"0x1000","size":8}
{"op":"M","t":2,"pid":7,"thr":0,"id":2,"addr":"0x2000","size":8}
"#,
    );
    let ids = |e: &Engine, q: &str| -> Vec<String> {
        e.agent_query(q, "creator-asc", 0, 10).unwrap()["items"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(ids(&engine, "malloc.thread is None"), ["1"]);
    assert_eq!(ids(&engine, "malloc.thread == 0"), ["2"]);
    assert_eq!(ids(&engine, "malloc.thread in {0, 3}"), ["2"]);
    let a = &mut engine.app;
    let info: Value = serde_json::from_str(&crate::render::alloc_info(&a.store, &mut a.view, &a.cfg, 200, 0x1000, 0, 0.0)).unwrap();
    assert_eq!(info["thr"], Value::Null);
    let info: Value = serde_json::from_str(&crate::render::alloc_info(&a.store, &mut a.view, &a.cfg, 200, 0x2000, 1, 0.0)).unwrap();
    assert_eq!(info["thr"], 0);
}

#[test]
fn browser_queries_reject_parameters_the_domain_does_not_have() {
    let mut engine = engine("{\"op\":\"H\",\"v\":2}\n{\"op\":\"L\",\"t\":1,\"level\":\"info\",\"msg\":\"hi\"}\n");
    for (request, ok) in [
        (json!({ "domain": "logs", "minLevel": 1, "text": "", "from": 0, "count": 5 }), true),
        (json!({ "domain": "logs", "category": "call" }), false),
        (json!({ "domain": "heap", "text": "x" }), false),
        (json!({ "domain": "intervals", "thr": 1, "minDur": 3 }), true),
        (json!({ "domain": "intervals", "minLevel": 1 }), false),
    ] {
        let q: Value = serde_json::from_str(&engine.domain_query_json(&request.to_string())).unwrap();
        let l: Value = serde_json::from_str(&engine.domain_locate_json(&request.to_string())).unwrap();
        assert_eq!(q.get("error").is_none(), ok, "{request} → {q}");
        assert_eq!(l.get("error").is_none(), ok, "{request} → {l}");
        if !ok {
            assert!(q["error"].as_str().unwrap().starts_with("unknown parameter"));
        }
    }
    // the query parameters are the descriptor's
    let domains: Value = serde_json::from_str(&engine.domains_json()).unwrap();
    for (k, d) in super::all(&engine.app.store).enumerate() {
        let names: Vec<&str> = domains[k]["query"]["params"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, d.query_params(), "{}", d.name());
    }
}

#[test]
fn stream_context_counts_or_includes_interval_edges() {
    let engine = engine(
        r#"{"op":"H","v":2}
{"op":"M","t":1,"thr":1,"id":1,"addr":"0x1000","size":8}
{"op":"B","t":2,"thr":1,"name":"work"}
{"op":"X","t":3,"thr":1}
{"op":"F","t":4,"thr":1,"id":1}
"#,
    );
    let quiet = engine.agent_stream_context("", 1, 1, 2, true).unwrap();
    assert_eq!(quiet["events"].as_array().unwrap().len(), 2);
    assert_eq!(quiet["omitted"], json!({ "intervals": 2 }));
    let include = crate::agent::ContextInclude { intervals: true, ..Default::default() };
    let full = engine.agent_stream_context_with("", 1, 1, 2, include).unwrap();
    let ops: Vec<&str> = full["events"].as_array().unwrap().iter().map(|e| e["operation"].as_str().unwrap()).collect();
    assert_eq!(ops, ["malloc", "begin", "end", "free"]);
    assert_eq!(full["events"][1]["title"], "→ work");
    assert_eq!(full["events"][1]["category"], "call");
    assert_eq!(full["events"][2]["interval"]["name"], "work");
    assert!(full.get("omitted").is_none());
}
