//! Wall-clock cost of one filter Apply scan, against the gates in E010.
//!
//! Native release, not WASM: absolute numbers are optimistic relative to the
//! browser, which is the point — a predicate that misses the gate here misses
//! it there too.
//!
//! Not part of the crate — it lives here so E019's numbers are reproducible
//! without adding a bench target to `core/`. `filter_eval` is private, so the
//! recipe makes it public in the copy:
//!
//!     mkdir -p /tmp/hvb && cp -r src/core src/filter-dsl /tmp/hvb/
//!     rm -rf /tmp/hvb/core/target /tmp/hvb/filter-dsl/target
//!     sed -i '/^panic = "abort"$/d' /tmp/hvb/core/Cargo.toml
//!     sed -i 's/^mod filter_eval;/pub mod filter_eval;/' /tmp/hvb/core/src/lib.rs
//!     mkdir -p /tmp/hvb/core/examples
//!     cp docs/explorations/E019-bench/filter_cost.rs /tmp/hvb/core/examples/
//!     cd /tmp/hvb/core && cargo run --release --example filter_cost
//!
//! `floor()` is the control: the same predicate as a direct column scan, which
//! is what a lowered typed plan compiles to. Absolute times are
//! machine-dependent; the ratio between the two is the finding.

use heap_visualizer_core::filter_eval::{self, Ctx, FieldValues};
use heap_visualizer_core::parse::Parser;
use heap_visualizer_core::store::Store;
use std::time::Instant;

const CREATORS: u64 = 1_000_000;
const ITERS: u32 = 7;

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
    p.store
}

fn main() {
    let store = build(CREATORS);
    floor(&store); floor(&store);
    println!("{} events\n", store.len());
    let labels: Vec<String> = Vec::new();
    let names: Vec<(u32, String)> = Vec::new();

    for source in [
        "size >= 4096",
        "size >= 4096 && address >= 0x10000000",
        "thread in {2, 4}",
        "site == \"json_node\"",
        "tags contains \"suspect\"",
        "site.starts_with(\"json\")",
        "field.pool == \"gfx\"",
    ] {
        let expr = heap_visualizer_filter_dsl::parse(source).unwrap();
        let base = Ctx::new(&store, &labels, &names);
        if let Err(e) = filter_eval::check(&expr, &base) {
            println!("{source:38}  check error: {}", e.message);
            continue;
        }
        let mut ms: Vec<f64> = Vec::new();
        let mut matches = 0u32;
        for _ in 0..ITERS {
            let fields = FieldValues::resolve(&expr, &store);
            let ctx = Ctx::new(&store, &labels, &names).with_fields(&fields);
            let t = Instant::now();
            let mut m = 0u32;
            for e in 0..store.len() {
                if filter_eval::evaluate(&expr, &ctx, e).unwrap() {
                    m += 1;
                }
            }
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
            matches = m;
        }
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{source:38}  median {:7.1} ms   best {:7.1} ms   ({} matches)",
            ms[ms.len() / 2],
            ms[0],
            matches
        );
    }
}

// The floor: what the same predicate costs as a direct column scan, which is
// what a lowered typed plan compiles to.
#[allow(dead_code)]
fn floor(store: &Store) {
    let t = Instant::now();
    let mut m = 0u32;
    for i in 0..store.len() as usize {
        if store.size[i] >= 4096 {
            m += 1;
        }
    }
    println!("floor: size >= 4096 direct column scan {:.2} ms ({m} matches)",
        t.elapsed().as_secs_f64() * 1000.0);
}
