//! Wall-clock cost of the address-map render path (F1–F3 in ../01-render-hot-path.md).
//!
//! Not part of the crate — it lives here so the review's numbers are
//! reproducible without adding a bench target to `core/`. See the README for
//! the copy-and-run recipe; in short:
//!
//!     cp -r core /tmp/hv-bench && mkdir -p /tmp/hv-bench/examples
//!     cp docs/findings/2026-07-24/bench/*.rs /tmp/hv-bench/examples/
//!     sed -i '/^panic = "abort"$/d' /tmp/hv-bench/Cargo.toml
//!     cd /tmp/hv-bench && cargo run --release --example render_cost
//!
//! Absolute times are machine-dependent; the ratios between rows are the point.

use heap_visualizer_core::parse::Parser;
use heap_visualizer_core::render::{self, Cfg, Frame};
use heap_visualizer_core::state::View;
use heap_visualizer_core::store::Store;
use std::time::Instant;

const EVENTS: u64 = 300_000;
const ARENA_MB: u64 = 256;
const ITERS: u32 = 200;

/// Synthetic trace: allocations scattered over `arena_mb`, one in three freed,
/// optionally preceded by a single large allocation that is never freed (which
/// is all it takes to inflate `Store::max_span` for the whole trace).
fn build(n: u64, arena_mb: u64, giant_mb: u64) -> Store {
    let mut s = String::from("{\"op\":\"H\",\"v\":1,\"row_bytes\":4096}\n");
    let span = arena_mb * 1024 * 1024;
    if giant_mb > 0 {
        s.push_str(&format!(
            "{{\"op\":\"M\",\"id\":999999999,\"addr\":\"0x10000\",\"size\":{},\"t\":1}}\n",
            giant_mb * 1024 * 1024
        ));
    }
    let mut id = 1u64;
    let mut live: Vec<u64> = Vec::new();
    for i in 0..n {
        let t = (i + 2) * 3;
        if i % 3 == 2 && !live.is_empty() {
            let fid = live.remove((i as usize * 7919) % live.len());
            s.push_str(&format!("{{\"op\":\"F\",\"id\":{},\"t\":{}}}\n", fid, t));
        } else {
            s.push_str(&format!(
                "{{\"op\":\"M\",\"id\":{},\"addr\":\"0x{:x}\",\"size\":{},\"t\":{}}}\n",
                id,
                0x10000 + (i * 4099) % span,
                16 + i % 512,
                t
            ));
            live.push(id);
            id += 1;
        }
    }
    let mut p = Parser::new();
    p.chunk(s.as_bytes());
    p.finish();
    p.store
}

fn main() {
    for (label, giant) in [("no large allocation", 0u64), ("one 64 MiB allocation", 64)] {
        let store = build(EVENTS, ARENA_MB, giant);
        let mut v = View::new();
        v.reset(&store);
        let cfg = Cfg::new();
        let mut frame = Frame::new();

        v.seek(&store, store.len() / 2);
        v.ensure_rows();
        println!("\n=== {} ===", label);
        println!(
            "{} events · max_span {} B · {} live · {} display rows",
            store.len(),
            store.max_span,
            v.live_count,
            v.rows.len()
        );

        // F3: layout rebuild triggered by a single-event step, both row modes.
        for show_all in [true, false] {
            v.set_show_all(&store, show_all);
            let t0 = Instant::now();
            for k in 0..ITERS {
                v.seek(&store, store.len() / 2 + k);
                v.ensure_rows();
            }
            println!(
                "  seek + ensure_rows ({:<9}): {:>6.3} ms/step",
                if show_all { "show_all" } else { "live rows" },
                t0.elapsed().as_secs_f64() * 1000.0 / ITERS as f64
            );
        }
        v.set_show_all(&store, true);

        // F1/F2: a full frame, viewport well below the top of the address space.
        v.seek(&store, store.len() / 2);
        render::render_addr(&store, &mut v, &cfg, &mut frame, 1600, 900, 40_000.0);
        let t0 = Instant::now();
        for _ in 0..ITERS {
            render::render_addr(&store, &mut v, &cfg, &mut frame, 1600, 900, 40_000.0);
        }
        println!(
            "  render_addr 1600x900          : {:>6.3} ms/frame",
            t0.elapsed().as_secs_f64() * 1000.0 / ITERS as f64
        );
    }
}
