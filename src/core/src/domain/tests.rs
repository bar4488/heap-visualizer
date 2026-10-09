use serde_json::Value;

use super::*;
use crate::Engine;

fn engine(input: &str) -> Engine {
    let mut engine = Engine::new();
    engine.parse_begin();
    engine.parse_chunk(input.as_bytes());
    engine.parse_end();
    engine
}

const MIXED: &str = r#"{"op":"M","t":1,"id":1,"addr":"0x10","size":4,"site":"a","pool":"p"}
{"op":"L","t":2,"thr":3,"level":"warn","logger":"db","msg":"slow","ms":12}
{"op":"E","t":3,"title":"phase","frame":1}
{"op":"F","t":4,"id":1}
{"op":"L","t":5,"msg":"done"}
"#;

#[test]
fn the_op_table_decides_domains() {
    for (i, o) in OPS.iter().enumerate() {
        assert_eq!(o.op as usize, i, "OPS is indexed by op");
        assert_eq!(op_domain(o.op), o.domain);
        assert_eq!(op_for_letter(o.letter), Some(o.op));
    }
    assert_eq!(op_domain(200), NO_DOMAIN);
    assert_eq!(op_for_letter(b'Z'), None);
    assert_eq!(by_name("logs"), Some(LOGS));
    assert_eq!(by_name("nope"), None);
}

#[test]
fn every_domain_maps_rows_to_seqs_and_back() {
    let engine = engine(MIXED);
    let s = &engine.app.store;
    let mut seen = vec![false; s.len() as usize];
    for d in all(s) {
        for row in 0..d.count() {
            let seq = d.seq_of(row);
            assert_eq!(d.row_of(seq), Some(row), "{} row {row}", d.name());
            assert_eq!(s.domain_of(seq), d.id());
            assert!(!seen[seq as usize], "seq {seq} owned twice");
            seen[seq as usize] = true;
            let summary = d.summary(row);
            assert_eq!(summary.seq, seq);
        }
    }
    assert!(seen.iter().all(|&b| b), "every spine record has one domain");
}

#[test]
fn summaries_have_the_generic_shape() {
    let engine = engine(MIXED);
    let s = &engine.app.store;
    let logs = get(s, LOGS).unwrap();
    let mut out = String::new();
    logs.record_json(0, &mut out);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["seq"], 1);
    assert_eq!(v["domain"], "logs");
    assert_eq!(v["kind"], "log");
    assert_eq!(v["title"], "slow");
    assert_eq!(v["level"], 3);
    assert_eq!(v["source"], "db");
    assert_eq!(v["thr"], 3);
    assert_eq!(v["fields"]["ms"], 12);
    let agent = logs.summary(0).agent_value(s);
    assert_eq!(agent["t"], "2");
    assert_eq!(agent["level"], "warn");

    let heap = get(s, HEAP).unwrap();
    out.clear();
    heap.record_json(0, &mut out);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!((v["kind"].as_str(), v["source"].as_str()), (Some("malloc"), Some("a")));
    assert_eq!(v["fields"]["pool"], "p");
    assert!(v.get("level").is_none());
}

#[test]
fn marks_hold_no_heap_row_and_keep_the_trace_catalog() {
    let engine = engine(MIXED);
    let s = &engine.app.store;
    assert_eq!(s.domain_of(2), MARKS);
    assert_eq!(s.heap_row(2), None);
    assert_eq!(s.heap_len(), 2, "heap rows are M/F/R only");
    assert_eq!(s.dom.marks.len(), 1);
    // the landmark's field stays filterable-as-before: in the trace catalog
    assert!(s.fields.iter().any(|f| f.name == "frame" && f.events == 1));
    let marks = get(s, MARKS).unwrap();
    let d = marks.descriptor();
    assert_eq!(d["fields"][0]["name"], "frame");
    assert_eq!(d["keys"]["label"], "title");
    let mut out = String::new();
    marks.record_json(0, &mut out);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!((v["kind"].as_str(), v["title"].as_str()), (Some("event"), Some("phase")));
    assert_eq!(v["fields"]["frame"], 1);
    // the mark in force at a seq
    assert_eq!(marks.state_at(2), None);
    assert_eq!(marks.state_at(3).unwrap()["last"]["title"], "phase");
}
