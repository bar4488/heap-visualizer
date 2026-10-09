//! Heap-only versus mixed-trace benchmark (DOM-002's performance gate).
//!
//! Generates one deterministic heap workload in memory and loads it three
//! times: heap-only, and with structured log lines interleaved at 10x and
//! 100x the heap record count. The heap records are identical in all three,
//! so every heap operation below asks the same question of each trace and
//! the mixed columns should match the heap-only one.
//!
//! ```sh
//! cargo run --release --example mixed_bench --manifest-path src/core/Cargo.toml
//! cargo run --release --example mixed_bench --manifest-path src/core/Cargo.toml -- --heap 200000
//! ```
//!
//! Times are wall-clock medians over a few rounds; treat differences under
//! ~10% as noise.

use std::hint::black_box;
use std::time::{Duration, Instant};

use heap_visualizer_core::*;

/// Deterministic xorshift, so every run generates the same trace.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const SITES: [&str; 8] = [
    "parse", "alloc_node", "grow_buf", "cache_put", "conn_new", "json_tok", "arena", "timer",
];
const LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "fatal"];
const LOGGERS: [&str; 4] = ["net.http", "db.pool", "cache", "sched"];

/// Stream the trace in ~1 MiB chunks through `sink`, returning the spine
/// index of every heap record (so seeks can target the same heap state in
/// every trace).
fn generate(heap: u32, logs_per_heap: u32, mut sink: impl FnMut(&[u8])) -> Vec<u32> {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut log_rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut out = Vec::with_capacity(1 << 21);
    out.extend_from_slice(b"{\"op\":\"H\",\"v\":1,\"unit\":\"ns\",\"title\":\"mixed bench\"}\n");
    let mut live: Vec<(u64, u64)> = Vec::new(); // (id, addr)
    let mut next_id = 1u64;
    let mut next_addr = 0x1000_0000u64;
    let mut t = 0u64;
    let mut spine = 0u32;
    let mut heap_seq = Vec::with_capacity(heap as usize);
    for _ in 0..heap {
        // logs first, so the trace both starts and interleaves with them
        for _ in 0..logs_per_heap {
            t += 1 + log_rng.below(3);
            let level = LEVELS[(log_rng.below(100) as usize * LEVELS.len() / 100).min(5)];
            let logger = LOGGERS[log_rng.below(LOGGERS.len() as u64) as usize];
            let req = log_rng.below(10_000);
            out.extend_from_slice(
                format!(
                    "{{\"op\":\"L\",\"t\":{t},\"thr\":{},\"level\":\"{level}\",\"logger\":\"{logger}\",\"msg\":\"handled request r{req} in {}us\",\"req\":{req}}}\n",
                    log_rng.below(4),
                    log_rng.below(5000)
                )
                .as_bytes(),
            );
            spine += 1;
        }
        t += 1 + rng.below(5);
        let thr = rng.below(4);
        let free = live.len() > 4096 || (!live.is_empty() && rng.below(100) < 45);
        if free {
            let (id, addr) = live.swap_remove(rng.below(live.len() as u64) as usize);
            out.extend_from_slice(
                format!("{{\"op\":\"F\",\"t\":{t},\"id\":{id},\"addr\":\"0x{addr:x}\",\"thr\":{thr}}}\n")
                    .as_bytes(),
            );
        } else {
            let bits = 4 + rng.below(9);
            let size = 16 + rng.below(1 << bits);
            let site = SITES[rng.below(SITES.len() as u64) as usize];
            let id = next_id;
            next_id += 1;
            let addr = next_addr;
            next_addr += size.div_ceil(16) * 16 + 16;
            out.extend_from_slice(
                format!(
                    "{{\"op\":\"M\",\"t\":{t},\"id\":{id},\"addr\":\"0x{addr:x}\",\"size\":{size},\"thr\":{thr},\"site\":\"{site}\",\"pool\":{}}}\n",
                    rng.below(16)
                )
                .as_bytes(),
            );
            live.push((id, addr));
        }
        heap_seq.push(spine);
        spine += 1;
        if out.len() >= 1 << 20 {
            sink(&out);
            out.clear();
        }
    }
    sink(&out);
    heap_seq
}

fn feed(bytes: &[u8]) {
    let ptr = hp_buf_ptr(bytes.len() as u32);
    // SAFETY: `hp_buf_ptr` returned a buffer of at least `bytes.len()` bytes,
    // and the engine is only driven from this thread.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
}

fn load(heap: u32, ratio: u32) -> (Duration, Vec<u32>, u32) {
    let mut parse = Duration::ZERO;
    hp_parse_begin();
    let heap_seq = generate(heap, ratio, |chunk| {
        feed(chunk);
        let start = Instant::now();
        hp_parse_chunk(chunk.len() as u32);
        parse += start.elapsed();
    });
    let start = Instant::now();
    let n = hp_parse_end();
    parse += start.elapsed();
    (parse, heap_seq, n)
}

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

/// Median of `rounds` runs of `f`, each preceded by `setup`.
fn time(rounds: usize, mut setup: impl FnMut(), mut f: impl FnMut()) -> Duration {
    let mut v = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        setup();
        let start = Instant::now();
        f();
        v.push(start.elapsed());
    }
    median(v)
}

fn apply_filter(source: &str) -> u32 {
    feed(source.as_bytes());
    hp_filter_apply(source.len() as u32);
    hp_filter_set_mode(1);
    hp_events_filtered_count()
}

fn clear_filter() {
    feed(b"");
    hp_filter_apply(0);
    hp_filter_set_mode(0);
}

struct Row {
    name: &'static str,
    unit: &'static str,
    values: Vec<f64>,
}

fn main() {
    let mut heap = 50_000u32;
    let mut ratios = vec![0u32, 10, 100];
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--heap" => heap = args.next().and_then(|v| v.parse().ok()).expect("--heap N"),
            "--ratios" => {
                ratios = args
                    .next()
                    .expect("--ratios 0,10,100")
                    .split(',')
                    .map(|v| v.parse().expect("ratio"))
                    .collect()
            }
            other => panic!("unknown argument {other}"),
        }
    }

    let names = [
        ("load (parse)", "ms"),
        ("load per record", "ns"),
        ("seek: random jump", "us"),
        ("seek: near jump (+256 heap rows)", "us"),
        ("seek: step (+1 spine)", "ns"),
        ("seek: step to next heap record", "ns"),
        ("filter apply: alloc.size >= 1024", "ms"),
        ("filter apply: \"hot\" in alloc.tags", "ms"),
        ("filtered events list rebuild", "ms"),
        ("timeline render 1200px (seq)", "us"),
        ("timeline render 1200px (time)", "us"),
        ("address render 1200x800", "us"),
        ("retag 1 -> 2 -> 1", "ms"),
        ("tags dump", "ms"),
        ("agent timeline: 1% range, 100 bins", "ms"),
    ];
    let mut rows: Vec<Row> = names
        .iter()
        .map(|&(name, unit)| Row { name, unit, values: Vec::new() })
        .collect();

    for &ratio in &ratios {
        let (parse, heap_seq, n) = load(heap, ratio);
        let ms = |d: Duration| d.as_secs_f64() * 1e3;
        let us = |d: Duration| d.as_secs_f64() * 1e6;
        let ns = |d: Duration| d.as_secs_f64() * 1e9;
        rows[0].values.push(ms(parse));
        rows[1].values.push(ns(parse) / n as f64);
        eprintln!("ratio {ratio}: {n} records loaded in {:.0} ms", ms(parse));

        // random jumps between heap states
        let mut rng = Rng(7);
        let targets: Vec<u32> = (0..400)
            .map(|_| heap_seq[rng.below(heap as u64) as usize] + 1)
            .collect();
        let jump = time(5, || hp_seek_seq(0), || {
            for &t in &targets {
                hp_seek_seq(t);
            }
        });
        rows[2].values.push(us(jump) / targets.len() as f64);

        // near jumps: a short distance in heap rows, whatever the spine says
        let near: Vec<(u32, u32)> = (0..400)
            .map(|_| {
                let h = rng.below(heap as u64 - 300) as usize;
                (heap_seq[h] + 1, heap_seq[h + 256] + 1)
            })
            .collect();
        let mut near_total = Duration::ZERO;
        for &(from, to) in &near {
            hp_seek_seq(from);
            let start = Instant::now();
            hp_seek_seq(to);
            near_total += start.elapsed();
        }
        rows[3].values.push(us(near_total) / near.len() as f64);

        // playback: one spine record at a time
        let base = heap_seq[heap as usize / 3];
        let steps = 50_000u32;
        let step = time(3, || hp_seek_seq(base), || {
            for i in 1..=steps {
                hp_seek_seq(base + i);
            }
        });
        rows[4].values.push(ns(step) / steps as f64);

        // playback over heap records: each step crosses the logs between them
        let h0 = heap as usize / 3;
        let hsteps = 5_000usize;
        let hstep = time(3, || hp_seek_seq(heap_seq[h0] + 1), || {
            for &e in &heap_seq[h0 + 1..=h0 + hsteps] {
                hp_seek_seq(e + 1);
            }
        });
        rows[5].values.push(ns(hstep) / hsteps as f64);

        // filters
        let size = time(5, clear_filter, || {
            feed(b"alloc.size >= 1024");
            hp_filter_apply(18);
        });
        rows[6].values.push(ms(size));
        let labels = b"[\"hot\"]";
        feed(labels);
        hp_set_tag_labels(labels.len() as u32);
        let hot_end = heap_seq[heap as usize * 3 / 10];
        let tagged = hp_tag_seq_range(0, hot_end, 1, 0);
        let source = "\"hot\" in alloc.tags";
        let tag = time(5, clear_filter, || {
            feed(source.as_bytes());
            hp_filter_apply(source.len() as u32);
        });
        rows[7].values.push(ms(tag));
        let list = time(5, clear_filter, || {
            black_box(apply_filter("alloc.size >= 1024"));
        });
        // the list rebuild alone: subtract the apply it includes
        rows[8].values.push((ms(list) - ms(size)).max(0.0));
        // the same heap records must give the same answers in every trace
        clear_filter();
        let by_size = apply_filter("alloc.size >= 1024");
        clear_filter();
        let by_tag = apply_filter(source);
        eprintln!("  filtered events: by size {by_size}, by tag {by_tag}");
        clear_filter();

        // timelines: whole-trace view
        let total = n as f64;
        let tl_seq = time(9, || {}, || hp_tl_render(1, 1200, 60, 0.0, total));
        rows[9].values.push(us(tl_seq));
        let t_max = hp_t_for_seq(n);
        let tl_t = time(9, || {}, || hp_tl_render(0, 1200, 60, 0.0, t_max));
        rows[10].values.push(us(tl_t));

        hp_seek_seq(heap_seq[heap as usize / 2] + 1);
        let addr = time(9, || {}, || {
            hp_layout();
            hp_render_addr(1200, 800, 0.0);
        });
        rows[11].values.push(us(addr));

        let retag = time(3, || {}, || {
            hp_retag(1, 2);
            hp_retag(2, 1);
        });
        rows[12].values.push(ms(retag));
        let dump = time(3, || {}, || hp_tags_dump_json());
        rows[13].values.push(ms(dump));
        eprintln!("  tagged {tagged}");

        // free the browser engine's copy before loading the native one
        hp_parse_begin();
        hp_parse_end();
        let mut engine = Engine::new();
        engine.parse_begin();
        let heap_seq = generate(heap, ratio, |chunk| engine.parse_chunk(chunk));
        engine.parse_end();
        let (lo, hi) = (heap_seq[heap as usize / 2], heap_seq[heap as usize / 2 + heap as usize / 100]);
        let agent = time(5, || {}, || {
            black_box(engine.agent_timeline("alloc.size >= 64", "seq", lo as u64, hi as u64, 100).unwrap());
        });
        rows[14].values.push(ms(agent));
        drop(engine);
    }

    println!("heap records: {heap}");
    print!("| {:<38} |", "operation");
    for r in &ratios {
        print!(" {:>12} |", if *r == 0 { "heap-only".to_string() } else { format!("+{r}x logs") });
    }
    println!();
    print!("|{:-<40}|", "");
    for _ in &ratios {
        print!("{:->14}|", "");
    }
    println!();
    for row in &rows {
        print!("| {:<38} |", format!("{} ({})", row.name, row.unit));
        for v in &row.values {
            print!(" {:>12.2} |", v);
        }
        println!();
    }
}
