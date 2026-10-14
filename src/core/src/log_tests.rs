//! Tests for the event spine / heap domain split (DOM-001, DOM-002) and the
//! log domain (LOG-001..LOG-009).

use crate::logs::{self, LogQuery, Matches, NLEVEL};
use crate::parse::Parser;
use crate::store::*;
use crate::{agent, App, Engine};
use serde_json::Value;

fn load_app(input: &str) -> App {
    let mut a = App::new();
    let mut p = Parser::new();
    // awkward chunking exercises the carry path for log lines too
    for chunk in input.as_bytes().chunks(13) {
        p.chunk(chunk);
    }
    p.finish();
    a.store = p.store;
    a.view.reset(&a.store);
    a
}

fn engine(input: &str) -> Engine {
    let mut e = Engine::new();
    e.parse_begin();
    e.parse_chunk(input.as_bytes());
    e.parse_end();
    e
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const LEVEL_WORDS: [&str; 9] = [
    "trace", "DEBUG", "info", "warn", "Warning", "error", "err", "fatal", "bogus",
];

/// A heap trace of `n` heap records, plus the same trace with log records
/// interleaved (about `log_pct`% of lines). Returns (heap-only, mixed).
fn gen(seed: u64, n: usize, log_pct: u64) -> (String, String) {
    let mut r = Rng(seed | 1);
    let mut heap = String::from("{\"op\":\"H\",\"v\":1}\n");
    let mut mixed = heap.clone();
    let mut live: Vec<(u64, u64)> = Vec::new(); // (id, addr)
    let mut next_id = 1u64;
    let mut t = 0u64;
    for _ in 0..n {
        while r.below(100) < log_pct {
            t += r.below(3);
            let level = LEVEL_WORDS[r.below(LEVEL_WORDS.len() as u64) as usize];
            mixed.push_str(&format!(
                "{{\"op\":\"L\",\"t\":{t},\"thr\":{},\"level\":\"{level}\",\"logger\":\"mod{}\",\"msg\":\"request {} took {}ms\",\"size\":\"not-a-size\"}}\n",
                r.below(3),
                r.below(4),
                r.below(1000),
                r.below(50)
            ));
        }
        t += r.below(3);
        let roll = r.below(100);
        let line = if live.is_empty() || roll < 55 {
            let addr = 0x10000 + r.below(1 << 20) * 16;
            let id = next_id;
            next_id += 1;
            live.push((id, addr));
            format!(
                "{{\"op\":\"M\",\"t\":{t},\"id\":{id},\"addr\":\"0x{addr:x}\",\"size\":{},\"site\":\"s{}\",\"thr\":{}}}\n",
                1 + r.below(256),
                r.below(5),
                r.below(3)
            )
        } else if roll < 90 {
            let (id, _) = live.swap_remove(r.below(live.len() as u64) as usize);
            format!("{{\"op\":\"F\",\"t\":{t},\"id\":{id}}}\n")
        } else if roll < 97 {
            let (old, _) = live.swap_remove(r.below(live.len() as u64) as usize);
            let addr = 0x10000 + r.below(1 << 20) * 16;
            let id = next_id;
            next_id += 1;
            live.push((id, addr));
            format!(
                "{{\"op\":\"R\",\"t\":{t},\"id\":{id},\"old_id\":{old},\"addr\":\"0x{addr:x}\",\"size\":{}}}\n",
                1 + r.below(512)
            )
        } else {
            format!("{{\"op\":\"E\",\"t\":{t},\"title\":\"phase\"}}\n")
        };
        heap.push_str(&line);
        mixed.push_str(&line);
    }
    (heap, mixed)
}

/// The live set as wire identity: (addr, id, size), sorted.
fn live(a: &App) -> Vec<(u64, u64, u64)> {
    let s = &a.store;
    let mut v: Vec<_> = a
        .view
        .live
        .iter()
        .map(|&(addr, e)| (addr, s.id(e), s.size(e)))
        .collect();
    v.sort_unstable();
    v
}

// ------------------------------------------------------------- DOM-002

#[test]
fn heap_only_trace_builds_no_mapping() {
    let (heap, _) = gen(7, 500, 0);
    let a = load_app(&heap);
    assert!(a.store.hrank.is_empty());
    assert!(a.store.heap.seq.is_empty());
    assert_eq!(a.store.heap_len(), a.store.len());
    assert!(a.store.logs.is_empty());
}

#[test]
fn log_records_get_no_heap_rows_and_heap_records_no_log_rows() {
    let (heap, mixed) = gen(11, 2000, 40);
    let (h, m) = (load_app(&heap), load_app(&mixed));
    let s = &m.store;
    assert!(s.n_log > 0);
    assert_eq!(s.heap_len(), h.store.len(), "one heap row per heap record");
    assert_eq!(s.logs.len(), s.n_log);
    assert_eq!(s.len(), s.heap_len() + s.logs.len());
    for col in [s.heap.id.len(), s.heap.size.len(), s.heap.site.len(), s.heap.target.len(), s.heap.death.len()] {
        assert_eq!(col, s.heap_len() as usize);
    }
    assert_eq!(s.heap.green_pre.len(), s.heap_len() as usize + 1);
    // the mapping round-trips
    for e in 0..s.len() {
        match s.heap_row(e) {
            Some(h) => {
                assert!(s.is_heap(e));
                assert_eq!(s.heap_seq(h), e);
            }
            None => assert_eq!(s.op[e as usize], OP_L),
        }
    }
    // L records are not custom events and not allocations
    assert_eq!(s.n_custom, h.store.n_custom);
    assert_eq!(s.creator_count(), h.store.creator_count());
    assert_eq!(s.warn_counts[W_OVERLAP as usize], h.store.warn_counts[W_OVERLAP as usize]);
}

/// DOM-002's replay property: the heap live set at every position of the
/// mixed trace equals the heap-only trace's live set after the same heap
/// records — stepping forward, stepping back, and jumping through snapshots.
#[test]
fn live_set_is_identical_with_and_without_log_records() {
    for (seed, n, pct) in [(3u64, 3000usize, 30u64), (5, 20_000, 50), (9, 1500, 85)] {
        let (heap, mixed) = gen(seed, n, pct);
        let (mut h, mut m) = (load_app(&heap), load_app(&mixed));
        assert!(m.store.n_log > 0);
        assert_eq!(m.store.peak_live_bytes, h.store.peak_live_bytes);
        assert_eq!(m.store.total_alloc_bytes, h.store.total_alloc_bytes);
        let len = m.store.len();
        for p in 0..=len {
            m.view.seek(&m.store, p);
            let applied = m.store.heap_rank(p);
            h.view.seek(&h.store, applied);
            assert_eq!(m.view.live_bytes, h.view.live_bytes, "seed {seed} at {p}");
            assert_eq!(live(&m), live(&h), "seed {seed} at {p}");
        }
        for p in (0..=len).rev().step_by(7) {
            m.view.seek(&m.store, p);
            h.view.seek(&h.store, m.store.heap_rank(p));
            assert_eq!(live(&m), live(&h), "seed {seed} back at {p}");
        }
        let mut r = Rng(seed * 31 + 1);
        for _ in 0..200 {
            let p = r.below(len as u64 + 1) as u32;
            m.view.seek(&m.store, p);
            h.view.seek(&h.store, m.store.heap_rank(p));
            assert_eq!(live(&m), live(&h), "seed {seed} jump to {p}");
        }
    }
}

#[test]
fn filters_tags_and_timelines_agree_with_and_without_logs() {
    let (heap, mixed) = gen(17, 4000, 45);
    let (mut h, mut m) = (engine(&heap), engine(&mixed));
    let ids = |e: &Engine, v: &Value| -> Vec<String> {
        let _ = e;
        v["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()
    };
    for src in ["alloc.size >= 128", "malloc.site == \"s2\" and not alloc.freed", "malloc.thread == 1", "alloc.lifetime > 5"] {
        let qh = h.agent_query(src, "size-desc", 0, 100).unwrap();
        let qm = m.agent_query(src, "size-desc", 0, 100).unwrap();
        assert_eq!(ids(&h, &qh), ids(&m, &qm), "{src}");
    }
    // tag every allocation of one site through each, then filter on the tag
    for e in [&mut h, &mut m] {
        let store = &mut e.app.store;
        for x in 0..store.len() {
            if matches!(store.op[x as usize], OP_M | OP_R) && store.site(x) != NONE_U32 && store.sites[store.site(x) as usize] == "s1" {
                store.add_tag(x, 3);
            }
        }
        store.assert_tag_indexes();
        e.app.tag_labels = vec!["a".into(), "b".into(), "hot".into()];
    }
    for src in [
        "\"hot\" in alloc.tags and alloc.size > 50",
        "alloc.tags == {\"hot\"}",
        "len(alloc.tags) == 0 and alloc.size < 20",
    ] {
        let qh = h.agent_query(src, "creator-asc", 0, 100).unwrap();
        let qm = m.agent_query(src, "creator-asc", 0, 100).unwrap();
        assert_eq!(ids(&h, &qh), ids(&m, &qm), "{src}");
        assert_eq!(qh["matched"], qm["matched"], "{src}");
        assert!(qh["matched"]["allocations"].as_u64().unwrap() > 0, "{src}");
    }
    // tagging a log record does nothing
    let first_log = (0..m.app.store.len()).find(|&x| m.app.store.op[x as usize] == OP_L).unwrap();
    m.app.store.add_tag(first_log, 2);
    assert!(!m.app.store.has_tags(first_log));
    m.app.store.assert_tag_indexes();
    // density totals over the whole strip match
    let (sh, sm) = (&h.app.store, &m.app.store);
    assert_eq!(sh.green_before(sh.len()), sm.green_before(sm.len()));
    assert_eq!(sh.red_before(sh.len()), sm.red_before(sm.len()));
}

// ------------------------------------------------------------- LOG-001

#[test]
fn level_names_and_aliases() {
    for (name, level) in [
        ("trace", 0), ("DEBUG", 1), ("Info", 2), ("warn", 3), ("WARNING", 3),
        ("error", 4), ("err", 4), ("Fatal", 5),
    ] {
        assert_eq!(logs::level_from_name(name), Some(level), "{name}");
    }
    for bad in ["", "warnings", "critical", "5", "inf"] {
        assert_eq!(logs::level_from_name(bad), None, "{bad}");
    }
}

#[test]
fn log_records_parse_with_defaults_warnings_and_fields() {
    let long = format!("{}é{}", "x".repeat(logs::MSG_MAX - 1), "tail");
    let input = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        r#"{"op":"M","t":1,"id":1,"addr":"0x1000","size":8,"msg":"heap custom field"}"#,
        r#"{"seq":1,"t":2,"op":"L","thr":4,"level":"warning","logger":"net.http","msg":"retrying \"x\"","attempt":3,"site":"kept"}"#,
        r#"{"op":"L","t":3,"msg":"no level"}"#,
        r#"{"op":"L","t":4,"level":"loud","msg":"bad level"}"#,
        r#"{"op":"L","t":5,"level":7,"msg":"numeric level"}"#,
        r#"{"op":"L","t":6,"level":"error"}"#,
        r#"{"op":"L","t":7,"msg":42}"#,
        format!(r#"{{"op":"L","t":8,"level":"err","msg":"{long}"}}"#),
        r#"{"op":"L","t":9,"size":"big","id":"x","msg":"heap keys are fields here"}"#,
    );
    let a = load_app(&input);
    let s = &a.store;
    // two dropped (missing / non-string msg); everything else has a seq
    assert_eq!(s.len(), 7);
    assert_eq!(s.n_log, 6);
    assert_eq!(s.warn_counts[W_MALFORMED as usize], 2);
    assert_eq!(s.warn_counts[W_BAD_LEVEL as usize], 2);
    assert_eq!(s.warn_counts[W_LONG_LOG as usize], 1);
    assert_eq!(s.warn_counts[W_SEQ_MISMATCH as usize], 0);
    // the M keeps "msg" as its own custom field
    assert_eq!(s.extras[s.extra_at(0) as usize], r#""msg":"heap custom field""#);
    let logs = &s.logs;
    assert_eq!(logs.level, vec![3, 2, 2, 2, 4, 2]);
    assert_eq!(logs.seq, vec![1, 2, 3, 4, 5, 6]);
    assert_eq!(logs.msg(0), "retrying \"x\"");
    assert_eq!(logs.logger_name(0), Some("net.http"));
    assert_eq!(logs.logger_name(1), None);
    assert_eq!(logs.frags[logs.fields[0] as usize], r#""attempt":3,"site":"kept""#);
    assert_eq!(logs.frags[logs.fields[5] as usize], r#""size":"big","id":"x""#);
    assert_eq!(s.thrs[s.thr_idx[1] as usize], 4);
    // truncated at a character boundary: the 2-byte é straddles the limit
    assert_eq!(logs.msg(4).len(), logs::MSG_MAX - 1);
    assert!(logs.msg(4).chars().all(|c| c == 'x'));
    let long_warn = s.warnings.iter().find(|w| w.code == W_LONG_LOG).unwrap();
    assert_eq!(long_warn.seq, 5);
    assert_eq!(long_warn.detail as usize, long.len());
    // log keys never enter the heap's custom-field catalog
    assert!(s.fields.iter().all(|f| f.name == "msg"));
    // a decreasing t on a log is clamped like any record's
    let b = load_app("{\"op\":\"M\",\"t\":10,\"id\":1,\"addr\":\"0x10\",\"size\":1}\n{\"op\":\"L\",\"t\":3,\"msg\":\"m\"}\n");
    assert_eq!(b.store.t, vec![10, 10]);
    assert_eq!(b.store.warn_counts[W_T_DECREASE as usize], 1);
}

#[test]
fn log_only_trace_loads_seeks_and_renders() {
    let mut a = load_app("{\"op\":\"L\",\"t\":1,\"msg\":\"a\"}\n{\"op\":\"L\",\"t\":2,\"level\":\"fatal\",\"msg\":\"b\"}\n");
    assert_eq!(a.store.len(), 2);
    assert_eq!(a.store.heap_len(), 0);
    a.view.seek(&a.store, 2);
    assert_eq!(a.view.live_count, 0);
    crate::write_events_json(&mut a, 0, 10);
    assert!(a.out.contains("\"level\":5"));
    let mut px = Vec::new();
    crate::timeline::render(&mut a.store, &a.cfg, 1, 4, 40, 0.0, 2.0, &mut px);
    let hover: Value = serde_json::from_str(&crate::timeline::hover(&a.store, 1, 2, 1, 0.0, 2.0)).unwrap();
    assert_eq!(hover["logs"]["byLevel"], serde_json::json!([0, 0, 0, 0, 0, 1]));
    assert_eq!(hover["g"], 0);
}

// ------------------------------------------------------------- LOG-003/004

fn brute(s: &Store, q: &LogQuery) -> Vec<u32> {
    let logs = &s.logs;
    let needle = q.text.to_ascii_lowercase();
    (0..logs.len())
        .filter(|&r| {
            let seq = logs.seq[r as usize];
            logs.level[r as usize] >= q.min_level
                && q.seq_lo.is_none_or(|lo| seq >= lo)
                && q.seq_hi.is_none_or(|hi| seq <= hi)
                && (needle.is_empty()
                    || logs.msg(r).to_ascii_lowercase().contains(&needle)
                    || logs.logger_name(r).is_some_and(|l| l.to_ascii_lowercase().contains(&needle)))
        })
        .collect()
}

#[test]
fn queries_match_a_brute_force_oracle() {
    let (_, mixed) = gen(23, 3000, 60);
    let a = load_app(&mixed);
    let s = &a.store;
    let len = s.len();
    let mut r = Rng(99);
    let texts = ["", "", "took 1", "REQUEST", "mod2", "MOD", "ms", "zzz", "7ms", "t"];
    for i in 0..400 {
        let lo = (r.below(3) == 0).then(|| r.below(len as u64) as u32);
        let hi = (r.below(3) == 0).then(|| r.below(len as u64) as u32);
        let q = LogQuery {
            min_level: r.below(NLEVEL as u64) as u8,
            text: texts[r.below(texts.len() as u64) as usize].to_string(),
            seq_lo: lo,
            seq_hi: hi,
        };
        let want = brute(s, &q);
        let m = Matches::new(&s.logs, &q);
        assert_eq!(m.total(&s.logs) as usize, want.len(), "query {i}: {q:?}");
        for (k, &row) in want.iter().enumerate() {
            assert_eq!(m.row(&s.logs, k as u32), row, "query {i} match {k}");
        }
        // locate at a few seqs
        for _ in 0..5 {
            let seq = r.below(len as u64 + 2) as u32;
            let expect = want.iter().filter(|&&row| s.logs.seq[row as usize] <= seq).count() as i64 - 1;
            assert_eq!(m.locate(&s.logs, seq), expect, "query {i} locate {seq}");
        }
    }
}

#[test]
fn query_json_pages_and_reports_totals() {
    let (_, mixed) = gen(29, 1200, 50);
    let mut e = engine(&mixed);
    let all: Value = serde_json::from_str(&e.logs_query_json(r#"{"minLevel":0,"text":"","from":0,"count":100000}"#)).unwrap();
    let total = all["total"].as_u64().unwrap();
    assert_eq!(total, e.app.store.n_log as u64);
    assert_eq!(all["rows"].as_array().unwrap().len(), logs::PAGE_MAX as usize, "pages cap at 500");
    // walk pages of 37 and recover every record exactly once, in seq order
    let mut seen = Vec::new();
    let mut from = 0;
    loop {
        let page: Value = serde_json::from_str(&e.logs_query_json(&format!(
            r#"{{"minLevel":"warn","text":"REQ","seqLo":10,"from":{from},"count":37}}"#
        )))
        .unwrap();
        let rows = page["rows"].as_array().unwrap();
        assert_eq!(page["from"], from);
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(row["row"], from + i as u64);
            assert!(row["level"].as_u64().unwrap() >= 3);
            assert!(row["seq"].as_u64().unwrap() >= 10);
            assert!(row["msg"].as_str().unwrap().contains("request"));
            assert!(row["t"].is_number());
            assert!(row["fields"].is_object(), "the generator's size field is kept");
            seen.push(row["seq"].as_u64().unwrap());
        }
        if rows.is_empty() {
            assert_eq!(from, page["total"].as_u64().unwrap());
            break;
        }
        from += rows.len() as u64;
    }
    assert!(seen.windows(2).all(|w| w[0] < w[1]));
    let q = LogQuery { min_level: 3, text: "REQ".into(), seq_lo: Some(10), seq_hi: None };
    assert_eq!(seen.len(), brute(&e.app.store, &q).len());
    // from past the end clamps; garbage input answers with an error object
    let past: Value = serde_json::from_str(&e.logs_query_json(r#"{"minLevel":5,"text":"","from":999999,"count":5}"#)).unwrap();
    assert_eq!(past["rows"].as_array().unwrap().len(), 0);
    assert_eq!(past["from"], past["total"]);
    let bad: Value = serde_json::from_str(&e.logs_query_json("not json")).unwrap();
    assert!(bad["error"].is_string());
}

#[test]
fn text_scan_allocates_nothing_per_row() {
    let (_, mixed) = gen(31, 20_000, 50);
    let a = load_app(&mixed);
    assert!(a.store.logs.len() > 10_000);
    let q = LogQuery { min_level: 0, text: "no such text anywhere".into(), seq_lo: None, seq_hi: None };
    let before = crate::counting_alloc::count();
    let m = Matches::new(&a.store.logs, &q);
    let after = crate::counting_alloc::count();
    assert_eq!(m.total(&a.store.logs), 0);
    assert!(after - before <= 3, "{} allocations for one scan", after - before);
}

#[test]
fn locate_edge_cases() {
    let input = "\
{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x10\",\"size\":1}
{\"op\":\"L\",\"t\":2,\"level\":\"info\",\"msg\":\"alpha\"}
{\"op\":\"F\",\"t\":3,\"id\":1}
{\"op\":\"L\",\"t\":4,\"level\":\"error\",\"msg\":\"beta\"}
{\"op\":\"L\",\"t\":5,\"level\":\"debug\",\"msg\":\"alphabet\"}
{\"op\":\"M\",\"t\":6,\"id\":2,\"addr\":\"0x20\",\"size\":1}
";
    let mut e = engine(input);
    let loc = |e: &mut Engine, req: &str| -> (i64, u64) {
        let v: Value = serde_json::from_str(&e.logs_locate_json(req)).unwrap();
        (v["row"].as_i64().unwrap(), v["total"].as_u64().unwrap())
    };
    // before the first log record
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"","seq":0}"#), (-1, 3));
    // exactly on a match, between matches, after the last
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"","seq":1}"#), (0, 3));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"","seq":2}"#), (0, 3));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"","seq":4}"#), (2, 3));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"","seq":4000000000}"#), (2, 3));
    // level and text narrow the list the index counts in
    assert_eq!(loc(&mut e, r#"{"minLevel":"warn","text":"","seq":2}"#), (-1, 1));
    assert_eq!(loc(&mut e, r#"{"minLevel":4,"text":"","seq":5}"#), (0, 1));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"ALPHA","seq":3}"#), (0, 2));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"alpha","seq":4}"#), (1, 2));
    assert_eq!(loc(&mut e, r#"{"minLevel":0,"text":"nothing","seq":4}"#), (-1, 0));
    // a heap-only trace has nothing to locate
    let mut h = engine("{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x10\",\"size\":1}\n");
    assert_eq!(loc(&mut h, r#"{"minLevel":0,"text":"","seq":0}"#), (-1, 0));
}

// ------------------------------------------------------------- LOG-005

#[test]
fn lane_bins_from_prefix_sums() {
    let (_, mixed) = gen(37, 2500, 55);
    let a = load_app(&mixed);
    let s = &a.store;
    let mut r = Rng(5);
    for _ in 0..500 {
        let x = r.below(s.len() as u64 + 1) as u32;
        let y = r.below(s.len() as u64 + 1) as u32;
        let (lo, hi) = (x.min(y), x.max(y));
        let mut want = [0u32; NLEVEL];
        for row in 0..s.logs.len() as usize {
            let seq = s.logs.seq[row];
            if seq >= lo && seq < hi {
                want[s.logs.level[row] as usize] += 1;
            }
        }
        assert_eq!(s.logs.counts(lo, hi), want, "[{lo}, {hi})");
        let max = (0..NLEVEL).rev().find(|&l| want[l] > 0).map(|l| l as u8);
        assert_eq!(s.logs.max_level(lo, hi), max, "[{lo}, {hi})");
    }
}

#[test]
fn lane_is_drawn_and_hover_reports_log_counts() {
    // seq 0 M, 1 L(error), 2 L(debug), 3 F — two columns over seq [0, 4)
    let input = "\
{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x10\",\"size\":1}
{\"op\":\"L\",\"t\":2,\"level\":\"error\",\"msg\":\"e\"}
{\"op\":\"L\",\"t\":3,\"level\":\"debug\",\"msg\":\"d\"}
{\"op\":\"F\",\"t\":4,\"id\":1}
";
    let mut a = load_app(input);
    let (w, h) = (2u32, 40u32);
    let mut px = Vec::new();
    crate::timeline::render(&mut a.store, &a.cfg, 1, w, h, 0.0, 4.0, &mut px);
    let (y0, _) = crate::timeline::log_lane_rows(h);
    let at = |x: u32, y: i64| {
        let p = ((y as u32 * w + x) * 4) as usize;
        [px[p], px[p + 1], px[p + 2]]
    };
    // column 0 covers seq [0, 2): the error; column 1 covers [2, 4): debug
    assert_eq!(at(0, y0), crate::timeline::LOG_COLORS[4]);
    assert_eq!(at(1, y0), crate::timeline::LOG_COLORS[1]);
    let hover: Value = serde_json::from_str(&crate::timeline::hover(&a.store, 1, w, 0, 0.0, 4.0)).unwrap();
    assert_eq!(hover["g"], 1);
    assert_eq!(hover["logs"]["count"], 1);
    assert_eq!(hover["logs"]["byLevel"], serde_json::json!([0, 0, 0, 0, 1, 0]));
    // a heap-only trace's hover has no logs key at all
    let b = load_app("{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x10\",\"size\":1}\n");
    let hover: Value = serde_json::from_str(&crate::timeline::hover(&b.store, 1, 1, 0, 0.0, 1.0)).unwrap();
    assert!(hover.get("logs").is_none());
}

// ------------------------------------------------------------- LOG-006

#[test]
fn events_json_carries_log_rows() {
    let input = "\
{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x10\",\"size\":4,\"site\":\"a\"}
{\"op\":\"L\",\"t\":2,\"thr\":7,\"level\":\"warn\",\"logger\":\"db\",\"msg\":\"slow \\\"q\\\"\",\"ms\":12}
{\"op\":\"L\",\"t\":3,\"msg\":\"plain\"}
{\"op\":\"F\",\"t\":4,\"id\":1}
";
    let mut a = load_app(input);
    crate::write_events_json(&mut a, 0, 10);
    let rows: Value = serde_json::from_str(&a.out).unwrap();
    assert_eq!(
        rows[1],
        serde_json::json!({"seq":1,"op":OP_L,"t":2,"e":null,"level":3,"logger":"db","msg":"slow \"q\"","thr":7,"extra":{"ms":12}})
    );
    assert_eq!(
        rows[2],
        serde_json::json!({"seq":2,"op":OP_L,"t":3,"e":null,"level":2,"logger":null,"msg":"plain","thr":null})
    );
    assert_eq!(rows[3]["e"], 0, "the free still resolves across the logs");
    // the allocation filter never matches a log row
    a.cfg.filter.mode = crate::render::FILTER_HIDE;
    a.ev_dirty = true;
    crate::ensure_ev_filtered(&mut a);
    assert_eq!(a.ev_filtered, vec![0, 3]);
    // nor do event helpers resolve one to an allocation
    assert_eq!(crate::render::scroll_for_event(&a.store, &mut a.view, &a.cfg, 100, 1), -1.0);
    let meta: Value = serde_json::from_str(&{
        crate::write_metadata_json(&mut a);
        a.out.clone()
    })
    .unwrap();
    assert_eq!(meta["nLog"], 2);
    assert_eq!(meta["warnCounts"].as_array().unwrap().len(), NWARN);
}

#[test]
fn meta_json_counts_levels_and_ranks_loggers() {
    let mut input = String::new();
    for i in 0..300 {
        input.push_str(&format!(
            "{{\"op\":\"L\",\"t\":{i},\"level\":\"{}\",\"logger\":\"l{}\",\"msg\":\"m\"}}\n",
            ["info", "error"][i % 2],
            if i < 60 { 0 } else { i }
        ));
    }
    let mut e = engine(&input);
    let meta: Value = serde_json::from_str(&e.logs_meta_json()).unwrap();
    assert_eq!(meta["count"], 300);
    assert_eq!(meta["byLevel"], serde_json::json!([0, 0, 150, 0, 150, 0]));
    let loggers = meta["loggers"].as_array().unwrap();
    assert_eq!(loggers.len(), logs::META_LOGGERS_MAX);
    assert_eq!(loggers[0], serde_json::json!({"name":"l0","count":60}));
}

// ------------------------------------------------------------- LOG-008

#[test]
fn agent_logs_are_bounded_and_typed() {
    let (_, mixed) = gen(41, 3000, 50);
    let e = engine(&mixed);
    let n_log = e.app.store.n_log as u64;
    let page = e.agent_logs(&agent::LogsParams::default()).unwrap();
    assert_eq!(page["total"], n_log);
    assert_eq!(page["items"].as_array().unwrap().len(), agent::LOGS_COUNT_DEFAULT);
    assert_eq!(page["next"], agent::LOGS_COUNT_DEFAULT);
    let item = &page["items"][0];
    assert!(item["t"].is_string(), "times are strings in the agent API");
    assert!(item["level"].is_string());
    assert!(item.get("seq").is_some() && item.get("thr").is_some() && item.get("fields").is_some());
    assert!(serde_json::to_string(&page).unwrap().len() < 256 * 1024);
    // the maximum page, the last page, and the bounds
    let max = e.agent_logs(&agent::LogsParams { count: Some(200), ..Default::default() }).unwrap();
    assert_eq!(max["items"].as_array().unwrap().len(), 200);
    let last = e
        .agent_logs(&agent::LogsParams { from: n_log as usize - 3, count: Some(10), ..Default::default() })
        .unwrap();
    assert_eq!(last["items"].as_array().unwrap().len(), 3);
    assert_eq!(last["next"], Value::Null);
    for bad in [Some(0), Some(201)] {
        assert!(e.agent_logs(&agent::LogsParams { count: bad, ..Default::default() }).is_err());
    }
    for (level, ok) in [("warn", true), ("WARNING", true), ("3", true), ("6", false), ("loud", false)] {
        let r = e.agent_logs(&agent::LogsParams { min_level: Some(level.into()), ..Default::default() });
        assert_eq!(r.is_ok(), ok, "{level}");
    }
    let warn = e
        .agent_logs(&agent::LogsParams { min_level: Some("warn".into()), text: Some("MOD1".into()), seq_lo: Some(100), seq_hi: Some(2000), count: Some(200), ..Default::default() })
        .unwrap();
    for item in warn["items"].as_array().unwrap() {
        assert!(["warn", "error", "fatal"].contains(&item["level"].as_str().unwrap()));
        let seq = item["seq"].as_u64().unwrap();
        assert!((100..=2000).contains(&seq));
        assert_eq!(item["logger"], "mod1");
    }
    assert!(e
        .agent_logs(&agent::LogsParams { text: Some("x".repeat(agent::LOGS_TEXT_MAX + 1)), ..Default::default() })
        .is_err());
    // the overview reports log counts by level
    let overview = e.agent_overview(5);
    assert_eq!(overview["logs"]["records"], n_log);
    let by_level = overview["logs"]["byLevel"].as_object().unwrap();
    assert_eq!(by_level.values().map(|v| v.as_u64().unwrap()).sum::<u64>(), n_log);
    assert_eq!(by_level.keys().cloned().collect::<Vec<_>>().len(), NLEVEL);
}
