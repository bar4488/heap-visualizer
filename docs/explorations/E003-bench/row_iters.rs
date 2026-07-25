//! Loop-iteration counts behind the table in ../01-render-hot-path.md:
//! how many rows the per-allocation loop visits (F1) and how many allocations
//! the `max_span`-bounded live-set walk collects (F2), against how many are
//! actually visible.
//!
//! Requires a temporary two-counter patch to the *scratch copy* of
//! `core/src/render.rs` (never the repository):
//!
//! 1. After `use crate::store::*;` add:
//!
//!        pub static ROW_ITERS:   std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
//!        pub static ROW_SKIPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
//!        pub static DRAW_LEN:    std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
//!
//! 2. Immediately after `draw.sort_unstable();` add:
//!
//!        DRAW_LEN.fetch_add(draw.len() as u64, std::sync::atomic::Ordering::Relaxed);
//!
//! 3. In the per-allocation row loop, after `idx += 1;` add:
//!
//!        ROW_ITERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
//!
//!    and inside that loop's `if y + (row_px as i64) < 0 || y >= h as i64 {`
//!    branch, just before the `continue;`, add:
//!
//!        ROW_SKIPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
//!
//! Then: cargo run --release --example row_iters

use heap_visualizer_core::parse::Parser;
use heap_visualizer_core::render::{self, Cfg, Frame, DRAW_LEN, ROW_ITERS, ROW_SKIPPED};
use heap_visualizer_core::state::View;
use heap_visualizer_core::store::Store;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Instant;

const EVENTS: u64 = 300_000;
const ARENA_MB: u64 = 256;
const ITERS: u64 = 100;

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
    println!(
        "{:<24} {:>9} {:>11} {:>12} {:>10}",
        "case", "ms/frame", "row iters", "of which", "draw[]"
    );
    println!(
        "{:<24} {:>9} {:>11} {:>12} {:>10}",
        "", "", "per frame", "off-screen", "per frame"
    );
    for (label, giant) in [
        ("no large allocation", 0u64),
        ("one 16 MiB allocation", 16),
        ("one 64 MiB allocation", 64),
    ] {
        let store = build(EVENTS, ARENA_MB, giant);
        let mut v = View::new();
        v.reset(&store);
        let cfg = Cfg::new();
        let mut frame = Frame::new();
        v.seek(&store, store.len() / 2);

        let scroll = 40_000.0; // viewport well below the top of the address space
        render::render_addr(&store, &mut v, &cfg, &mut frame, 1600, 900, scroll); // warm
        ROW_ITERS.store(0, Relaxed);
        ROW_SKIPPED.store(0, Relaxed);
        DRAW_LEN.store(0, Relaxed);

        let t0 = Instant::now();
        for _ in 0..ITERS {
            render::render_addr(&store, &mut v, &cfg, &mut frame, 1600, 900, scroll);
        }
        println!(
            "{:<24} {:>9.2} {:>11} {:>12} {:>10}",
            label,
            t0.elapsed().as_secs_f64() * 1000.0 / ITERS as f64,
            ROW_ITERS.load(Relaxed) / ITERS,
            ROW_SKIPPED.load(Relaxed) / ITERS,
            DRAW_LEN.load(Relaxed) / ITERS
        );
    }
}
