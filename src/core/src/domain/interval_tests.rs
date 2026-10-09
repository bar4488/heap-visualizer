use std::collections::HashMap;

use serde_json::Value;

use super::interval::*;
use super::*;
use crate::Engine;

fn engine(input: &str) -> Engine {
    let mut engine = Engine::new();
    engine.parse_begin();
    engine.parse_chunk(input.as_bytes());
    engine.parse_end();
    engine
}

const V2: &str = "{\"op\":\"H\",\"v\":2}\n";

/// E023's worked example, minus the user kinds (out of scope: `E` with
/// `kind` stays a landmark).
const EXAMPLE: &str = r#"{"op":"H","v":2,"unit":"ns","title":"upload","pid":7}
{"op":"T","pid":7,"name":"api-server"}
{"op":"T","pid":7,"thr":1,"name":"main"}
{"op":"T","pid":7,"thr":2,"name":"worker"}
{"op":"C","t":1000,"cpu":0,"thr":1}
{"op":"C","t":1000,"cpu":1,"thr":2}
{"op":"B","t":1100,"thr":1,"name":"main"}
{"op":"B","t":1200,"thr":1,"span":"r42","name":"request","route":"/upload"}
{"op":"B","t":1250,"thr":1,"name":"handle_upload"}
{"op":"M","t":1300,"thr":1,"id":1,"addr":"0x7f0000001000","size":4096,"site":"read_body"}
{"op":"L","t":1350,"thr":1,"level":"info","logger":"http","msg":"body read","bytes":4096}
{"op":"B","t":1400,"thr":2,"span":"r42.parse","parent":"r42","name":"parse"}
{"op":"M","t":1450,"thr":2,"id":2,"addr":"0x7f0000003000","size":256,"site":"json_node"}
{"op":"E","t":1500,"thr":2,"kind":"cache_miss","key":"user:9"}
{"op":"C","t":1550,"cpu":1,"state":"S"}
{"op":"E","t":1600,"kind":"gc","ph":"B","phase":"mark"}
{"op":"F","t":1650,"thr":1,"id":1}
{"op":"E","t":1700,"kind":"gc","ph":"X","freed":4096}
{"op":"C","t":1720,"cpu":1,"thr":2}
{"op":"X","t":1750,"thr":2,"span":"r42.parse","status":"ok"}
{"op":"L","t":1800,"thr":1,"level":"warn","logger":"http","msg":"slow request","ms":0.7}
{"op":"X","t":1850,"thr":1,"name":"handle_upload"}
{"op":"X","t":1900,"thr":1,"span":"r42"}
{"op":"E","t":1950,"title":"frame end"}
"#;

fn names(st: &IntervalStore, list: &[u32]) -> Vec<String> {
    list.iter().map(|&i| st.name_of(i).unwrap_or("-").to_string()).collect()
}

#[test]
fn the_e023_example_reads_as_specified() {
    let engine = engine(EXAMPLE);
    let s = &engine.app.store;
    assert!(s.v2);
    assert_eq!(s.len(), 20, "T is off the spine");
    assert_eq!(s.warn_counts[W_VERSION as usize], 0, "v 2 raises no warning");
    let st = &s.dom.intervals;
    assert_eq!(st.edges.len(), 11);
    assert_eq!(st.by_cat, [4, 2, 2]);
    // record 12 applied
    let state = engine.domain_state("intervals", 13).unwrap();
    let threads = state["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 1, "thread 2 has no call frames: {state}");
    assert_eq!(threads[0]["name"], "main");
    assert_eq!(threads[0]["pid"], 7);
    let stack: Vec<&str> = threads[0]["stack"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(stack, ["main", "handle_upload"]);
    let spans: Vec<(&str, Option<&str>)> = state["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v["span"].as_str().unwrap(), v["parentSpan"].as_str()))
        .collect();
    assert_eq!(spans, [("r42", None), ("r42.parse", Some("r42"))]);
    assert_eq!(state["spans"][1]["thr"], 2);
    assert_eq!(state["cpus"][0]["state"], "running");
    assert_eq!(state["cpus"][0]["since"], 0);
    assert_eq!(state["cpus"][0]["name"], "main");
    assert_eq!(state["cpus"][1]["state"], "idle");
    assert_eq!(state["cpus"][1]["since"], 10);
    // `main` is the one unclosed interval; open run slices raise nothing
    assert_eq!(s.warn_counts[W_UNCLOSED as usize], 1);
    let w = s.warnings.iter().find(|w| w.code == W_UNCLOSED).unwrap();
    assert_eq!(w.seq, 2);
    // the end fields of the closed slice carry the outgoing state
    let slice = st.cpus[&1][0];
    assert_eq!(st.end[slice as usize], 10);
    let v = view(s).interval_value(slice, true);
    assert_eq!(v["endFields"]["state"], "S");
    // track names come from `T`
    assert_eq!(s.track_name(s.thr_idx[0]), Some("main"));
    // the heap reads the same records as ever
    assert_eq!(s.heap_len(), 3);
}

#[test]
fn calls_pair_lifo_and_named_ends_close_frames_above() {
    let engine = engine(&format!(
        "{V2}{}",
        concat!(
            r#"{"op":"B","thr":1,"name":"a"}"#, "\n", // 0
            r#"{"op":"B","thr":1,"name":"b"}"#, "\n", // 1
            r#"{"op":"X","thr":1}"#, "\n",            // 2 closes b
            r#"{"op":"B","thr":1,"name":"c"}"#, "\n", // 3
            r#"{"op":"B","thr":1,"name":"d"}"#, "\n", // 4
            r#"{"op":"B","thr":1,"name":"e"}"#, "\n", // 5
            r#"{"op":"X","thr":1,"name":"c"}"#, "\n", // 6 closes e, d implicitly, then c
            r#"{"op":"X","thr":1,"name":"zz"}"#, "\n",// 7 unmatched
            r#"{"op":"X","thr":1}"#, "\n",            // 8 closes a
            r#"{"op":"X","thr":1}"#, "\n",            // 9 unmatched: empty
            r#"{"op":"B","thr":2,"name":"other"}"#, "\n", // 10
        )
    ));
    let s = &engine.app.store;
    let st = &s.dom.intervals;
    let ends: Vec<(String, u32, u16)> = (0..st.len())
        .map(|i| (st.name_of(i).unwrap().to_string(), st.end[i as usize], st.depth[i as usize]))
        .collect();
    assert_eq!(
        ends,
        [
            ("a".into(), 8, 0),
            ("b".into(), 2, 1),
            ("c".into(), 6, 1),
            ("d".into(), 6, 2),
            ("e".into(), 6, 3),
            ("other".into(), NONE_U32, 0)
        ]
    );
    assert_eq!(st.parent[4], 3, "e's parent is d");
    assert!(st.flags[4] & FLAG_IMPLICIT != 0 && st.flags[2] & FLAG_IMPLICIT == 0);
    assert_eq!(s.warn_counts[W_IMPLICIT_CLOSE as usize], 2);
    assert_eq!(s.warn_counts[W_UNMATCHED_END as usize], 2);
    assert_eq!(s.warn_counts[W_UNCLOSED as usize], 1);
    // unmatched edges stay on the spine
    assert_eq!(s.len(), 11);
    assert_eq!(st.edge_close[7], NONE_U32);
    let t1 = s.thr_idx[0];
    assert_eq!(names(st, &st.stack_at(t1, 6)), ["a", "c", "d", "e"]);
    assert_eq!(names(st, &st.stack_at(t1, 7)), ["a"]);
    assert!(st.stack_at(t1, 9).is_empty());
    // titles and kinds on the generic surface
    let d = get(s, INTERVALS).unwrap();
    let titles: Vec<String> = (0..3).map(|r| d.summary(r).title.unwrap()).collect();
    assert_eq!(titles, ["→ a", "→ b", "← b"]);
    assert_eq!(d.summary(2).kind, "end");
}

#[test]
fn the_call_depth_limit_keeps_pairing_correct() {
    let mut t = String::from(V2);
    t.push_str("{\"op\":\"B\",\"thr\":1,\"name\":\"root\"}\n");
    for _ in 0..DEPTH_MAX + 4 {
        t.push_str("{\"op\":\"B\",\"thr\":1,\"name\":\"r\"}\n");
    }
    for _ in 0..DEPTH_MAX + 4 {
        t.push_str("{\"op\":\"X\",\"thr\":1}\n");
    }
    let engine = engine(&t);
    let s = &engine.app.store;
    let st = &s.dom.intervals;
    assert_eq!(st.len() as usize, DEPTH_MAX);
    assert_eq!(s.warn_counts[W_DEPTH_LIMIT as usize], 1);
    assert_eq!(s.warn_counts[W_UNMATCHED_END as usize], 0);
    // root is still open: the overflowed begins absorbed their ends
    assert_eq!(st.end[0], NONE_U32);
    assert_eq!(names(st, &st.stack_at(s.thr_idx[0], s.len())), ["root"]);
}

#[test]
fn spans_pair_by_id_across_threads_with_parents() {
    let engine = engine(&format!(
        "{V2}{}",
        concat!(
            r#"{"op":"B","thr":1,"span":"p","name":"parent"}"#, "\n",           // 0
            r#"{"op":"B","thr":2,"span":7,"parent":"p","name":"child"}"#, "\n", // 1
            r#"{"op":"X","thr":3,"span":"p"}"#, "\n",                          // 2 parent ends first
            r#"{"op":"B","thr":2,"span":"q","parent":"p"}"#, "\n",             // 3 closed parent still resolves
            r#"{"op":"B","thr":2,"span":"q"}"#, "\n",                          // 4 duplicate
            r#"{"op":"B","thr":2,"span":"r","parent":"nope"}"#, "\n",          // 5 unknown parent
            r#"{"op":"X","thr":2,"span":"q"}"#, "\n",                          // 6
            r#"{"op":"X","thr":2,"span":"q"}"#, "\n",                          // 7 unmatched
            r#"{"op":"B","thr":1,"span":"q"}"#, "\n",                          // 8 reuse after close
            r#"{"op":"X","thr":1,"span":7}"#, "\n",                            // 9
            r#"{"op":"X","thr":1,"span":"q"}"#, "\n",                          // 10
            r#"{"op":"X","thr":1,"span":"r"}"#, "\n",                          // 11
        )
    ));
    let s = &engine.app.store;
    let st = &s.dom.intervals;
    let spans: Vec<(&str, u32, u32, u16)> = (0..st.len())
        .map(|i| (st.span_id(i).unwrap(), st.end[i as usize], st.parent[i as usize], st.depth[i as usize]))
        .collect();
    assert_eq!(spans, [("p", 2, NONE_U32, 0), ("7", 9, 0, 1), ("q", 6, 0, 1), ("r", 11, NONE_U32, 0), ("q", 10, NONE_U32, 0)]);
    assert_eq!(st.calls.len(), 0, "spans are not call frames");
    assert_eq!(s.warn_counts[W_DUP_SPAN as usize], 1);
    assert_eq!(s.warn_counts[W_UNKNOWN_PARENT as usize], 1);
    assert_eq!(s.warn_counts[W_UNMATCHED_END as usize], 1);
    assert_eq!(s.warn_counts[W_UNCLOSED as usize], 0);
    // the child outlives its parent
    assert_eq!(st.open_spans_at(3), [1]);
    // the child ended on thread 1: a thread-1 query finds it
    let q = IntervalQuery { track: Some(TrackSel::Thread(s.thr_idx[9])), ..Default::default() };
    assert_eq!(q.run(s), [0, 1, 3, 4]);
}

#[test]
fn context_switches_become_per_cpu_run_slices() {
    let engine = engine(&format!(
        "{V2}{}",
        concat!(
            r#"{"op":"M","id":1,"addr":"0x10","size":4}"#, "\n", // 0
            r#"{"op":"C","t":10,"cpu":0,"thr":1}"#, "\n",       // 1
            r#"{"op":"C","t":20,"cpu":0,"thr":2}"#, "\n",       // 2
            r#"{"op":"C","t":30,"cpu":1,"thr":2}"#, "\n",       // 3 double run
            r#"{"op":"C","t":40,"cpu":0,"state":"S"}"#, "\n",   // 4 idle
            r#"{"op":"C","t":50,"cpu":1,"thr":1}"#, "\n",       // 5
            r#"{"op":"C","t":60,"thr":1}"#, "\n",               // dropped: no cpu
            r#"{"op":"C","t":60,"cpu":4096,"thr":1}"#, "\n",    // dropped: cpu out of range
        )
    ));
    let s = &engine.app.store;
    let st = &s.dom.intervals;
    assert_eq!(s.len(), 6);
    assert_eq!(s.warn_counts[W_MALFORMED as usize], 2);
    assert_eq!(s.warn_counts[W_DOUBLE_RUN as usize], 1);
    assert_eq!(s.warn_counts[W_UNCLOSED as usize], 0, "open slices are normal");
    let slices: Vec<(u32, u32, u32)> = (0..st.len()).map(|i| (st.track[i as usize], st.begin[i as usize], st.end[i as usize])).collect();
    assert_eq!(slices, [(0, 1, 2), (0, 2, 4), (1, 3, 5), (0, 4, NONE_U32), (1, 5, NONE_U32)]);
    assert!(st.flags[2] & FLAG_DOUBLE_RUN != 0 && st.flags[3] & FLAG_IDLE != 0);
    assert_eq!(st.cpu_at(1, 3), None, "unknown before the CPU's first switch");
    assert_eq!(st.cpu_at(0, 3), Some(1));
    assert_eq!(st.cpu_at(0, 6), Some(3));
    assert_eq!(duration(s, 0), 10);
    assert_eq!(duration(s, 3), 10, "open slices extend to the trace end");
    let state = engine.domain_state("intervals", 4).unwrap();
    assert_eq!(state["cpus"][1]["state"], "running");
    assert_eq!(state["cpus"][1]["thr"], 2);
    // a thread query includes the slices the thread ran in
    let q = IntervalQuery { track: Some(TrackSel::Thread(s.thr_idx[2])), ..Default::default() };
    assert_eq!(q.run(s), [1, 2]);
    let q = IntervalQuery { track: Some(TrackSel::Cpu(1)), min_dur: 20, ..Default::default() };
    assert_eq!(q.run(s), [2]);
}

#[test]
fn processes_scope_threads() {
    let engine = engine(&format!(
        "{V2}{}",
        concat!(
            r#"{"op":"B","pid":1,"thr":1,"name":"a"}"#, "\n",
            r#"{"op":"B","pid":2,"thr":1,"name":"b"}"#, "\n",
            r#"{"op":"X","pid":1,"thr":1,"name":"a"}"#, "\n",
            r#"{"op":"B","pid":2,"name":"proc"}"#, "\n",
            r#"{"op":"L","pid":2,"thr":1,"msg":"m"}"#, "\n",
        )
    ));
    let s = &engine.app.store;
    let st = &s.dom.intervals;
    assert_eq!(s.warn_counts[W_IMPLICIT_CLOSE as usize], 0, "thr 1 of two processes are two threads");
    assert_eq!(st.end[1], NONE_U32);
    assert_eq!(s.thrs.len(), 3);
    assert_eq!(s.thr_idx[4], s.thr_idx[1], "a log on (2, 1) shares its track");
    assert_eq!(s.track_thr(s.thr_idx[3]), None, "a process track has no thr");
    assert_eq!(s.track_pid_of(s.thr_idx[3]), Some(2));
    let mut out = String::new();
    get(s, LOGS).unwrap().record_json(0, &mut out);
    assert!(out.contains("\"thr\":1"), "{out}");
    assert!(engine.agent_domain_records("logs", &RecordParams::default()).unwrap()["items"][0].get("fields").unwrap()["pid"].is_null());
}

/// v2 records in a v1 trace are skipped as unknown ops, and the v2 keys are
/// custom fields: the store is the one the same file loads to without them.
#[test]
fn v1_traces_are_unchanged() {
    let records = concat!(
        r#"{"op":"M","t":1,"id":1,"addr":"0x10","size":4,"pid":3,"name":"x"}"#, "\n",
        r#"{"op":"B","t":2,"thr":1,"name":"f","span":{"bad":1}}"#, "\n",
        r#"{"op":"T","pid":7,"name":"p"}"#, "\n",
        r#"{"op":"C","t":3,"cpu":"nope"}"#, "\n",
        r#"{"op":"L","t":4,"pid":"x","msg":"m"}"#, "\n",
        r#"{"op":"X","t":5,"thr":1}"#, "\n",
        r#"{"op":"F","t":6,"id":1}"#, "\n",
    );
    let plain = concat!(
        r#"{"op":"M","t":1,"id":1,"addr":"0x10","size":4,"pid":3,"name":"x"}"#, "\n",
        r#"{"op":"L","t":4,"pid":"x","msg":"m"}"#, "\n",
        r#"{"op":"F","t":6,"id":1}"#, "\n",
    );
    for header in ["", "{\"op\":\"H\",\"v\":1}\n", "{\"op\":\"M\",\"id\":9,\"addr\":\"0x900\",\"size\":1}\n{\"op\":\"H\",\"v\":2}\n"] {
        let a = engine(&format!("{header}{records}"));
        let b = engine(&format!("{header}{plain}"));
        let (a, b) = (&a.app.store, &b.app.store);
        assert!(!a.v2);
        assert_eq!(a.op, b.op);
        assert_eq!(a.t, b.t);
        assert_eq!(a.warn_counts, b.warn_counts);
        assert_eq!(a.fields, b.fields);
        assert_eq!(a.extras, b.extras);
        assert!(a.dom.intervals.edges.is_empty() && a.track_pid.is_empty() && a.track_names.is_empty());
        assert!(a.fields.iter().any(|f| f.name == "pid"), "pid is a custom field in v1");
    }
    // a late v2 header is flagged, as before
    let late = engine(&format!("{{\"op\":\"M\",\"id\":9,\"addr\":\"0x900\",\"size\":1}}\n{V2}"));
    assert_eq!(late.app.store.warn_counts[W_VERSION as usize], 1);
    let future = engine("{\"op\":\"H\",\"v\":3}\n{\"op\":\"B\",\"thr\":1,\"name\":\"f\"}\n");
    assert!(future.app.store.v2, "v > 2 reads as v2");
    assert_eq!(future.app.store.warn_counts[W_VERSION as usize], 1);
}

/// Malformed v2 edges are dropped; long names are cut.
#[test]
fn edge_shapes_are_checked() {
    let long = "n".repeat(NAME_MAX + 10);
    let engine = engine(&format!(
        "{V2}{}{{\"op\":\"B\",\"thr\":1,\"name\":\"{long}\"}}\n{{\"op\":\"B\",\"thr\":1,\"span\":\"{}\"}}\n{{\"op\":\"T\",\"thr\":1,\"name\":5}}\n",
        concat!(
            r#"{"op":"B","thr":1,"name":3}"#, "\n",
            r#"{"op":"B","thr":1,"span":true}"#, "\n",
            r#"{"op":"X","thr":1,"span":"a","parent":5}"#, "\n",
        ),
        "s".repeat(SPAN_ID_MAX + 1),
    ));
    let s = &engine.app.store;
    assert_eq!(s.len(), 2, "a bad name or span drops the line; an X's parent is a custom field");
    assert_eq!(s.warn_counts[W_MALFORMED as usize], 3);
    assert_eq!(s.warn_counts[W_LONG_FIELD as usize], 1);
    assert_eq!(s.dom.intervals.name_of(0).unwrap().len(), NAME_MAX);
    assert!(s.track_names.is_empty(), "a T without a string name is dropped silently");
}

/// DOM-002: interval records never touch the heap.
#[test]
fn the_heap_live_set_ignores_interval_records() {
    let heap = concat!(
        r#"{"op":"M","t":1,"thr":1,"id":1,"addr":"0x10","size":4}"#, "\n",
        r#"{"op":"M","t":2,"thr":1,"id":2,"addr":"0x20","size":8}"#, "\n",
        r#"{"op":"F","t":3,"thr":1,"id":1}"#, "\n",
        r#"{"op":"R","t":4,"thr":1,"old_id":2,"id":3,"addr":"0x40","size":16}"#, "\n",
        r#"{"op":"F","t":5,"thr":1,"id":3}"#, "\n",
    );
    let mut mixed = String::from(V2);
    for (k, line) in heap.lines().enumerate() {
        mixed.push_str(&format!("{{\"op\":\"B\",\"thr\":1,\"name\":\"f{k}\"}}\n"));
        mixed.push_str(&format!("{{\"op\":\"C\",\"cpu\":0,\"thr\":{k}}}\n"));
        mixed.push_str(line);
        mixed.push('\n');
        mixed.push_str(&format!("{{\"op\":\"B\",\"thr\":2,\"span\":{k}}}\n"));
        if k % 2 == 0 {
            mixed.push_str("{\"op\":\"X\",\"thr\":1}\n");
        }
    }
    let mut a = engine(&mixed);
    let mut b = engine(&format!("{V2}{heap}"));
    assert_eq!(a.app.store.heap_len(), 5);
    for applied in 0..=a.app.store.len() {
        let heap_applied = a.app.store.heap_rank(applied);
        a.app.view.seek(&a.app.store, applied);
        b.app.view.seek(&b.app.store, heap_applied);
        assert_eq!(a.app.view.live_count, b.app.view.live_count, "applied {applied}");
        assert_eq!(a.app.view.live_bytes, b.app.view.live_bytes, "applied {applied}");
    }
}

#[test]
fn the_registry_serves_intervals() {
    let mut engine = engine(EXAMPLE);
    let s = &engine.app.store;
    // every spine record still has exactly one domain
    let mut seen = vec![false; s.len() as usize];
    for d in all(s) {
        for row in 0..d.count() {
            let seq = d.seq_of(row);
            assert_eq!(d.row_of(seq), Some(row));
            assert_eq!(s.domain_of(seq), d.id());
            assert!(!std::mem::replace(&mut seen[seq as usize], true));
        }
    }
    assert!(seen.iter().all(|&b| b));
    let v: Value = serde_json::from_str(&engine.record_json(7)).unwrap();
    assert_eq!((v["domain"].as_str(), v["kind"].as_str(), v["title"].as_str()), (Some("intervals"), Some("begin"), Some("→ parse")));
    assert_eq!((v["source"].as_str(), v["pid"].as_u64()), (Some("span"), Some(7)));
    let v: Value = serde_json::from_str(&engine.record_json(10)).unwrap();
    assert_eq!(v["title"], "cpu 1 idle");
    let v: Value = serde_json::from_str(&engine.record_json(0)).unwrap();
    assert_eq!(v["title"], "cpu 0 ⇐ main");

    let all: Value = serde_json::from_str(&engine.domains_json()).unwrap();
    let d = &all[3];
    assert_eq!((d["id"].as_str(), d["shape"].as_str(), d["intervals"].as_u64()), (Some("intervals"), Some("interval"), Some(8)));
    assert_eq!(d["tracks"]["threads"][0]["name"], "main");
    assert_eq!(d["lanes"][0]["id"], "intervals.activity");
    assert!(d["fields"].as_array().unwrap().iter().any(|f| f["name"] == "route"));
    let lanes: Value = serde_json::from_str(&engine.lanes_json()).unwrap();
    assert_eq!(lanes.as_array().unwrap().len(), 2, "logs and intervals");

    let q: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"intervals","text":"PARSE"}"#)).unwrap();
    assert_eq!(q["total"], 1);
    assert_eq!(q["rows"][0]["span"], "r42.parse");
    assert_eq!(q["rows"][0]["endThr"], 2);
    let q: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"intervals","category":"call","thr":1,"minDur":700}"#)).unwrap();
    assert_eq!(q["total"], 1, "{q}");
    assert_eq!((q["rows"][0]["name"].as_str(), q["rows"][0]["open"].as_bool()), (Some("main"), Some(true)));
    let q: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"intervals","seqLo":16,"seqHi":17,"category":"call"}"#)).unwrap();
    assert_eq!(q["total"], 2, "overlapping the range: main and handle_upload");
    assert_eq!(engine.domain_locate_json(r#"{"domain":"intervals","seq":7}"#), r#"{"row":5,"total":8}"#);
    let q: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"intervals","thr":99}"#)).unwrap();
    assert_eq!(q["total"], 0);

    let state: Value = serde_json::from_str(&engine.domain_state_json(r#"{"domain":"intervals","seq":13}"#)).unwrap();
    assert_eq!(state["spans"].as_array().unwrap().len(), 2);
    assert_eq!(engine.domain_state_json(r#"{"domain":"heap","seq":3}"#), "null");
    assert!(engine.domain_state_json(r#"{"domain":"nope"}"#).contains("error"));
    let mut p = RecordParams::default();
    p.params.insert("cpu".into(), "1".into());
    let page = engine.agent_domain_records("intervals", &p).unwrap();
    assert_eq!(page["total"], 3);
    assert_eq!(page["items"][1]["idle"], true);
    assert_eq!(page["items"][0]["t"], "1000");
    p.params.insert("category".into(), "nope".into());
    assert!(engine.agent_domain_records("intervals", &p).is_err());
    let mut hover = String::new();
    get(&engine.app.store, INTERVALS).unwrap().lane_hover(0, 20, &mut hover);
    assert_eq!(hover, r#","intervals":{"count":11,"byCategory":[4,3,4]}"#);
}

// ------------------------------------------------- random traces vs replay

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x % n
    }
}

/// The spec's semantics by replay: per-track stacks of names, open spans by
/// id, the running thread per CPU — the oracle `state_at` must agree with
/// at every playhead.
#[derive(Default, Clone)]
struct Replay {
    stacks: HashMap<i64, Vec<String>>,
    spans: Vec<String>,
    cpus: HashMap<u64, Option<i64>>,
}

#[test]
fn state_at_matches_a_replay_oracle_on_random_traces() {
    for seed in 1..=12u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let mut text = String::from(V2);
        let mut oracle = Replay::default();
        let mut states = vec![oracle.clone()];
        let names = ["a", "b", "c", "d"];
        let mut next_span = 0u32;
        for _ in 0..400 {
            let thr = rng.below(3) as i64;
            match rng.below(10) {
                0..=2 => {
                    let name = names[rng.below(4) as usize];
                    text.push_str(&format!("{{\"op\":\"B\",\"thr\":{thr},\"name\":\"{name}\"}}\n"));
                    oracle.stacks.entry(thr).or_default().push(name.into());
                }
                3 | 4 => {
                    let stack = oracle.stacks.entry(thr).or_default();
                    if rng.below(2) == 0 {
                        text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr}}}\n"));
                        stack.pop();
                    } else {
                        let name = names[rng.below(4) as usize];
                        text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr},\"name\":\"{name}\"}}\n"));
                        if let Some(at) = stack.iter().rposition(|n| n == name) {
                            stack.truncate(at);
                        }
                    }
                }
                5 | 6 => {
                    let id = if !oracle.spans.is_empty() && rng.below(4) == 0 {
                        oracle.spans[rng.below(oracle.spans.len() as u64) as usize].clone() // duplicate
                    } else {
                        next_span += 1;
                        format!("s{next_span}")
                    };
                    let parent = if next_span > 1 { format!(",\"parent\":\"s{}\"", 1 + rng.below(next_span as u64)) } else { String::new() };
                    text.push_str(&format!("{{\"op\":\"B\",\"thr\":{thr},\"span\":\"{id}\"{parent}}}\n"));
                    if !oracle.spans.contains(&id) {
                        oracle.spans.push(id);
                    }
                }
                7 => {
                    let id = format!("s{}", 1 + rng.below(next_span.max(1) as u64));
                    text.push_str(&format!("{{\"op\":\"X\",\"thr\":{thr},\"span\":\"{id}\"}}\n"));
                    oracle.spans.retain(|s| *s != id);
                }
                _ => {
                    let cpu = rng.below(2);
                    if rng.below(4) == 0 {
                        text.push_str(&format!("{{\"op\":\"C\",\"cpu\":{cpu}}}\n"));
                        oracle.cpus.insert(cpu, None);
                    } else {
                        text.push_str(&format!("{{\"op\":\"C\",\"cpu\":{cpu},\"thr\":{thr}}}\n"));
                        oracle.cpus.insert(cpu, Some(thr));
                    }
                }
            }
            states.push(oracle.clone());
        }
        let engine = engine(&text);
        let s = &engine.app.store;
        let st = &s.dom.intervals;
        assert_eq!(s.len(), 400);
        for (applied, want) in states.iter().enumerate() {
            let applied = applied as u32;
            for thr in 0..3i64 {
                let got = match find_track(s, Some(thr), None) {
                    Some(track) => names_of(st, &st.stack_at(track, applied)),
                    None => Vec::new(),
                };
                let want_stack = want.stacks.get(&thr).cloned().unwrap_or_default();
                assert_eq!(got, want_stack, "seed {seed} applied {applied} thr {thr}");
                // and by brute force over the stored intervals
                if let Some(track) = find_track(s, Some(thr), None) {
                    let brute: Vec<u32> = st.calls.get(&track).into_iter().flatten().copied().filter(|&i| st.open_at(i, applied)).collect();
                    assert_eq!(brute, st.stack_at(track, applied));
                }
            }
            let mut got: Vec<String> = st.open_spans_at(applied).iter().map(|&i| st.span_id(i).unwrap().to_string()).collect();
            let brute: Vec<u32> = st.spans.iter().copied().filter(|&i| st.open_at(i, applied)).collect();
            assert_eq!(st.open_spans_at(applied), brute);
            let mut want_spans = want.spans.clone();
            got.sort();
            want_spans.sort();
            assert_eq!(got, want_spans, "seed {seed} applied {applied}");
            for cpu in 0..2u64 {
                let got = st.cpu_at(cpu as u16, applied).map(|i| {
                    (st.flags[i as usize] & FLAG_IDLE == 0).then(|| s.track_thr(s.thr_idx[st.begin[i as usize] as usize]).unwrap())
                });
                assert_eq!(got, want.cpus.get(&cpu).copied(), "seed {seed} applied {applied} cpu {cpu}");
            }
        }
    }
}

fn names_of(st: &IntervalStore, list: &[u32]) -> Vec<String> {
    list.iter().map(|&i| st.name_of(i).unwrap().to_string()).collect()
}
