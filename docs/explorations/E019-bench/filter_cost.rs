//! Wall-clock cost of one filter Apply, against the gates in E010.
//!
//! Native release, not WASM: absolute numbers are optimistic relative to the
//! browser, which is the point — a predicate that misses the gate here misses
//! it there too.
//!
//! Not part of the crate — it lives here so E019's numbers are reproducible
//! without adding a bench target to `core/`. `filter_eval` and `filter_plan`
//! are private, so the recipe makes them public in the copy:
//!
//!     mkdir -p /tmp/hvb && cp -r src/core src/filter-dsl /tmp/hvb/
//!     rm -rf /tmp/hvb/core/target /tmp/hvb/filter-dsl/target
//!     sed -i '/^panic = "abort"$/d' /tmp/hvb/core/Cargo.toml
//!     sed -i 's/^mod filter_eval;/pub mod filter_eval;/;
//!             s/^mod filter_plan;/pub mod filter_plan;/' /tmp/hvb/core/src/lib.rs
//!     mkdir -p /tmp/hvb/core/examples
//!     cp docs/explorations/E019-bench/filter_cost.rs /tmp/hvb/core/examples/
//!     cd /tmp/hvb/core && cargo run --release --example filter_cost
//!
//! `floor()` is the control: the same predicate as a direct column scan, which
//! is what a lowered plan should compile to. Absolute times are
//! machine-dependent; the ratio to the control is the finding.

use heap_visualizer_core::filter_eval::{self, Ctx, FieldValues};
use heap_visualizer_core::filter_plan;
use heap_visualizer_core::parse::Parser;
use heap_visualizer_core::store::Store;
use std::time::Instant;

const CREATORS: u64 = 1_000_000;
const ITERS: u32 = 9;

fn build(n: u64) -> Store {
    let mut s = String::from("{\"op\":\"H\",\"v\":1,\"row_bytes\":4096}\n");
    let sites = ["json_node", "xml_parse", "gfx_buffer", "net_rx"];
    for i in 0..n {
        s.push_str(&format!(
            "{{\"op\":\"M\",\"id\":{},\"addr\":\"0x{:x}\",\"size\":{},\"t\":{},\"site\":\"{}\",\"thr\":{},\"pool\":\"{}\"}}\n",
            i + 1,
            0x1000_0000u64 + (i * 4099) % (256 * 1024 * 1024),
            16 + i % 4096,
            i * 3,
            sites[(i % 4) as usize],
            i % 8,
            if i % 3 == 0 { "gfx" } else { "heap" },
        ));
    }
    let mut p = Parser::new();
    p.chunk(s.as_bytes());
    p.finish();
    let mut store = p.store;
    for e in 0..store.len() {
        if e % 7 == 0 {
            store.add_tag(e, 1);
        }
        if e % 11 == 0 {
            store.add_tag(e, 2);
        }
    }
    store
}

fn floor(store: &Store) -> f64 {
    let t = Instant::now();
    let mut m = 0u32;
    for i in 0..store.len() as usize {
        if store.size[i] >= 4096 {
            m += 1;
        }
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(m);
    ms
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let store = build(CREATORS);
    let labels = ["hot".to_string(), "cold".to_string()];
    let names: Vec<(u32, String)> = vec![(3, "anchor".to_string())];
    let control = median((0..ITERS).map(|_| floor(&store)).collect());
    println!(
        "{} events, {} creators\nfloor: size >= 4096 as a direct column scan  {:.2} ms\n",
        store.len(),
        store.creator_count(),
        control
    );

    for source in [
        "size >= 4096",
        "size >= 4096 && address >= 0x10000000",
        "thread in {2, 4}",
        "site == \"json_node\"",
        "site.starts_with(\"json\")",
        "tags contains \"hot\"",
        "tags == {\"hot\"}",
        "field.pool == \"gfx\"",
        "freed",
        "abs(seq - named(\"anchor\").seq) <= 1000",
        "site == \"json_node\" && size >= 4096 && tags contains \"hot\"",
    ] {
        let expr = heap_visualizer_filter_dsl::parse(source).unwrap();
        let base = Ctx::new(&store, &labels, &names);
        if let Err(e) = filter_eval::check(&expr, &base) {
            println!("{source:52}  check error: {}", e.message);
            continue;
        }
        let mut compile = Vec::new();
        let mut scan = Vec::new();
        let mut matches = 0u32;
        for _ in 0..ITERS {
            let fields = FieldValues::resolve(&expr, &store);
            let ctx = Ctx::new(&store, &labels, &names).with_fields(&fields);
            let t = Instant::now();
            let plan = filter_plan::lower(&expr, &ctx).unwrap();
            compile.push(t.elapsed().as_secs_f64() * 1000.0);
            let mut bits = vec![0u64; (store.len() as usize).div_ceil(64)];
            let t = Instant::now();
            matches = filter_plan::scan(&plan, &ctx, &mut bits);
            scan.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let scan_ms = median(scan);
        println!(
            "{source:52}  scan {:6.2} ms ({:4.1}x floor)   compile {:5.2} ms   ({} matches)",
            scan_ms,
            scan_ms / control,
            median(compile),
            matches
        );
    }
}
