//! Wall-clock cost of the tag paths in `Store`, as a function of the highest
//! populated tag id.
//!
//! Native release, not WASM: absolute numbers are optimistic relative to the
//! browser, which is the point — a path that is slow here is slow there too.
//!
//! Not part of the crate — it lives here so E020's numbers are reproducible
//! without adding a bench target to `core/`. `tag_counts_json` is private, so
//! the recipe makes it public in the copy:
//!
//!     mkdir -p /tmp/hvt && cp -r src/core src/filter-dsl /tmp/hvt/
//!     rm -rf /tmp/hvt/core/target /tmp/hvt/filter-dsl/target
//!     sed -i '/^panic = "abort"$/d' /tmp/hvt/core/Cargo.toml
//!     sed -i 's/^fn tag_counts_json/pub fn tag_counts_json/' /tmp/hvt/core/src/lib.rs
//!     sed -i 's/pub(crate) tag_idx_dirty/pub tag_idx_dirty/' /tmp/hvt/core/src/store.rs
//!     mkdir -p /tmp/hvt/core/examples
//!     cp docs/explorations/E020-bench/tag_cost.rs /tmp/hvt/core/examples/
//!     cd /tmp/hvt/core && cargo run --release --example tag_cost
//!
//! The question each row answers: does cost track `U` (tags that actually hold
//! memberships) or `H` (the highest id ever used)? The current
//! `Store::tag_ids` scans `1..tag_members.len()`, so the prediction is `H`.
//! The `U=1, H=255` row is the discriminator: one tag, 255-wide outer vector.
//!
//! `block_tags` reports the statistic the proposed design rests on — distinct
//! tags present per 64-event block. If that is not small, the design does not
//! pay.

use heap_visualizer_core::parse::Parser;
use heap_visualizer_core::store::{Store, OP_M, OP_R};
use std::time::Instant;

const CREATORS: u64 = 500_000;
const ITERS: u32 = 5;

/// Creators interleaved with frees of an earlier allocation, so `N > C` and
/// the free-side paths are exercised — the tag bitsets are event-indexed, and
/// half of what they index cannot be tagged.
fn build(n: u64) -> Store {
    let mut s = String::from("{\"op\":\"H\",\"v\":1,\"row_bytes\":4096}\n");
    const LAG: u64 = 64;
    for i in 0..n {
        s.push_str(&format!(
            "{{\"op\":\"M\",\"id\":{},\"addr\":\"0x{:x}\",\"size\":{},\"t\":{}}}\n",
            i + 1,
            0x1000_0000u64 + (i * 4099) % (256 * 1024 * 1024),
            16 + i % 4096,
            i * 3,
        ));
        if i >= LAG {
            s.push_str(&format!(
                "{{\"op\":\"F\",\"id\":{},\"t\":{}}}\n",
                i - LAG + 1,
                i * 3 + 1,
            ));
        }
    }
    let mut p = Parser::new();
    p.chunk(s.as_bytes());
    p.finish();
    p.store
}

/// Every creator event index, in order.
fn creators(s: &Store) -> Vec<u32> {
    (0..s.len())
        .filter(|&e| {
            let op = s.op[e as usize];
            op == OP_M || op == OP_R
        })
        .collect()
}

/// `u` tags, each owning one contiguous run of creators — what "tag this
/// range" and "tag these filter matches" produce. Ids are spread so the
/// highest is `high`.
fn tag_clustered(s: &mut Store, c: &[u32], u: usize, high: u8) {
    let run = c.len() / u;
    for k in 0..u {
        let id = tag_id(k, u, high);
        for &e in &c[k * run..(k + 1) * run] {
            s.add_tag(e, id);
        }
    }
}

/// `u` tags assigned round-robin — every block holds every tag. The adversary
/// for any per-block index.
fn tag_scattered(s: &mut Store, c: &[u32], u: usize, high: u8) {
    for (i, &e) in c.iter().enumerate() {
        s.add_tag(e, tag_id(i % u, u, high));
    }
}

/// Spread `u` ids over `1..=high` so the outer vector is `high` wide.
fn tag_id(k: usize, u: usize, high: u8) -> u8 {
    if u == 1 {
        return high;
    }
    (1 + (k * (high as usize - 1)) / (u - 1)) as u8
}

fn med(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn time<F: FnMut()>(mut f: F) -> f64 {
    let mut ms = Vec::new();
    for _ in 0..ITERS {
        let t = Instant::now();
        f();
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    med(ms)
}

/// Distinct tags present per 64-event block: the `k` the proposed per-block
/// occupancy index would scan instead of `H`.
fn block_stats(s: &Store) -> (f64, usize) {
    let blocks = (s.len() as usize).div_ceil(64);
    let (mut total, mut max) = (0usize, 0usize);
    for b in 0..blocks {
        let mut n = 0usize;
        for t in 1..s.tag_members.len() {
            let bits = &s.tag_members[t];
            if b < bits.len() && bits[b] != 0 {
                n += 1;
            }
        }
        total += n;
        max = max.max(n);
    }
    (total as f64 / blocks as f64, max)
}

fn main() {
    let base = build(CREATORS);
    let c = creators(&base);
    println!(
        "{} events, {} creators, {} blocks of 64\n",
        base.len(),
        c.len(),
        (base.len() as usize).div_ceil(64)
    );

    println!(
        "{:<22} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
        "U tags / high id", "has_tags", "first_tag", "tag_ids", "counts", "tl index", "render"
    );
    println!("{}", "-".repeat(82));

    for &(u, high, scattered) in &[
        (1usize, 1u8, false),
        (8, 8, false),
        (32, 32, false),
        (255, 255, false),
        (1, 255, false),   // one tag, stale high id — H vs U discriminator
        (8, 8, true),      // same U, no locality
        (32, 32, true),
    ] {
        let mut s = build(CREATORS);
        if scattered {
            tag_scattered(&mut s, &c, u, high);
        } else {
            tag_clustered(&mut s, &c, u, high);
        }

        let mut sink = 0u64;
        let has = time(|| {
            for &e in &c {
                sink += s.has_tags(e) as u64;
            }
        });
        let first = time(|| {
            for &e in &c {
                sink += s.first_tag(e) as u64;
            }
        });
        let ids = time(|| {
            for &e in &c {
                sink += s.tag_ids(e).count() as u64;
            }
        });

        // The count refresh the worker triggers after every tag mutation.
        let mut out = String::new();
        let counts = time(|| heap_visualizer_core::tag_counts_json(&s, &mut out));

        // The timeline index rebuild, forced dirty each pass as a mutation
        // would leave it.
        let tl = time(|| {
            s.tag_idx_dirty = true;
            s.ensure_tag_index();
        });

        // What render.rs:735 does per drawn allocation: collect the membership
        // list, then discard it for the 0/1-tag case.
        let render = time(|| {
            for &e in &c {
                let tags: Vec<u8> = s.tag_ids(e).collect();
                sink += tags.len() as u64;
            }
        });

        let (mean_k, max_k) = block_stats(&s);
        println!(
            "{:<22} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>8.1}   k mean {:.2} max {}",
            format!("U={u} H={high}{}", if scattered { " scat" } else { "" }),
            has, first, ids, counts, tl, render, mean_k, max_k
        );
        std::hint::black_box(sink);
    }

    // First membership in a fresh tag: the zero-fill of one event-wide bitset.
    let mut s = build(CREATORS);
    let t = Instant::now();
    s.add_tag(c[0], 200);
    println!(
        "\nfirst membership in a new tag (one bitset zero-fill): {:.2} ms",
        t.elapsed().as_secs_f64() * 1000.0
    );
}
