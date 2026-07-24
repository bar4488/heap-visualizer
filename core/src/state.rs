//! Runtime playhead state: the live set at the current position, incremental
//! bidirectional replay, snapshot-accelerated seeks, and the collapsed-row
//! layout of the address-line.

use std::collections::{BTreeMap, BTreeSet};

use crate::store::*;

pub struct View {
    /// Number of events applied; the playhead sits after event `cur - 1`.
    pub cur: u32,
    /// Live allocations, keyed (addr, creating event) for address-order walks.
    pub live: BTreeSet<(u64, u32)>,
    pub live_count: u32,
    pub live_bytes: u64,
    /// Multiset of live allocations' birth timestamps, so the oldest live
    /// birth (age color mode) is O(log n) instead of a full live-set scan.
    birth_counts: BTreeMap<u64, u32>,
    /// Multiset of live allocations' rendered spans, so the render-time
    /// walk-back is bounded by the widest allocation *currently live* rather
    /// than Store::max_span, a trace-wide maximum that never decreases.
    span_counts: BTreeMap<u64, u32>,

    pub row_bytes: u64,
    pub base: u64,
    /// Minimum run of consecutive empty rows that collapses into a gap
    /// marker; shorter runs are shown as real (empty) rows.
    pub collapse_rows: u64,
    /// When non-zero, the threshold is expressed in bytes of empty address
    /// space instead: effective rows = ceil(collapse_bytes / row_bytes),
    /// so it tracks row_bytes changes.
    pub collapse_bytes: u64,

    /// row index -> number of live allocations touching it. Ordered so the
    /// live-rows layout comes out sorted without a per-rebuild sort.
    occ: BTreeMap<u64, u32>,
    /// Pinned addresses (user address marks): their rows stay in the layout
    /// even when nothing is live there, so they are always scrollable to.
    pub pins: Vec<u64>,
    /// Transient pin on the viewport's scroll anchor: the address at the top
    /// of the viewport stays laid out across seeks even if everything there
    /// is freed, so the user is not scrolled away from what they look at.
    pub anchor_pin: Option<u64>,
    /// When on, lay out every row any allocation *ever* touches (playhead
    /// independent) so the map never reflows as allocations come and go.
    pub show_all: bool,
    /// Cached union rows for the current row_bytes (valid when show_all set).
    all_rows: Vec<u64>,
    all_rows_valid: bool,
    rows_dirty: bool,
    /// Sorted display-row indices (occupied rows plus empty filler rows for
    /// runs shorter than collapse_min) + count of collapsed gaps before each.
    pub rows: Vec<u64>,
    pub gaps_before: Vec<u32>,
}

impl View {
    pub fn new() -> Self {
        View {
            cur: 0,
            live: BTreeSet::new(),
            live_count: 0,
            live_bytes: 0,
            birth_counts: BTreeMap::new(),
            span_counts: BTreeMap::new(),
            row_bytes: 0x1000,
            base: 0,
            collapse_rows: 5,
            collapse_bytes: 0,
            occ: BTreeMap::new(),
            pins: Vec::new(),
            anchor_pin: None,
            show_all: true,
            all_rows: Vec::new(),
            all_rows_valid: false,
            rows_dirty: true,
            rows: Vec::new(),
            gaps_before: Vec::new(),
        }
    }

    pub fn reset(&mut self, s: &Store) {
        self.cur = 0;
        self.live.clear();
        self.birth_counts.clear();
        self.span_counts.clear();
        self.occ.clear();
        self.pins.clear();
        self.anchor_pin = None;
        self.live_count = 0;
        self.live_bytes = 0;
        self.rows_dirty = true;
        if s.hdr_row_bytes > 0 {
            self.row_bytes = s.hdr_row_bytes;
        }
        self.recompute_base(s);
        self.all_rows_valid = false;
        if self.show_all {
            self.build_all_rows(s);
        }
    }

    pub fn recompute_base(&mut self, s: &Store) {
        let lo = if s.arena_base != 0 {
            s.arena_base.min(s.addr_min)
        } else {
            s.addr_min
        };
        let lo = if lo == u64::MAX { 0 } else { lo };
        self.base = lo - lo % self.row_bytes;
    }

    pub fn set_row_bytes(&mut self, s: &Store, w: u64) {
        let w = w.max(16);
        if w == self.row_bytes {
            return;
        }
        self.row_bytes = w;
        self.recompute_base(s);
        // rebuild occupancy from the live set
        self.occ.clear();
        let entries: Vec<(u64, u32)> = self.live.iter().copied().collect();
        for (_, e) in entries {
            self.occ_add(s, e, 1);
        }
        self.all_rows_valid = false;
        if self.show_all {
            self.build_all_rows(s);
        }
        self.rows_dirty = true;
    }

    fn row_of(&self, a: u64) -> u64 {
        (a.saturating_sub(self.base)) / self.row_bytes
    }

    fn occ_add(&mut self, s: &Store, e: u32, delta: i32) {
        let a = s.addr[e as usize];
        let span = s.span(e);
        let r0 = self.row_of(a);
        let r1 = self.row_of(a + span - 1);
        // Cap pathological spans so a single terabyte alloc cannot stall us;
        // beyond the cap only the first/last rows are marked (the middle rows
        // belong entirely to this alloc anyway, and get painted directly).
        let nrows = r1 - r0;
        if nrows > 65536 {
            for r in [r0, r1] {
                self.occ_bump(r, delta);
            }
            return;
        }
        for r in r0..=r1 {
            self.occ_bump(r, delta);
        }
    }

    fn occ_bump(&mut self, r: u64, delta: i32) {
        let c = self.occ.entry(r).or_insert(0);
        if delta > 0 {
            *c += delta as u32;
        } else {
            *c = c.saturating_sub((-delta) as u32);
            if *c == 0 {
                self.occ.remove(&r);
            }
        }
    }

    fn insert_alloc(&mut self, s: &Store, e: u32) {
        if self.live.insert((s.addr[e as usize], e)) {
            self.live_count += 1;
            self.live_bytes += s.size[e as usize];
            *self.birth_counts.entry(s.t[e as usize]).or_insert(0) += 1;
            *self.span_counts.entry(s.span(e)).or_insert(0) += 1;
            self.occ_add(s, e, 1);
        }
    }

    fn remove_alloc(&mut self, s: &Store, e: u32) {
        if self.live.remove(&(s.addr[e as usize], e)) {
            self.live_count -= 1;
            self.live_bytes = self.live_bytes.saturating_sub(s.size[e as usize]);
            if let Some(c) = self.birth_counts.get_mut(&s.t[e as usize]) {
                *c -= 1;
                if *c == 0 {
                    self.birth_counts.remove(&s.t[e as usize]);
                }
            }
            if let Some(c) = self.span_counts.get_mut(&s.span(e)) {
                *c -= 1;
                if *c == 0 {
                    self.span_counts.remove(&s.span(e));
                }
            }
            self.occ_add(s, e, -1);
        }
    }

    /// Birth timestamp of the oldest live allocation, if any.
    pub fn min_live_birth(&self) -> Option<u64> {
        self.birth_counts.keys().next().copied()
    }

    /// Rendered span of the widest allocation currently live (0 when none) —
    /// the walk-back bound for per-frame live-set range scans. Unlike
    /// `Store::max_span` it shrinks when the wide allocation is freed, so one
    /// early arena block does not tax every later frame.
    pub fn max_live_span(&self) -> u64 {
        self.span_counts.keys().next_back().copied().unwrap_or(0)
    }

    fn apply_fwd(&mut self, s: &Store, e: u32) {
        let op = s.op[e as usize];
        if op == OP_F || op == OP_R {
            let tgt = s.target[e as usize];
            if tgt != NONE_U32 {
                self.remove_alloc(s, tgt);
            }
        }
        if op == OP_M || op == OP_R {
            self.insert_alloc(s, e);
        }
    }

    fn apply_bwd(&mut self, s: &Store, e: u32) {
        let op = s.op[e as usize];
        if op == OP_M || op == OP_R {
            self.remove_alloc(s, e);
        }
        if op == OP_F || op == OP_R {
            let tgt = s.target[e as usize];
            if tgt != NONE_U32 {
                self.insert_alloc(s, tgt);
            }
        }
    }

    /// Seek the playhead to `target` events applied.
    pub fn seek(&mut self, s: &Store, target: u32) {
        let target = target.min(s.len());
        if target == self.cur {
            return;
        }
        // candidate: rebuild from the best snapshot at or before target
        let snap = best_snap(s, target);
        let snap_pos = snap.map(|i| s.snaps[i].0).unwrap_or(0);
        let snap_cost =
            (target - snap_pos) as u64 + self.live_count as u64 / 4 + snap_pos.min(1) as u64;
        let incr_cost = (target as i64 - self.cur as i64).unsigned_abs();

        if incr_cost <= snap_cost {
            while self.cur < target {
                self.apply_fwd(s, self.cur);
                self.cur += 1;
            }
            while self.cur > target {
                self.cur -= 1;
                self.apply_bwd(s, self.cur);
            }
        } else {
            self.live.clear();
            self.birth_counts.clear();
            self.span_counts.clear();
            self.occ.clear();
            self.live_count = 0;
            self.live_bytes = 0;
            if let Some(i) = snap {
                let (pos, lv) = (&s.snaps[i].0, s.snaps[i].1.clone());
                self.cur = *pos;
                for e in lv {
                    self.insert_alloc(s, e);
                }
            } else {
                self.cur = 0;
            }
            while self.cur < target {
                self.apply_fwd(s, self.cur);
                self.cur += 1;
            }
        }
        // show_all's layout comes from all_rows (playhead-independent by
        // construction) plus pins — a seek cannot change it, so don't pay a
        // rebuild on every step. Everything that *can* change it
        // (set_row_bytes / set_pins / set_anchor_pin / set_show_all) marks
        // dirty itself.
        if !self.show_all {
            self.rows_dirty = true;
        }
    }

    /// Rebuild the sorted display-row list if needed. Empty runs shorter
    /// than collapse_min become real filler rows; longer runs collapse.
    pub fn ensure_rows(&mut self) {
        if !self.rows_dirty {
            return;
        }
        let collapse_min = self.effective_collapse_min();
        // pinned addresses keep their rows laid out even when empty
        let mut pin_rows: Vec<u64> = self
            .pins
            .iter()
            .chain(self.anchor_pin.iter())
            .map(|&p| self.row_of(p))
            .collect();
        pin_rows.sort_unstable();
        pin_rows.dedup();
        // show_all lays out the union of rows any allocation ever touches
        // (a superset of the live rows), keeping the map stable over time.
        // Both sources are already sorted and deduped (all_rows by
        // build_all_rows, occ by being an ordered map), so the pin rows are
        // merged in rather than concatenated and re-sorted.
        let live_rows: Vec<u64>;
        let occupied: &[u64] = if self.show_all {
            &self.all_rows
        } else {
            live_rows = self.occ.keys().copied().collect();
            &live_rows
        };
        self.rows.clear();
        self.gaps_before.clear();
        let mut gaps = 0u32;
        let mut prev: Option<u64> = None;
        let (mut oi, mut pi) = (0usize, 0usize);
        loop {
            let r = match (occupied.get(oi), pin_rows.get(pi)) {
                (Some(&a), Some(&b)) if a == b => {
                    oi += 1;
                    pi += 1;
                    a
                }
                (Some(&a), Some(&b)) if a < b => {
                    oi += 1;
                    a
                }
                (Some(_), Some(&b)) => {
                    pi += 1;
                    b
                }
                (Some(&a), None) => {
                    oi += 1;
                    a
                }
                (None, Some(&b)) => {
                    pi += 1;
                    b
                }
                (None, None) => break,
            };
            if let Some(p) = prev {
                let run = r - p - 1;
                if run > 0 {
                    if run < collapse_min {
                        for filler in (p + 1)..r {
                            self.rows.push(filler);
                            self.gaps_before.push(gaps);
                        }
                    } else {
                        gaps += 1;
                    }
                }
            }
            self.rows.push(r);
            self.gaps_before.push(gaps);
            prev = Some(r);
        }
        self.rows_dirty = false;
    }

    pub fn effective_collapse_min(&self) -> u64 {
        if self.collapse_bytes > 0 {
            ((self.collapse_bytes + self.row_bytes - 1) / self.row_bytes).max(1)
        } else {
            self.collapse_rows.max(1)
        }
    }

    pub fn set_collapse_min(&mut self, rows: u64) {
        self.collapse_rows = rows.max(1);
        self.collapse_bytes = 0;
        self.rows_dirty = true;
    }

    pub fn set_collapse_min_bytes(&mut self, bytes: u64) {
        self.collapse_bytes = bytes.max(1);
        self.rows_dirty = true;
    }

    pub fn mark_rows_dirty(&mut self) {
        self.rows_dirty = true;
    }

    pub fn set_pins(&mut self, pins: Vec<u64>) {
        self.pins = pins;
        self.rows_dirty = true;
    }

    pub fn set_anchor_pin(&mut self, pin: Option<u64>) {
        if self.anchor_pin != pin {
            self.anchor_pin = pin;
            self.rows_dirty = true;
        }
    }

    pub fn set_show_all(&mut self, s: &Store, on: bool) {
        self.show_all = on;
        if on && !self.all_rows_valid {
            self.build_all_rows(s);
        }
        self.rows_dirty = true;
    }

    /// Union of rows touched by any allocation across the whole trace, for
    /// the current row_bytes (same span/cap rules as live occupancy).
    fn build_all_rows(&mut self, s: &Store) {
        let mut set: std::collections::HashSet<u64> = std::collections::HashSet::new();
        for e in 0..s.len() {
            let op = s.op[e as usize];
            if op != OP_M && op != OP_R {
                continue;
            }
            let a = s.addr[e as usize];
            let r0 = self.row_of(a);
            let r1 = self.row_of(a + s.span(e) - 1);
            if r1 - r0 > 65536 {
                set.insert(r0);
                set.insert(r1);
            } else {
                for r in r0..=r1 {
                    set.insert(r);
                }
            }
        }
        let mut rows: Vec<u64> = set.into_iter().collect();
        rows.sort_unstable();
        self.all_rows = rows;
        self.all_rows_valid = true;
    }

    /// y-position (virtual px) of the display row at index i.
    pub fn row_y(&self, i: usize, row_px: u32, gap_px: u32) -> u64 {
        i as u64 * row_px as u64 + self.gaps_before[i] as u64 * gap_px as u64
    }

    pub fn virtual_height(&self, row_px: u32, gap_px: u32) -> u64 {
        if self.rows.is_empty() {
            return 0;
        }
        let n = self.rows.len();
        self.row_y(n - 1, row_px, gap_px) + row_px as u64
    }

    /// Index into rows[] for a given row id, if occupied.
    pub fn row_index(&self, row: u64) -> Option<usize> {
        self.rows.binary_search(&row).ok()
    }

    /// Scroll anchor: the address of the topmost (fully or partially) visible
    /// occupied row at virtual `scroll`, plus the pixel offset of `scroll`
    /// from that row's y. Re-applying the anchor after the layout changes
    /// keeps the same address pinned at the top of the viewport.
    pub fn anchor_at(&mut self, scroll: f64, row_px: u32, gap_px: u32) -> Option<(u64, i32)> {
        self.ensure_rows();
        if self.rows.is_empty() {
            return None;
        }
        let y = scroll.max(0.0) as u64;
        // first display row whose bottom edge is below y
        let mut lo = 0usize;
        let mut hi = self.rows.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.row_y(mid, row_px, gap_px) + row_px as u64 <= y {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo >= self.rows.len() {
            lo = self.rows.len() - 1;
        }
        let off = scroll - self.row_y(lo, row_px, gap_px) as f64;
        let addr = self.base + self.rows[lo] * self.row_bytes;
        Some((addr, off as i32))
    }

    /// Scroll offset that puts the row containing `addr` at the top of the
    /// viewport again, `offset` px past its y. If that row is no longer laid
    /// out, the next occupied row lands at the top instead. -1 if empty.
    pub fn scroll_for_addr(&mut self, addr: u64, offset: i32, row_px: u32, gap_px: u32) -> f64 {
        self.ensure_rows();
        if self.rows.is_empty() {
            return -1.0;
        }
        let row = addr.saturating_sub(self.base) / self.row_bytes;
        let (j, exact) = match self.rows.binary_search(&row) {
            Ok(j) => (j, true),
            Err(j) => (j.min(self.rows.len() - 1), false),
        };
        let y = self.row_y(j, row_px, gap_px) as f64;
        let off = if exact { offset as f64 } else { 0.0 };
        (y + off).max(0.0)
    }

    /// Display-row index at virtual y, if it lands on a row (not a gap).
    pub fn row_at_y(&self, y: u64, row_px: u32, gap_px: u32) -> Option<usize> {
        if self.rows.is_empty() {
            return None;
        }
        // binary search over row_y (monotone)
        let mut lo = 0usize;
        let mut hi = self.rows.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.row_y(mid, row_px, gap_px) <= y {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return None;
        }
        let i = lo - 1;
        if y < self.row_y(i, row_px, gap_px) + row_px as u64 {
            Some(i)
        } else {
            None // inside a gap marker
        }
    }
}

fn best_snap(s: &Store, target: u32) -> Option<usize> {
    // snaps are sorted by position; find last with pos <= target
    let mut best = None;
    for (i, (pos, _)) in s.snaps.iter().enumerate() {
        if *pos <= target {
            best = Some(i);
        } else {
            break;
        }
    }
    best
}
