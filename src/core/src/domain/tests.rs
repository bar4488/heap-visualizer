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
fn the_generic_abi_answers_for_every_domain() {
    let mut engine = engine(MIXED);
    // the log aliases are the generic query for `logs`
    let req = r#"{"minLevel":"warn","text":"SLOW","from":0,"count":10}"#;
    let alias = engine.logs_query_json(req);
    let generic = engine.domain_query_json(r#"{"domain":"logs","minLevel":"warn","text":"SLOW","from":0,"count":10}"#);
    assert_eq!(alias, generic);
    let alias = engine.logs_locate_json(r#"{"seq":4}"#);
    assert_eq!(alias, engine.domain_locate_json(r#"{"domain":"logs","seq":4}"#));
    assert_eq!(alias, r#"{"row":1,"total":2}"#);

    let marks: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"marks","text":"PHA"}"#)).unwrap();
    assert_eq!(marks["total"], 1);
    assert_eq!(marks["rows"][0], serde_json::json!({"row":0,"seq":2,"t":3,"thr":null,"title":"phase","fields":{"frame":1}}));
    let heap: Value = serde_json::from_str(&engine.domain_query_json(r#"{"domain":"heap","seqLo":1}"#)).unwrap();
    assert_eq!((heap["total"].as_u64(), heap["rows"][0]["seq"].as_u64()), (Some(1), Some(3)));
    assert_eq!(heap["rows"][0]["kind"], "free");
    assert!(engine.domain_query_json(r#"{"domain":"nope"}"#).contains("\"error\":\"unknown domain\""));
    assert!(engine.domain_locate_json("[]").contains("\"row\":-1"));

    let kinds: Vec<String> = (0..6)
        .map(|seq| {
            let v: Value = serde_json::from_str(&engine.record_json(seq)).unwrap();
            format!("{}:{}", v["domain"].as_str().unwrap_or("-"), v["kind"].as_str().unwrap_or("-"))
        })
        .collect();
    assert_eq!(kinds, ["heap:malloc", "logs:log", "marks:event", "heap:free", "logs:log", "-:-"]);

    let all: Value = serde_json::from_str(&engine.domains_json()).unwrap();
    let ids: Vec<&str> = all.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["heap", "marks", "logs"]);
    assert_eq!(all[2]["count"], 2);
    assert_eq!(engine.domain_state("marks", 5).unwrap()["last"]["seq"], 2);
}

#[test]
fn agent_domain_records_page_any_domain() {
    let engine = engine(MIXED);
    let mut p = RecordParams { count: Some(1), ..Default::default() };
    let heap = engine.agent_domain_records("heap", &p).unwrap();
    assert_eq!((heap["domain"].as_str(), heap["total"].as_u64(), heap["next"].as_u64()), (Some("heap"), Some(2), Some(1)));
    assert_eq!(heap["items"][0]["t"], "1");
    p.params.insert("text".into(), "phase".into());
    let marks = engine.agent_domain_records("marks", &p).unwrap();
    assert_eq!(marks["items"][0]["title"], "phase");
    p.params.insert("minLevel".into(), "warn".into());
    assert!(engine.agent_domain_records("marks", &p).is_err(), "marks take no minLevel");
    p.params.remove("text");
    let logs = engine.agent_domain_records("logs", &p).unwrap();
    assert_eq!((logs["total"].as_u64(), logs["items"][0]["logger"].as_str()), (Some(1), Some("db")));
    assert!(engine.agent_domain_records("heap", &p).is_err(), "heap takes no minLevel");
    assert!(engine.agent_domain_records("nope", &RecordParams::default()).is_err());
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
