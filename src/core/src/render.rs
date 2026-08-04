//! Address-line rasterizer: paints the live set into an RGBA buffer with
//! collapsed empty rows, plus pick (hover) queries and realloc move-links.

use std::fmt::Write as _;

use crate::json::push_json_str;
use crate::state::View;
use crate::store::*;

// NOTE: BG/CAT/RAMP are mirrored in src/web/main.ts (CAT/RAMP consts) for legend
// chips and filter swatches — keep the two in sync by hand.
pub const BG: [u8; 3] = [0x0d, 0x11, 0x17];
pub const ROW_BG: [u8; 3] = [0x16, 0x1b, 0x22];
pub const GAP_FG: [u8; 3] = [0x3d, 0x44, 0x4d];
pub const GREEN: [u8; 3] = [0x3f, 0xb9, 0x50];
pub const RED: [u8; 3] = [0xf8, 0x51, 0x49];
pub const OVERLAP: [u8; 3] = [0xff, 0x8c, 0x00];
pub const NO_TAG: [u8; 3] = [0x8b, 0x94, 0x9e];

pub const CAT: [[u8; 3]; 12] = [
    [0x58, 0xa6, 0xff],
    [0x3f, 0xb9, 0x50],
    [0xf2, 0xcc, 0x60],
    [0xff, 0x7b, 0x72],
    [0xbc, 0x8c, 0xff],
    [0x39, 0xc5, 0xcf],
    [0xf7, 0x78, 0xba],
    [0xd2, 0x99, 0x22],
    [0x7e, 0xe7, 0x87],
    [0xff, 0xa6, 0x57],
    [0x79, 0xc0, 0xff],
    [0xd2, 0xa8, 0xff],
];

// sequential ramp (GitHub-contribution greens), dark -> bright
const RAMP: [[u8; 3]; 4] = [
    [0x0e, 0x44, 0x29],
    [0x00, 0x6d, 0x32],
    [0x26, 0xa6, 0x41],
    [0x39, 0xd3, 0x53],
];
// age ramp: young bright green -> cyan -> old deep blue (ordered hues)
const AGE_RAMP: [[u8; 3]; 3] = [
    [0x7e, 0xe7, 0x87],
    [0x39, 0xc5, 0xcf],
    [0x1f, 0x4f, 0xa8],
];

pub const MODE_LIVE: u8 = 0;
pub const MODE_SITE: u8 = 1;
pub const MODE_THR: u8 = 2;
pub const MODE_SIZE: u8 = 3;
pub const MODE_AGE: u8 = 4;
pub const MODE_TAG: u8 = 5;

pub const FILTER_OFF: u8 = 0;
pub const FILTER_DIM: u8 = 1;
pub const FILTER_HIDE: u8 = 2;

/// How overlapping live allocations render where they share pixels.
pub const OVERLAP_HIGHLIGHT: u8 = 0; // flag shared pixels orange
pub const OVERLAP_IGNORE: u8 = 1; // latest-created allocation wins the pixel

/// Coverage-buffer bit marking a pixel already ghost-darkened (see
/// `Frame::fill_ghost`); the low bits below it stay a plain cover count.
const GHOST_MARK: u8 = 0x80;

#[derive(Default)]
pub struct Filter {
    pub mode: u8,
    /// Match bits for the applied E010 expression, indexed by creator event.
    /// `None` means the expression is empty/off.
    pub matches: Option<Vec<u64>>,
    /// bitmask over site indices; meaningful only when `sites_set` (an empty
    /// *set* bitmask, as opposed to an absent one, means "no site selected"
    /// — i.e. hide everything with a site).
    pub sites: Vec<u64>,
    pub sites_set: bool,
    /// bitmask over thread indices; see `sites_set`.
    pub thrs: Vec<u64>,
    pub thrs_set: bool,
    /// bitmask over tag ids (bit 0 = untagged); see `sites_set`.
    pub tags: Vec<u64>,
    pub tags_set: bool,
    pub size_min: u64,
    pub size_max: u64, // 0 = unbounded
    /// Address ranges [lo, hi): when non-empty, an allocation passes only if
    /// its rendered span intersects at least one range.
    pub addr_ranges: Vec<(u64, u64)>,
}

impl Filter {
    fn bit(words: &[u64], i: u32) -> bool {
        let w = (i / 64) as usize;
        w < words.len() && words[w] >> (i % 64) & 1 == 1
    }

    pub fn pass(&self, s: &Store, e: u32) -> bool {
        if self.mode == FILTER_OFF {
            return true;
        }
        if let Some(bits) = &self.matches {
            return Self::bit(bits, e);
        }
        let ei = e as usize;
        if self.sites_set {
            let site = s.site[ei];
            if site != NONE_U32 && !Self::bit(&self.sites, site) {
                return false;
            }
        }
        if self.thrs_set {
            let thr = s.thr_idx[ei];
            if thr != NONE_U16 && !Self::bit(&self.thrs, thr as u32) {
                return false;
            }
        }
        if self.tags_set {
            let passes = if s.has_tags(e) {
                s.tag_ids(e)
                    .any(|tag| Self::bit(&self.tags, tag as u32))
            } else {
                Self::bit(&self.tags, 0)
            };
            if !passes {
                return false;
            }
        }
        let sz = s.size[ei];
        if sz < self.size_min {
            return false;
        }
        if self.size_max > 0 && sz > self.size_max {
            return false;
        }
        if !self.addr_ranges.is_empty() {
            let a = s.addr[ei];
            let end = a + s.span(e);
            if !self.addr_ranges.iter().any(|&(lo, hi)| a < hi && end > lo) {
                return false;
            }
        }
        true
    }
}

/// Combined filter+crop visibility decision for creator event `e`: whether it
/// should be skipped entirely (`hide`) and/or rendered dimmed (`dim`). Crop
/// always dims, never hides, regardless of the filter's own dim/hide mode.
pub fn visibility(cfg: &Cfg, s: &Store, e: u32) -> (bool, bool) {
    let filter_pass = cfg.filter.pass(s, e);
    let cropped_out = matches!(cfg.crop, Some((lo, hi)) if e < lo || e >= hi);
    let hide = !filter_pass && cfg.filter.mode == FILTER_HIDE;
    let dim = !filter_pass || cropped_out;
    (hide, dim)
}

pub struct Cfg {
    pub row_px: u32,
    pub gap_px: u32,
    pub color_mode: u8,
    pub selected: u32,
    pub filter: Filter,
    /// Crop: creator events outside `[crop.0, crop.1)` are always *dimmed*
    /// (never hidden, independent of `filter.mode`) — set via hp_set_crop.
    /// Kept separate from `Filter` so it always renders the same way
    /// regardless of whatever dim/hide mode the Filter panel happens to be in.
    pub crop: Option<(u32, u32)>,
    /// Horizontal zoom on the byte axis of each row (1 = whole row visible).
    pub x_zoom: f64,
    /// Horizontal pan as a fraction of the row [0, 1 - 1/x_zoom].
    pub x_pan: f64,
    /// Emit allocation-size labels for allocations wide enough to fit text.
    pub size_labels: bool,
    /// User-chosen tag colors, indexed by tag id - 1; falls back to CAT.
    pub tag_colors: Vec<[u8; 3]>,
    /// Per-allocation color overrides (creator event -> rgb), any mode.
    pub overrides: std::collections::HashMap<u32, [u8; 3]>,
    /// How overlapping allocations render (OVERLAP_* above).
    pub overlap_mode: u8,
    /// Mark freed nested allocations: a recessed darker fill with divider
    /// edges where an allocation that lived inside a still-live one has been
    /// freed at the playhead, so its end stays visible inside the parent.
    pub ghosts: bool,
}

impl Cfg {
    pub fn new() -> Self {
        Cfg {
            row_px: 12,
            gap_px: 7,
            color_mode: MODE_LIVE,
            selected: NONE_U32,
            filter: Filter::default(),
            crop: None,
            x_zoom: 1.0,
            x_pan: 0.0,
            size_labels: true,
            tag_colors: Vec::new(),
            overrides: std::collections::HashMap::new(),
            overlap_mode: OVERLAP_HIGHLIGHT,
            ghosts: true,
        }
    }

    /// Horizontal mapping for a row of `rb` bytes drawn `w` px wide:
    /// (px per byte, pan offset in bytes). x = (offset - pan) * scale.
    pub fn x_map(&self, w: u32, rb: u64) -> (f64, f64) {
        let zoom = self.x_zoom.max(1.0);
        let scale = w as f64 * zoom / rb as f64;
        let pan = self.x_pan.clamp(0.0, 1.0 - 1.0 / zoom) * rb as f64;
        (scale, pan)
    }

    pub fn tag_color(&self, tag: u8) -> [u8; 3] {
        let i = tag as usize - 1;
        *self
            .tag_colors
            .get(i)
            .unwrap_or(&CAT[i % CAT.len()])
    }
}

pub struct Frame {
    pub px: Vec<u8>,
    pub cov: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

impl Frame {
    pub fn new() -> Self {
        Frame {
            px: Vec::new(),
            cov: Vec::new(),
            w: 0,
            h: 0,
        }
    }

    fn resize(&mut self, w: u32, h: u32) {
        self.w = w;
        self.h = h;
        self.px.resize((w * h * 4) as usize, 0);
        self.cov.clear();
        self.cov.resize((w * h) as usize, 0);
    }

    fn clear(&mut self, c: [u8; 3]) {
        if self.px.is_empty() {
            return;
        }
        // write one pixel, then double it with copy_within (memcpy speed)
        self.px[..4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        let mut filled = 4;
        while filled < self.px.len() {
            let n = filled.min(self.px.len() - filled);
            self.px.copy_within(..n, filled);
            filled += n;
        }
    }

    /// Plain fill (backgrounds, markers) — does not touch coverage.
    fn fill(&mut self, x0: i64, x1: i64, y0: i64, y1: i64, c: [u8; 3]) {
        let (x0, x1) = (x0.max(0) as usize, x1.min(self.w as i64).max(0) as usize);
        let (y0, y1) = (y0.max(0) as usize, y1.min(self.h as i64).max(0) as usize);
        if x1 <= x0 {
            return;
        }
        let w = self.w as usize;
        let pat = [c[0], c[1], c[2], 255];
        for y in y0..y1 {
            let row = &mut self.px[(y * w + x0) * 4..(y * w + x1) * 4];
            for px in row.chunks_exact_mut(4) {
                px.copy_from_slice(&pat);
            }
        }
    }

    /// Allocation fill. Coverage (and therefore the overlap handling) is
    /// only tracked on pixels *fully* covered by the byte range — `c0..c1` —
    /// so two adjacent allocations sharing an edge pixel are not falsely
    /// flagged as overlapping. `overlap_mode` decides what happens where a
    /// covered pixel is painted again (see the OVERLAP_* constants).
    fn fill_alloc(
        &mut self,
        x0: i64,
        x1: i64,
        c0: i64,
        c1: i64,
        y0: i64,
        y1: i64,
        c: [u8; 3],
        overlap_mode: u8,
    ) {
        let (x0, x1) = (x0.max(0) as usize, x1.min(self.w as i64).max(0) as usize);
        let (y0, y1) = (y0.max(0) as usize, y1.min(self.h as i64).max(0) as usize);
        let (c0, c1) = (c0.max(0) as usize, c1.min(self.w as i64).max(0) as usize);
        if x1 <= x0 {
            return;
        }
        let w = self.w as usize;
        for y in y0..y1 {
            let base = y * w;
            let cov = &mut self.cov[base + x0..base + x1];
            let px = &mut self.px[(base + x0) * 4..(base + x1) * 4];
            let mut x = x0;
            for (p, cv) in px.chunks_exact_mut(4).zip(cov.iter_mut()) {
                let core = x >= c0 && x < c1;
                x += 1;
                if core && *cv != 0 {
                    // count covers (capped below GHOST_MARK) so the ghost
                    // pass can tell "outer only" from "outer + live inner"
                    *cv = (*cv + 1).min(GHOST_MARK - 1);
                    if overlap_mode == OVERLAP_IGNORE {
                        // draw order is creation order, so the latest-created
                        // allocation wins the pixel
                        p[0] = c[0];
                        p[1] = c[1];
                        p[2] = c[2];
                    } else {
                        p[0] = OVERLAP[0];
                        p[1] = OVERLAP[1];
                        p[2] = OVERLAP[2];
                    }
                } else {
                    if core {
                        *cv = 1;
                    }
                    p[0] = c[0];
                    p[1] = c[1];
                    p[2] = c[2];
                }
                p[3] = 255;
            }
        }
    }

    /// Slack (usable-beyond-requested) fill: background-ish, never covers or
    /// overwrites real allocation pixels.
    fn fill_slack(&mut self, x0: i64, x1: i64, y0: i64, y1: i64, c: [u8; 3]) {
        let (x0, x1) = (x0.max(0) as usize, x1.min(self.w as i64).max(0) as usize);
        let (y0, y1) = (y0.max(0) as usize, y1.min(self.h as i64).max(0) as usize);
        if x1 <= x0 {
            return;
        }
        let w = self.w as usize;
        let pat = [c[0], c[1], c[2], 255];
        for y in y0..y1 {
            let base = y * w;
            let cov = &self.cov[base + x0..base + x1];
            let px = &mut self.px[(base + x0) * 4..(base + x1) * 4];
            for (p, &cv) in px.chunks_exact_mut(4).zip(cov.iter()) {
                if cv == 0 {
                    p.copy_from_slice(&pat);
                }
            }
        }
    }

    /// Recessed "ghost" fill marking a freed allocation nested inside a live
    /// one: darkens pixels the parent alone covers (skipping any live nested
    /// allocation, cov >= 2) and cuts stronger divider edges along the
    /// region's sides, so an ended allocation stays readable inside its
    /// parent instead of merging into it. Idempotent via GHOST_MARK, so many
    /// dead generations at one address darken the slot once, not to black.
    fn fill_ghost(&mut self, x0: i64, x1: i64, y0: i64, y1: i64) {
        let (x0, x1) = (x0.max(0) as usize, x1.min(self.w as i64).max(0) as usize);
        let (y0, y1) = (y0.max(0) as usize, y1.min(self.h as i64).max(0) as usize);
        if x1 <= x0 {
            return;
        }
        let w = self.w as usize;
        let n = x1 - x0;
        for y in y0..y1 {
            let base = y * w;
            let cov = &mut self.cov[base + x0..base + x1];
            let px = &mut self.px[(base + x0) * 4..(base + x1) * 4];
            for (i, (p, cv)) in px.chunks_exact_mut(4).zip(cov.iter_mut()).enumerate() {
                let c = *cv;
                if c & GHOST_MARK != 0 || c & !GHOST_MARK >= 2 {
                    // already ghosted (overlapping dead generations darken a
                    // slot once), or a live nested allocation owns the pixel
                    continue;
                }
                *cv = c | GHOST_MARK;
                let edge = i == 0 || i + 1 == n;
                for k in 0..3 {
                    let v = p[k] as u32;
                    p[k] = if edge { v * 2 / 5 } else { v * 3 / 5 } as u8;
                }
            }
        }
    }

    /// 1-px divider seam at an allocation's start edge: darkens whatever was
    /// painted there so adjacent allocations stay separable even when their
    /// fill colors are identical.
    fn seam(&mut self, x: i64, y0: i64, y1: i64) {
        if x < 0 || x >= self.w as i64 {
            return;
        }
        let x = x as usize;
        let (y0, y1) = (y0.max(0) as usize, y1.min(self.h as i64).max(0) as usize);
        for y in y0..y1 {
            let p = (y * self.w as usize + x) * 4;
            for k in 0..3 {
                self.px[p + k] = (self.px[p + k] as u32 * 2 / 5) as u8;
            }
        }
    }

    fn outline(&mut self, x0: i64, x1: i64, y0: i64, y1: i64, c: [u8; 3]) {
        self.fill(x0, x1, y0 - 1, y0, c);
        self.fill(x0, x1, y1, y1 + 1, c);
        self.fill(x0 - 1, x0, y0 - 1, y1 + 1, c);
        self.fill(x1, x1 + 1, y0 - 1, y1 + 1, c);
    }
}

fn lerp(a: [u8; 3], b: [u8; 3], f: f32) -> [u8; 3] {
    let f = f.clamp(0.0, 1.0);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * f) as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * f) as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * f) as u8,
    ]
}

fn ramp(f: f32) -> [u8; 3] {
    let f = f.clamp(0.0, 1.0) * 3.0;
    let i = (f as usize).min(2);
    lerp(RAMP[i], RAMP[i + 1], f - i as f32)
}

pub fn dim(c: [u8; 3]) -> [u8; 3] {
    lerp(ROW_BG, c, 0.22)
}

fn lerp3(stops: &[[u8; 3]; 3], f: f32) -> [u8; 3] {
    let f = f.clamp(0.0, 1.0) * 2.0;
    let i = (f as usize).min(1);
    lerp(stops[i], stops[i + 1], f - i as f32)
}

/// Base fill color for a live allocation created at event `e`. `age_norm` is
/// 1/ln(1 + oldest_live_age), precomputed per frame for MODE_AGE.
pub fn alloc_color(s: &Store, cfg: &Cfg, e: u32, cur_t: u64, age_norm: f64) -> [u8; 3] {
    if let Some(&c) = cfg.overrides.get(&e) {
        return c;
    }
    let ei = e as usize;
    match cfg.color_mode {
        MODE_SITE => {
            let site = s.site[ei];
            if site == NONE_U32 {
                NO_TAG
            } else {
                CAT[site as usize % CAT.len()]
            }
        }
        MODE_THR => {
            let thr = s.thr_idx[ei];
            if thr == NONE_U16 {
                NO_TAG
            } else {
                CAT[(thr as usize + 5) % CAT.len()]
            }
        }
        MODE_SIZE => {
            // log2(size) mapped over 4..=24 bits
            let bits = 64 - s.size[ei].max(1).leading_zeros();
            ramp((bits.saturating_sub(4)) as f32 / 20.0)
        }
        MODE_AGE => {
            // log-normalized against the oldest live allocation, so the ramp
            // spreads usefully whether ages span nanoseconds or minutes
            let age = cur_t.saturating_sub(s.t[ei]) as f64;
            let f = ((1.0 + age).ln() * age_norm) as f32;
            lerp3(&AGE_RAMP, f)
        }
        MODE_TAG => {
            let tag = s.first_tag(e);
            if tag == 0 {
                [0x39, 0x41, 0x4a] // untagged: recede
            } else {
                cfg.tag_color(tag)
            }
        }
        _ => GREEN,
    }
}

/// Per-frame normalizer for MODE_AGE: 1/ln(1 + oldest live age). O(log n)
/// via the View's incrementally maintained birth-time multiset.
pub fn age_normalizer(_s: &Store, v: &crate::state::View, cur_t: u64) -> f64 {
    let min_birth = match v.min_live_birth() {
        Some(b) => b,
        None => return 0.0,
    };
    let max_age = cur_t.saturating_sub(min_birth) as f64;
    let d = (1.0 + max_age).ln();
    if d > 0.0 {
        1.0 / d
    } else {
        0.0
    }
}

/// Reusable per-frame containers for `render_addr` — cleared each frame, so
/// steady-state rendering allocates nothing once capacities settle.
#[derive(Default)]
pub struct RenderScratch {
    /// JSON array of label records for the JS layer to draw as text.
    pub labels: String,
    draw: Vec<(u32, u64, bool)>,
    seams: Vec<(u32, u64, i64, i64, i64)>,
    texts: Vec<(u32, u64, u64, i64, i64, i64)>,
    covered: std::collections::BTreeMap<u64, u64>,
}

/// Whether the collapsed rows strictly between display rows `ra` and `rb` are
/// covered end to end by one live allocation. True only for allocations wider
/// than `View`'s span cap, whose middle rows are left out of the layout even
/// though they are entirely inside the allocation.
fn inside_one_alloc(s: &Store, v: &crate::state::View, ra: u64, rb: u64) -> bool {
    let rb_bytes = v.row_bytes;
    let gap_start = v.base + (ra + 1) * rb_bytes;
    let gap_end = v.base + rb * rb_bytes;
    let floor = gap_start.saturating_sub(v.max_live_span().max(1));
    v.live
        .range((floor, 0)..=(gap_start, u32::MAX))
        .rev()
        .any(|&(a, e)| a <= gap_start && a + s.span(e) >= gap_end)
}

/// Render the address-line into `frame`. `scroll` is the virtual-y offset in
/// px. Labels land in `scratch.labels` (a JSON array).
pub fn render_addr(
    s: &Store,
    v: &mut View,
    cfg: &Cfg,
    frame: &mut Frame,
    scratch: &mut RenderScratch,
    w: u32,
    h: u32,
    scroll: f64,
) {
    v.ensure_rows();
    frame.resize(w, h);
    frame.clear(BG);
    let RenderScratch {
        labels,
        draw,
        seams,
        texts,
        covered,
    } = scratch;
    labels.clear();
    labels.push('[');
    draw.clear();
    seams.clear();
    texts.clear();
    covered.clear();

    if v.rows.is_empty() || w == 0 || h == 0 {
        labels.push(']');
        return;
    }

    let row_px = cfg.row_px;
    let gap_px = cfg.gap_px;
    let scroll = scroll.max(0.0) as u64;
    let view_lo = scroll;

    // --- pass 1: row backgrounds, gap markers, labels ---
    // first visible display row
    let mut lo_i = match v.row_at_y(view_lo, row_px, gap_px) {
        Some(i) => i,
        None => {
            // in a gap or above: binary search first row with y+row_px > view_lo
            let mut lo = 0usize;
            let mut hi = v.rows.len();
            while lo < hi {
                let mid = (lo + hi) / 2;
                if v.row_y(mid, row_px, gap_px) + row_px as u64 <= view_lo {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            lo
        }
    };
    if lo_i > 0 {
        lo_i -= 1; // include one above for gap markers
    }
    let label_step = ((12 + row_px - 1) / row_px).max(1) as usize;
    let mut first = true;
    for i in lo_i..v.rows.len() {
        let y = v.row_y(i, row_px, gap_px) as i64 - scroll as i64;
        if y >= h as i64 {
            break;
        }
        // gap marker between previous row and this one
        if i > 0 && v.gaps_before[i] > v.gaps_before[i - 1] {
            let gy = y - gap_px as i64 + gap_px as i64 / 2;
            let mut x = 2i64;
            while x < w as i64 {
                frame.fill(x, x + 4, gy, gy + 1, GAP_FG);
                x += 9;
            }
            let skipped_rows = v.rows[i] - v.rows[i - 1] - 1;
            // A single allocation larger than the layout's span cap only
            // occupies its first and last rows, so the rows between them
            // collapse into a gap even though they are entirely *inside* that
            // allocation. Say so, instead of "N skipped" — which reads as
            // "nothing here" when it is the opposite.
            let inside = inside_one_alloc(s, v, v.rows[i - 1], v.rows[i]);
            if !first {
                labels.push(',');
            }
            first = false;
            let _ = write!(
                labels,
                "{{\"k\":1,\"y\":{},\"bytes\":{},\"inside\":{}}}",
                gy,
                (skipped_rows as u128 * v.row_bytes as u128) as f64,
                inside
            );
        }
        // row background
        frame.fill(0, w as i64, y, y + row_px as i64 - 1, ROW_BG);
        if i % label_step == 0 {
            if !first {
                labels.push(',');
            }
            first = false;
            let addr = v.base + v.rows[i] * v.row_bytes;
            let _ = write!(labels, "{{\"k\":0,\"y\":{},\"addr\":\"0x{:x}\"}}", y, addr);
        }
    }

    // --- pass 2: allocations (live set walk, lockstep with rows) ---
    let cur_t = s.t_at(v.cur);
    let age_norm = if cfg.color_mode == MODE_AGE {
        age_normalizer(s, v, cur_t)
    } else {
        0.0
    };
    let rb = v.row_bytes;
    let (scale, pan) = cfg.x_map(w, rb);
    // size labels: drawn by the JS layer, emitted only where they can fit
    let label_sizes = cfg.size_labels && row_px >= 9;
    let mut n_size_labels = 0u32;
    // visible display-row index range, for placing each label on the middle
    // visible line of a multi-row allocation
    let (vis_lo, vis_hi) = {
        let n_rows = v.rows.len();
        let mut lo = 0usize;
        let mut hi = n_rows;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if v.row_y(mid, row_px, gap_px) + row_px as u64 <= scroll {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let first = lo;
        let bottom = scroll + h as u64;
        let mut lo = 0usize;
        let mut hi = n_rows;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if v.row_y(mid, row_px, gap_px) < bottom {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        (first, lo.saturating_sub(1))
    };
    if vis_lo >= v.rows.len() || vis_lo > vis_hi {
        labels.push(']');
        return;
    }
    // Bound the live-set walk to allocations that can touch the visible rows:
    // start max_span below the first visible row's address (like `pick`) and
    // stop at the last visible row's end. O(visible + log live) instead of a
    // full O(live) scan every frame.
    let addr_lo = v.base + v.rows[vis_lo] * rb;
    let addr_hi = v
        .base
        .saturating_add(v.rows[vis_hi].saturating_add(1).saturating_mul(rb));
    // Walk-back bound: the widest *currently live* allocation, not
    // Store::max_span — that global only grows, so one early wide allocation
    // would tax every frame for the rest of the session.
    let floor = addr_lo.saturating_sub(v.max_live_span().max(1));
    // Draw in creation order, not address order: where live allocations
    // overlap (nesting), the latest-created one is drawn last and wins the
    // shared pixels — matching picking, which also prefers the newest.
    for &(a, e) in v.live.range((floor, 0)..(addr_hi, 0)) {
        let (hide, dim_it) = visibility(cfg, s, e);
        if !hide {
            draw.push((e, a, dim_it));
        }
    }
    draw.sort_unstable();
    // Divider seams at allocation start edges, applied after the whole draw
    // loop so a later-created neighbor's fill (edge pixels can overlap by one
    // due to the ceil on x1) cannot paint the boundary away. Only the topmost
    // allocation at each start address gets its seam — a start buried under a
    // later-created overlap is not a visible boundary. Size-label candidates
    // (texts: e, addr range under the visible text span, x, y, w) are
    // deferred the same way: a label is emitted only if no later-created
    // allocation covers any part of the span the JS layer may draw text in.
    for &(e, a, dim_it) in draw.iter() {
        let pass = !dim_it;
        let span = s.span(e);
        let size = s.size[e as usize].max(1).min(span);
        let end = a + span;
        let r0 = (a - v.base) / rb;
        let r1 = (end - 1 - v.base) / rb;
        let j = v.rows.partition_point(|&r| r < r0);
        if j >= v.rows.len() {
            continue;
        }
        let mut color = alloc_color(s, cfg, e, cur_t, age_norm);
        if !pass {
            color = dim(color);
        }
        let slack_color = lerp(ROW_BG, color, 0.35);
        // Keep every membership visible: one tag uses the traditional solid
        // stripe; overlapping tags split it into adjacent color segments.
        let tags: Vec<u8> = s.tag_ids(e).collect();
        let stripes = if !tags.is_empty()
            && (cfg.color_mode != MODE_TAG || tags.len() > 1)
            && pass
        {
            tags
        } else {
            Vec::new()
        };

        // label the middle visible line of the allocation (rounded to the top)
        let label_target = if label_sizes {
            let j_end = match v.rows.binary_search(&r1) {
                Ok(i) => i,
                Err(i) => i.saturating_sub(1),
            };
            let lo = j.max(vis_lo);
            let hi = j_end.min(vis_hi);
            if lo <= hi { Some(lo + (hi - lo) / 2) } else { None }
        } else {
            None
        };
        // start at the first *visible* row — walking up from the allocation's
        // first row is O(rows above the viewport) for a large allocation
        let mut idx = j.max(vis_lo);
        while idx < v.rows.len() && v.rows[idx] <= r1 {
            let r = v.rows[idx];
            let cur_idx = idx;
            let y = v.row_y(idx, row_px, gap_px) as i64 - scroll as i64;
            idx += 1;
            if y + (row_px as i64) < 0 || y >= h as i64 {
                if y >= h as i64 {
                    break;
                }
                continue;
            }
            let row_start = v.base + r * rb;
            let lo = a.max(row_start);
            let hi = end.min(row_start + rb);
            if hi <= lo {
                continue;
            }
            let x0 = (((lo - row_start) as f64 - pan) * scale) as i64;
            let mut x1 = ((((hi - row_start) as f64 - pan) * scale)).ceil() as i64;
            if x1 <= x0 {
                x1 = x0 + 1;
            }
            if x1 <= 0 || x0 >= w as i64 {
                continue; // panned/zoomed out of the horizontal window
            }
            let y1 = y + row_px as i64 - 1;
            // seam only on the row holding the true start, and only when the
            // allocation is wide enough that a body remains beside the line
            if a >= row_start && x1 - x0 >= 2 {
                seams.push((e, a, x0, y, y1));
            }
            // requested part vs slack band
            let req_end = (a + size).min(hi).max(lo);
            let xm = if req_end >= hi {
                x1
            } else if req_end <= lo {
                x0
            } else {
                ((((req_end - row_start) as f64 - pan) * scale) as i64).clamp(x0, x1)
            };
            if xm > x0 {
                // fully covered pixels of the requested part
                let c0 = (((lo - row_start) as f64 - pan) * scale).ceil() as i64;
                let c1 = (((req_end - row_start) as f64 - pan) * scale).floor() as i64;
                frame.fill_alloc(x0, xm, c0, c1, y, y1, color, cfg.overlap_mode);
            }
            if x1 > xm {
                frame.fill_slack(xm, x1, y, y1, slack_color);
            }
            if !stripes.is_empty() {
                let sh = (row_px as i64 / 4).clamp(1, 3);
                let width = x1 - x0;
                for (i, &tag) in stripes.iter().enumerate() {
                    let sx0 = x0 + width * i as i64 / stripes.len() as i64;
                    let sx1 = x0 + width * (i as i64 + 1) / stripes.len() as i64;
                    frame.fill(sx0, sx1.max(sx0 + 1), y1 - sh, y1, cfg.tag_color(tag));
                }
            }
            // in-allocation label on the middle visible segment; the JS layer
            // picks "name · size" / name / size by what actually fits (it
            // knows the names and measures the text)
            if label_target == Some(cur_idx) {
                let vx0 = x0.max(0);
                let vw = x1.min(w as i64) - vx0;
                if vw >= 18 {
                    let a_lo = lo.max(row_start + (pan + vx0 as f64 / scale) as u64);
                    let a_hi =
                        hi.min(row_start + (pan + (vx0 + vw) as f64 / scale).ceil() as u64);
                    texts.push((e, a_lo, a_hi, vx0, y, vw));
                }
            }
            if e == cfg.selected {
                frame.outline(x0, x1, y, y1, [0xff, 0xff, 0xff]);
            }
        }
    }
    // Topmost check: walk the draw list newest-first keeping a merged set of
    // address ranges already covered by later-created allocations; a seam is
    // drawn (and a size label emitted) only if not under any of them. Both
    // lists were collected in draw order (ascending event), so they zip.
    if !seams.is_empty() || !texts.is_empty() {
        let mut k = seams.len();
        let mut t = texts.len();
        for &(e, a, _) in draw.iter().rev() {
            if k > 0 && seams[k - 1].0 == e {
                k -= 1;
                let (_, sa, x, y0, y1) = seams[k];
                let buried = covered
                    .range(..=sa)
                    .next_back()
                    .is_some_and(|(_, &end)| end > sa);
                if !buried {
                    frame.seam(x, y0, y1);
                }
            }
            if t > 0 && texts[t - 1].0 == e {
                t -= 1;
                let (_, a_lo, a_hi, vx0, y, vw) = texts[t];
                let hidden = covered
                    .range(..a_hi)
                    .next_back()
                    .is_some_and(|(_, &end)| end > a_lo);
                if !hidden && n_size_labels < 400 {
                    if !first {
                        labels.push(',');
                    }
                    first = false;
                    let _ = write!(
                        labels,
                        "{{\"k\":2,\"x\":{},\"y\":{},\"w\":{},\"e\":{},\"size\":{}}}",
                        vx0,
                        y,
                        vw,
                        e,
                        s.size[e as usize]
                    );
                    n_size_labels += 1;
                }
            }
            // insert [a, a + span) into the set, merging what it touches
            let mut s0 = a;
            let mut s1 = a + s.span(e);
            if let Some((&ps, &pe)) = covered.range(..=s0).next_back() {
                if pe >= s0 {
                    covered.remove(&ps);
                    s0 = ps;
                    s1 = s1.max(pe);
                }
            }
            while let Some((&ns, &ne)) = covered.range(s0..=s1).next() {
                covered.remove(&ns);
                s1 = s1.max(ne);
            }
            covered.insert(s0, s1);
        }
    }

    // --- pass 3: ghosts — allocations that ended *inside* a live one ---
    // A free normally shows as the region emptying; nested inside a live
    // parent it would be invisible, so the freed range gets a recessed
    // darker fill with divider edges. Candidates come from the load-time
    // overlap index (only creators that overlapped something live at birth),
    // so traces without nesting skip this entirely.
    if cfg.ghosts && !s.overlap_index.is_empty() {
        // scan cap: heavy same-address churn cannot stall a frame — worst
        // case some ghosts at the bottom of the viewport go undrawn
        let mut budget = 20_000u32;
        'ghosts: for &(a, e) in v.live.range((floor, 0)..(addr_hi, 0)) {
            let (hide, _) = visibility(cfg, s, e);
            if hide {
                continue;
            }
            let end = a + s.span(e);
            // dead creators fully inside [a, end) and born after `e` — truly
            // nested in this allocation, not an earlier tenant of reused
            // address space (those died before `e` existed and mean nothing
            // inside it)
            let from = s.overlap_index.partition_point(|&(ga, _)| ga < a);
            for &(ga, g) in &s.overlap_index[from..] {
                if ga >= end {
                    break;
                }
                if budget == 0 {
                    break 'ghosts;
                }
                budget -= 1;
                if g <= e {
                    continue;
                }
                let d = s.death[g as usize];
                if d == NONE_U32 || d >= v.cur {
                    continue; // still live (or never freed): not a ghost
                }
                let gspan = s.span(g);
                let gend = ga + gspan;
                if gend > end {
                    continue; // partial overlap: corruption, not nesting
                }
                let gr0 = (ga - v.base) / rb;
                let gr1 = (gend - 1 - v.base) / rb;
                let mut idx = match v.rows.binary_search(&gr0) {
                    Ok(i) => i,
                    Err(i) => i,
                };
                // clip to the visible range, same as the allocation pass
                idx = idx.max(vis_lo);
                while idx < v.rows.len() && v.rows[idx] <= gr1 {
                    let r = v.rows[idx];
                    let y = v.row_y(idx, row_px, gap_px) as i64 - scroll as i64;
                    idx += 1;
                    if y >= h as i64 {
                        break;
                    }
                    if y + (row_px as i64) < 0 {
                        continue;
                    }
                    let row_start = v.base + r * rb;
                    let lo = ga.max(row_start);
                    let hi = gend.min(row_start + rb);
                    if hi <= lo {
                        continue;
                    }
                    let x0 = (((lo - row_start) as f64 - pan) * scale) as i64;
                    let mut x1 = ((((hi - row_start) as f64 - pan) * scale)).ceil() as i64;
                    if x1 <= x0 {
                        x1 = x0 + 1;
                    }
                    if x1 <= 0 || x0 >= w as i64 {
                        continue;
                    }
                    frame.fill_ghost(x0, x1, y, y + row_px as i64 - 1);
                }
            }
        }
    }
    labels.push(']');
}

/// Hit-test the address-line at canvas (x, y) given scroll; returns JSON.
pub fn pick(
    s: &Store,
    v: &mut View,
    cfg: &Cfg,
    w: u32,
    x: u32,
    y: f64,
    scroll: f64,
) -> String {
    v.ensure_rows();
    let y_virt = (y + scroll).max(0.0) as u64;
    let i = match v.row_at_y(y_virt, cfg.row_px, cfg.gap_px) {
        Some(i) => i,
        None => return "null".to_string(),
    };
    let row_start = v.base + v.rows[i] * v.row_bytes;
    let (scale, pan) = cfg.x_map(w, v.row_bytes);
    let addr_at = row_start + ((pan + x as f64 / scale) as u64).min(v.row_bytes - 1);

    // scan live allocs whose start is <= addr_at; when several cover the
    // address (overlap/nesting), the *most recently created* one wins — it
    // is the allocation conceptually on top, and picking by address order
    // instead would make the enclosing block shadow everything inside it
    let floor = addr_at.saturating_sub(s.max_span.max(1));
    let mut found: Option<(u64, u32)> = None;
    for &(a, e) in v.live.range((floor, 0)..=(addr_at, u32::MAX)) {
        if a + s.span(e) > addr_at && found.map_or(true, |(_, fe)| e > fe) {
            found = Some((a, e));
        }
    }
    let (a, e) = match found {
        Some(f) => f,
        None => return "null".to_string(),
    };
    alloc_info(s, v, cfg, w, a, e, scroll)
}

/// Info JSON for the allocation created at event `e` based at `a` — the
/// payload behind hover tooltips, the detail panel, and step readouts.
pub fn alloc_info(
    s: &Store,
    v: &mut View,
    cfg: &Cfg,
    w: u32,
    a: u64,
    e: u32,
    scroll: f64,
) -> String {
    v.ensure_rows();
    let ei = e as usize;
    let mut out = String::with_capacity(512);
    out.push_str(&format!(
        "{{\"e\":{},\"id\":{},\"addr\":\"0x{:x}\",\"end\":\"0x{:x}\",\"size\":{},\"usable\":{}",
        e,
        s.id[ei],
        a,
        a + s.size[ei],
        s.size[ei],
        s.usable_at(e)
    ));
    out.push_str(",\"site\":");
    if s.site[ei] != NONE_U32 {
        push_json_str(&mut out, &s.sites[s.site[ei] as usize]);
        out.push_str(&format!(",\"siteIdx\":{}", s.site[ei]));
    } else {
        out.push_str("null");
    }
    out.push_str(",\"thr\":");
    if s.thr_idx[ei] != NONE_U16 {
        out.push_str(&format!("{}", s.thrs[s.thr_idx[ei] as usize]));
    } else {
        out.push_str("null");
    }
    let birth_t = s.t[ei];
    let cur_t = s.t_at(v.cur);
    out.push_str(&format!(
        ",\"seq\":{},\"t\":{},\"age\":{},\"op\":{},\"tags\":[",
        e,
        birth_t as f64,
        cur_t.saturating_sub(birth_t) as f64,
        s.op[ei]
    ));
    for (i, tag) in s.tag_ids(e).enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{tag}");
    }
    out.push(']');
    let death = s.death[ei];
    if death != NONE_U32 {
        out.push_str(&format!(
            ",\"deathSeq\":{},\"deathT\":{}",
            death, s.t[death as usize] as f64
        ));
    } else {
        out.push_str(",\"deathSeq\":null");
    }
    if s.stack_at(e) != NONE_U32 {
        out.push_str(",\"stack\":");
        push_json_str(&mut out, &s.stacks[s.stack_at(e) as usize]);
    }
    if s.extra_at(e) != NONE_U32 {
        out.push_str(",\"extra\":{");
        out.push_str(&s.extras[s.extra_at(e) as usize]);
        out.push('}');
    }
    // The record that freed it describes the same allocation, so its custom
    // fields belong in the same section — kept separate here because the two
    // sides are addressed differently by the filter language (`field.k` vs
    // `death.field.k`), and the panel needs to know which row is which.
    if death != NONE_U32 && s.extra_at(death) != NONE_U32 {
        out.push_str(",\"deathExtra\":{");
        out.push_str(&s.extras[s.extra_at(death) as usize]);
        out.push('}');
    }
    // highlight rects across visible rows
    out.push_str(",\"rects\":[");
    let rects = region_rects(s, v, cfg, w, a, s.span(e), scroll, 32);
    out.push_str(&rects);
    out.push_str("]}");
    out
}

/// Rects (canvas coords) covering region [a, a+span) across laid-out rows.
fn region_rects(
    _s: &Store,
    v: &View,
    cfg: &Cfg,
    w: u32,
    a: u64,
    span: u64,
    scroll: f64,
    max: usize,
) -> String {
    let rb = v.row_bytes;
    let (scale, pan) = cfg.x_map(w, rb);
    let end = a + span.max(1);
    let r0 = (a.saturating_sub(v.base)) / rb;
    let r1 = (end - 1).saturating_sub(v.base) / rb;
    let mut out = String::new();
    let mut idx = match v.rows.binary_search(&r0) {
        Ok(i) => i,
        Err(i) => i,
    };
    let mut n = 0;
    while idx < v.rows.len() && v.rows[idx] <= r1 && n < max {
        let r = v.rows[idx];
        let y = v.row_y(idx, cfg.row_px, cfg.gap_px) as f64 - scroll;
        let row_start = v.base + r * rb;
        let lo = a.max(row_start);
        let hi = end.min(row_start + rb);
        idx += 1;
        if hi <= lo {
            continue;
        }
        let x0 = ((lo - row_start) as f64 - pan) * scale;
        let x1 = (((hi - row_start) as f64 - pan) * scale).max(x0 + 1.0);
        if x1 <= 0.0 || x0 >= w as f64 {
            continue;
        }
        if n > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{}}}",
            x0,
            y,
            x1 - x0,
            cfg.row_px.max(1) - 1
        ));
        n += 1;
    }
    out
}

/// Highlight rects (JSON array, canvas coords) for the allocation event `e`
/// touches — the creator itself for M/R, the freed allocation for F. Used to
/// flash the exact location of an event picked from the event list.
pub fn event_rects(s: &Store, v: &mut View, cfg: &Cfg, w: u32, e: u32, scroll: f64) -> String {
    if e >= s.len() {
        return "[]".to_string();
    }
    let ei = e as usize;
    let creator = match s.op[ei] {
        OP_F => s.target[ei],
        // a custom event marks no region of the map
        OP_E => return "[]".to_string(),
        _ => e,
    };
    if creator == NONE_U32 {
        return "[]".to_string();
    }
    v.ensure_rows();
    format!(
        "[{}]",
        region_rects(s, v, cfg, w, s.addr[creator as usize], s.span(creator), scroll, 16)
    )
}

/// Emit link/flash geometry for the most recently applied event: R draws a
/// move link, F flashes the freed region, M outlines the fresh allocation.
pub fn move_link(s: &Store, v: &mut View, cfg: &Cfg, w: u32, scroll: f64) -> String {
    if v.cur == 0 {
        return "null".to_string();
    }
    let e = v.cur - 1;
    let ei = e as usize;
    let op = s.op[ei];
    v.ensure_rows();
    let mut out = String::from("{");
    out.push_str(&format!("\"op\":{},\"seq\":{}", op, e));
    if op == OP_E {
        // nothing moved, nothing was freed: a landmark draws no link
        out.push_str(",\"old\":[],\"new\":[]}");
        return out;
    }
    if op == OP_M {
        out.push_str(",\"old\":[],\"new\":[");
        out.push_str(&region_rects(s, v, cfg, w, s.addr[ei], s.span(e), scroll, 4));
        out.push(']');
    } else if op == OP_R {
        let (oa, os) = s.old_geom_at(e);
        out.push_str(",\"old\":[");
        if os > 0 {
            out.push_str(&region_rects(s, v, cfg, w, oa, os, scroll, 4));
        }
        out.push_str("],\"new\":[");
        out.push_str(&region_rects(
            s,
            v,
            cfg,
            w,
            s.addr[ei],
            s.span(e),
            scroll,
            4,
        ));
        out.push(']');
    } else {
        // F: flash the freed region
        let tgt = s.target[ei];
        let (fa, fs) = if tgt != NONE_U32 {
            (s.addr[tgt as usize], s.span(tgt))
        } else {
            (s.addr[ei], s.size[ei])
        };
        out.push_str(",\"old\":[");
        if fs > 0 {
            out.push_str(&region_rects(s, v, cfg, w, fa, fs, scroll, 4));
        }
        out.push_str("],\"new\":[]");
    }
    out.push('}');
    out
}

/// Scroll offset that centers the allocation touched by event `e`; -1 if the
/// row is not currently laid out (e.g. the allocation is dead here).
pub fn scroll_for_event(s: &Store, v: &mut View, cfg: &Cfg, h: u32, e: u32) -> f64 {
    if e >= s.len() {
        return -1.0;
    }
    v.ensure_rows();
    let ei = e as usize;
    let creator = match s.op[ei] {
        OP_F => {
            if s.target[ei] != NONE_U32 {
                s.target[ei]
            } else {
                return -1.0;
            }
        }
        // a custom event sits at no address: leave the viewport where it is
        OP_E => return -1.0,
        _ => e,
    };
    let a = s.addr[creator as usize];
    let r = (a.saturating_sub(v.base)) / v.row_bytes;
    let idx = match v.rows.binary_search(&r) {
        Ok(i) => i,
        Err(_) => return -1.0,
    };
    let y = v.row_y(idx, cfg.row_px, cfg.gap_px) as f64;
    (y - h as f64 / 2.0).max(0.0)
}
