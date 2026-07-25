//! Timeline strips: per-pixel-column event density, computed from prefix sums
//! so a full re-bin is O(width log n) regardless of trace size.
//!
//! kind 0 = temporal (x is t), kind 1 = sequential (x is seq).

use crate::render::{BG, GREEN, RED};
use crate::store::*;

const BASELINE: [u8; 3] = [0x30, 0x36, 0x3d];
const GREEN_DIM: [u8; 3] = [0x1c, 0x4a, 0x28];
const RED_DIM: [u8; 3] = [0x58, 0x2b, 0x28];

/// Event-index boundary for pixel column edge `c` of `w`, view [lo, hi).
fn boundary(s: &Store, kind: u32, w: u32, c: u32, lo: f64, hi: f64) -> u32 {
    let n = s.len();
    let v = lo + (hi - lo) * c as f64 / w as f64;
    if kind == 1 {
        (v.round().max(0.0) as u64).min(n as u64) as u32
    } else {
        // first event with t >= v
        if v <= s.t_min as f64 {
            0
        } else {
            let tv = v.ceil() as u64;
            s.lower_bound_t(tv)
        }
    }
}

pub struct Bins {
    pub g: Vec<u32>,
    pub r: Vec<u32>,
    pub from: Vec<u32>, // event-index boundaries, len w+1
}

pub fn bin(s: &Store, kind: u32, w: u32, lo: f64, hi: f64) -> Bins {
    let mut from = Vec::with_capacity(w as usize + 1);
    for c in 0..=w {
        from.push(boundary(s, kind, w, c, lo, hi));
    }
    let mut g = vec![0u32; w as usize];
    let mut r = vec![0u32; w as usize];
    for c in 0..w as usize {
        let (a, b) = (from[c] as usize, from[c + 1] as usize);
        g[c] = s.green_pre[b] - s.green_pre[a];
        r[c] = s.red_pre[b] - s.red_pre[a];
    }
    Bins { g, r, from }
}

/// Render a two-sided density strip: green (allocs) above the baseline,
/// red (frees) below, sqrt-scaled. Thin lanes mark tagged activity in the
/// tag color: along the top edge, columns where tagged allocations are
/// created (the alloc half); along the bottom edge, columns where tagged
/// allocations are freed (the free half).
pub fn render(
    s: &mut Store,
    cfg: &crate::render::Cfg,
    kind: u32,
    w: u32,
    h: u32,
    lo: f64,
    hi: f64,
    px: &mut Vec<u8>,
) {
    px.clear();
    px.resize((w * h * 4) as usize, 0);
    // background
    for i in 0..(w * h) as usize {
        px[i * 4] = BG[0];
        px[i * 4 + 1] = BG[1];
        px[i * 4 + 2] = BG[2];
        px[i * 4 + 3] = 255;
    }
    if s.len() == 0 || w == 0 || h < 6 {
        return;
    }
    let bins = bin(s, kind, w, lo, hi);
    let gmax = bins.g.iter().copied().max().unwrap_or(0).max(1) as f64;
    let rmax = bins.r.iter().copied().max().unwrap_or(0).max(1) as f64;
    let mid = (h / 2) as i64;
    let half = (h as i64 / 2 - 1).max(1) as f64;

    let mut put = |x: i64, y: i64, c: [u8; 3]| {
        if x >= 0 && y >= 0 && x < w as i64 && y < h as i64 {
            let p = ((y as u32 * w + x as u32) * 4) as usize;
            px[p] = c[0];
            px[p + 1] = c[1];
            px[p + 2] = c[2];
            px[p + 3] = 255;
        }
    };

    for x in 0..w as i64 {
        let gv = bins.g[x as usize] as f64;
        let rv = bins.r[x as usize] as f64;
        if gv > 0.0 {
            let bar = ((gv / gmax).sqrt() * half).ceil().max(1.0) as i64;
            for y in (mid - bar)..mid {
                let f = (mid - y) as f64 / half;
                put(x, y, if f > 0.85 { GREEN } else { blend(GREEN, GREEN_DIM, y, mid, bar) });
            }
        }
        if rv > 0.0 {
            let bar = ((rv / rmax).sqrt() * half).ceil().max(1.0) as i64;
            for y in (mid + 1)..(mid + 1 + bar) {
                put(x, y, blend(RED, RED_DIM, y, mid, bar));
            }
        }
        put(x, mid, BASELINE);
    }

    // --- tag lanes: creations on top, frees on the bottom ---
    // Untagged traces (the common case) skip this entirely. With tags, each
    // column is a binary search over the sorted tagged-event indexes instead
    // of a scan of every event in its bin, keeping the strip O(width log n)
    // like the density bars above it.
    if s.tagged == 0 {
        return;
    }
    s.ensure_tag_index();
    let (alloc_idx, free_idx) = (&s.tag_alloc_idx, &s.tag_free_idx);
    let lane = ((h / 14) as i64).clamp(2, 5);
    for x in 0..w as usize {
        let (a, b) = (bins.from[x], bins.from[x + 1]);
        // first tagged event in [a, b) of each kind, as before
        let i = alloc_idx.partition_point(|&e| e < a);
        let alloc_c = alloc_idx
            .get(i)
            .filter(|&&e| e < b)
            .map(|&e| cfg.tag_color(s.tag[e as usize]));
        let i = free_idx.partition_point(|&e| e < a);
        let free_c = free_idx
            .get(i)
            .filter(|&&e| e < b)
            .map(|&e| cfg.tag_color(s.tag[s.target[e as usize] as usize]));
        if let Some(c) = alloc_c {
            for y in 0..lane {
                put(x as i64, y, c);
            }
        }
        if let Some(c) = free_c {
            for y in (h as i64 - lane)..h as i64 {
                put(x as i64, y, c);
            }
        }
    }
}

/// Slight vertical gradient so tall bars stay readable: bright at baseline.
fn blend(bright: [u8; 3], dimc: [u8; 3], y: i64, mid: i64, bar: i64) -> [u8; 3] {
    let d = (y - mid).unsigned_abs() as f32 / bar.max(1) as f32;
    let f = 1.0 - d * 0.55;
    [
        (dimc[0] as f32 + (bright[0] as f32 - dimc[0] as f32) * f) as u8,
        (dimc[1] as f32 + (bright[1] as f32 - dimc[1] as f32) * f) as u8,
        (dimc[2] as f32 + (bright[2] as f32 - dimc[2] as f32) * f) as u8,
    ]
}

/// Hover info for pixel column x: counts + covered domain range, as JSON.
pub fn hover(s: &Store, kind: u32, w: u32, x: u32, lo: f64, hi: f64) -> String {
    if s.len() == 0 || w == 0 || x >= w {
        return "null".to_string();
    }
    let a = boundary(s, kind, w, x, lo, hi);
    let b = boundary(s, kind, w, x + 1, lo, hi);
    let g = s.green_pre[b as usize] - s.green_pre[a as usize];
    let r = s.red_pre[b as usize] - s.red_pre[a as usize];
    let v0 = lo + (hi - lo) * x as f64 / w as f64;
    let v1 = lo + (hi - lo) * (x + 1) as f64 / w as f64;
    format!(
        "{{\"g\":{},\"r\":{},\"from\":{},\"to\":{},\"seqFrom\":{},\"seqTo\":{}}}",
        g, r, v0, v1, a, b
    )
}
