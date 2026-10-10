//! The interval domain ([spec/14]): function calls, spans and CPU run
//! slices, read from the v2 `B`/`X`/`C` records — the first domain whose
//! records are not instants.
//!
//! Two layers:
//!
//! - **Edges.** Every `B`, `X` and `C` record is one row of a point store
//!   (`edges`), so the spine ↔ row mapping, the field catalog, the timeline
//!   lane's prefix sums and the per-record summary are the point store's. An
//!   edge's category is its interval's (sched, call, span) and its label is
//!   its `name`.
//! - **Intervals.** One row per call frame, span or run slice, created when
//!   its begin edge is read, so interval indexes ascend with begin seq:
//!   category, track, begin and end seq, depth, parent, name, span id.
//!   Per-track call lists, the span list and per-CPU slice lists are
//!   subsequences of that order, which makes each one a sorted begin index.
//!
//! State at a playhead ([IVL-005]) is read without replay or snapshots: a
//! call stack is one binary search plus a parent walk; a CPU's state is one
//! binary search; open spans come from a max-end segment tree over the span
//! list, so the cost is O((k + 1) log n) for k open spans.
//!
//! [spec/14]: ../../../../spec/14-intervals.md
//! [IVL-005]: ../../../../spec/14-intervals.md#ivl-005-state-at-the-playhead

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};

use super::point::{contains_ci, PointStore};
use super::*;
pub use super::interval_window::{Axis, Window, WindowRequest, WindowTrack, WindowTree, WINDOW_ROWS_MAX};

pub const CAT_SCHED: u8 = 0;
pub const CAT_CALL: u8 = 1;
pub const CAT_SPAN: u8 = 2;
pub const NCAT: usize = 3;
pub const CATEGORIES: [&str; NCAT] = ["sched", "call", "span"];

/// Open call frames per track; span depth (IVL-004).
pub const DEPTH_MAX: usize = 1024;
/// Spans open at once, trace-wide.
pub const OPEN_SPANS_MAX: usize = 65_536;
/// `cpu` must be below this.
pub const CPU_MAX: u64 = 4096;
/// Longest interval `name`, in bytes; longer is truncated (`long_field`).
pub const NAME_MAX: usize = 1024;
/// Longest span id, in bytes; longer makes the line malformed.
pub const SPAN_ID_MAX: usize = 128;
/// Longest `T` name, in bytes.
pub const TRACK_NAME_MAX: usize = 256;
/// Rows per browser page.
pub const PAGE_MAX: u32 = 500;
/// Longest `text` operand, in bytes.
pub const TEXT_MAX: usize = 1024;

/// The slice is an idle period (a `C` without `thr`).
pub const FLAG_IDLE: u8 = 1;
/// The frame was closed by an outer frame's named `X`.
pub const FLAG_IMPLICIT: u8 = 2;
/// The slice's thread was already running on another CPU.
pub const FLAG_DOUBLE_RUN: u8 = 4;

pub const LANE_COLORS: [[u8; 3]; NCAT] = [[0x3f, 0x6e, 0x5a], [0x8b, 0x6f, 0xd6], [0x2f, 0xb5, 0xc8]];

/// The interval lane: each column colored by the outermost kind of edge in
/// it (span over call over sched).
pub const LANE: Lane = Lane {
    id: "intervals.activity",
    title: "Intervals",
    categories: &CATEGORIES,
    colors: &LANE_COLORS,
    height: |h| ((h / 20) as i64).clamp(2, 4),
};

/// The interval store (IVL-003).
#[derive(Default)]
pub struct IntervalStore {
    /// One row per `B`/`X`/`C` record: category, name label, fields.
    pub edges: PointStore<NCAT>,
    /// Per edge row: the interval it began (NONE_U32 when none).
    pub edge_open: Vec<u32>,
    /// Per edge row: the interval it ended (NONE_U32 when none). A named
    /// call `X` that closed frames above its own names the innermost one
    /// it matched.
    pub edge_close: Vec<u32>,

    // ---- one row per interval, in begin order ----
    pub cat: Vec<u8>,
    /// A call's or span's begin track (the spine track); a slice's CPU.
    pub track: Vec<u32>,
    pub begin: Vec<u32>,
    /// End seq; NONE_U32 = still open at the end of the trace.
    pub end: Vec<u32>,
    pub depth: Vec<u16>,
    /// The enclosing frame (calls) or parent span (spans); NONE_U32 = root.
    pub parent: Vec<u32>,
    /// Name, as an index into `edges.labels`; NONE_U32 = unnamed.
    pub name: Vec<u32>,
    /// Span id, as an index into `span_ids`; NONE_U32 for calls and slices.
    pub span: Vec<u32>,
    pub flags: Vec<u8>,
    pub span_ids: Vec<String>,

    /// Begin index per spine track: that track's call frames, by begin.
    pub calls: BTreeMap<u16, Vec<u32>>,
    /// Every span, by begin.
    pub spans: Vec<u32>,
    /// Max-end segment tree over `spans` (open = u32::MAX), built at finish.
    span_tree: Vec<u32>,
    /// Begin index per CPU: its run slices, by begin.
    pub cpus: BTreeMap<u16, Vec<u32>>,
    /// Begin index per spine track: the spans begun on it.
    pub track_spans: BTreeMap<u16, Vec<u32>>,
    /// Window trees over `calls`, `track_spans` and `cpus` (IVL-008), built
    /// at finish.
    pub call_win: BTreeMap<u16, WindowTree>,
    pub span_win: BTreeMap<u16, WindowTree>,
    pub cpu_win: BTreeMap<u16, WindowTree>,
    pub by_cat: [u32; NCAT],
}

impl IntervalStore {
    pub fn len(&self) -> u32 {
        self.cat.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.cat.is_empty()
    }

    pub fn name_of(&self, i: u32) -> Option<&str> {
        match self.name[i as usize] {
            NONE_U32 => None,
            l => Some(&self.edges.labels[l as usize]),
        }
    }

    pub fn span_id(&self, i: u32) -> Option<&str> {
        match self.span[i as usize] {
            NONE_U32 => None,
            id => Some(&self.span_ids[id as usize]),
        }
    }

    /// Is interval `i` open once `applied` records are applied?
    #[inline]
    pub fn open_at(&self, i: u32, applied: u32) -> bool {
        let i = i as usize;
        self.begin[i] < applied && (self.end[i] == NONE_U32 || self.end[i] >= applied)
    }

    /// The running slice of a CPU's list at `applied`: the last begun.
    fn slice_at(list: &[u32], begin: &[u32], applied: u32) -> Option<u32> {
        let k = list.partition_point(|&i| begin[i as usize] < applied);
        k.checked_sub(1).map(|k| list[k])
    }

    /// Track `track`'s open call frames at `applied`, outermost first:
    /// O(log n + depth). The last frame begun at or before the playhead is
    /// found by binary search; proper nesting makes the nearest open frame
    /// on its parent chain the top of the stack, and every ancestor of that
    /// frame open too.
    pub fn stack_at(&self, track: u16, applied: u32) -> Vec<u32> {
        let Some(list) = self.calls.get(&track) else {
            return Vec::new();
        };
        let k = list.partition_point(|&i| self.begin[i as usize] < applied);
        let mut f = match k.checked_sub(1) {
            Some(k) => list[k],
            None => return Vec::new(),
        };
        while f != NONE_U32 && !self.open_at(f, applied) {
            f = self.parent[f as usize];
        }
        let mut out = Vec::new();
        while f != NONE_U32 {
            out.push(f);
            f = self.parent[f as usize];
        }
        out.reverse();
        out
    }

    /// Spans open at `applied`, by begin: O((k + 1) log n) for k open.
    pub fn open_spans_at(&self, applied: u32) -> Vec<u32> {
        let n = self.spans.len();
        let k = self.spans.partition_point(|&i| self.begin[i as usize] < applied);
        let mut out = Vec::new();
        if k > 0 && !self.span_tree.is_empty() {
            self.collect_open(1, 0, n, k, applied, &mut out);
        }
        out
    }

    fn collect_open(&self, node: usize, lo: usize, hi: usize, k: usize, applied: u32, out: &mut Vec<u32>) {
        if lo >= k || self.span_tree[node] < applied {
            return;
        }
        if hi - lo == 1 {
            out.push(self.spans[lo]);
            return;
        }
        let mid = (lo + hi) / 2;
        self.collect_open(2 * node, lo, mid, k, applied, out);
        self.collect_open(2 * node + 1, mid, hi, k, applied, out);
    }

    fn build_span_tree(&mut self) {
        let n = self.spans.len();
        if n == 0 {
            return;
        }
        self.span_tree = vec![0; 4 * n];
        let ends: Vec<u32> = self.spans.iter().map(|&i| self.end[i as usize]).collect();
        fn build(tree: &mut [u32], ends: &[u32], node: usize, lo: usize, hi: usize) -> u32 {
            let v = if hi - lo == 1 {
                ends[lo]
            } else {
                let mid = (lo + hi) / 2;
                build(tree, ends, 2 * node, lo, mid).max(build(tree, ends, 2 * node + 1, mid, hi))
            };
            tree[node] = v;
            v
        }
        build(&mut self.span_tree, &ends, 1, 0, n);
    }

    /// The slice running on `cpu` at `applied`, if the CPU has begun one.
    pub fn cpu_at(&self, cpu: u16, applied: u32) -> Option<u32> {
        Self::slice_at(self.cpus.get(&cpu)?, &self.begin, applied)
    }
}

// ------------------------------------------------------------- building

/// One `B`/`X`/`C` record, decoded but not yet stored.
#[derive(Debug, Default)]
pub struct RawEdge {
    pub name: Option<String>,
    pub span: Option<String>,
    pub parent: Option<String>,
    /// `C` only: the CPU.
    pub cpu: u16,
    /// `C` only: no incoming thread.
    pub idle: bool,
    pub fields: String,
}

#[derive(Default)]
struct Stack {
    frames: Vec<u32>,
    /// `B`s past the depth limit not yet matched by an `X`.
    overflow: u32,
    warned: bool,
}

/// Load-time pairing state (IVL-002); dropped at finish.
#[derive(Default)]
pub struct Builder {
    stacks: HashMap<u16, Stack>,
    open_spans: HashMap<String, u32>,
    /// The most recent span begun with each id, open or closed — what a
    /// `parent` resolves to.
    last_span: HashMap<String, u32>,
    span_map: HashMap<String, u32>,
    cpu_cur: HashMap<u16, u32>,
    /// Slices open per thread track, for `double_run`.
    running: HashMap<u16, u32>,
    label_map: HashMap<String, u32>,
    frag_map: HashMap<String, u32>,
    field_map: HashMap<String, u32>,
}

/// Truncate `s` to at most `max` bytes at a character boundary; whether it
/// was cut.
pub fn truncate_at(s: &mut String, max: usize) -> bool {
    if s.len() <= max {
        return false;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    true
}

impl Builder {
    fn new_interval(st: &mut IntervalStore, cat: u8, track: u32, begin: u32, depth: u16, parent: u32, name: u32) -> u32 {
        let i = st.cat.len() as u32;
        st.cat.push(cat);
        st.track.push(track);
        st.begin.push(begin);
        st.end.push(NONE_U32);
        st.depth.push(depth);
        st.parent.push(parent);
        st.name.push(name);
        st.span.push(NONE_U32);
        st.flags.push(0);
        st.by_cat[cat as usize] += 1;
        i
    }

    fn intern_span(&mut self, st: &mut IntervalStore, id: &str) -> u32 {
        if let Some(&i) = self.span_map.get(id) {
            return i;
        }
        let i = st.span_ids.len() as u32;
        self.span_map.insert(id.to_string(), i);
        st.span_ids.push(id.to_string());
        i
    }

    /// Store edge record `e` (already on the spine, on track `track`) and
    /// pair it.
    pub fn apply(&mut self, s: &mut Store, e: u32, op: u8, track: u16, mut raw: RawEdge) {
        if let Some(name) = raw.name.as_mut() {
            let full = name.len();
            if truncate_at(name, NAME_MAX) {
                s.warn(e, W_LONG_FIELD, full as u64);
            }
        }
        let cat = if op == OP_C {
            CAT_SCHED
        } else if raw.span.is_some() {
            CAT_SPAN
        } else {
            CAT_CALL
        };
        let st = &mut s.dom.intervals;
        let label = match raw.name.take() {
            Some(name) => crate::parse::intern_label(&mut self.label_map, &mut st.edges, name),
            None => NONE_U32,
        };
        let fields = if raw.fields.is_empty() {
            NONE_U32
        } else {
            crate::parse::intern_frag(&mut self.frag_map, &mut self.field_map, &mut st.edges, std::mem::take(&mut raw.fields))
        };
        st.edges.push(e, cat, label, "", fields);
        let (open, close) = match (op, cat) {
            (OP_C, _) => self.switch(s, e, track, &raw),
            (OP_B, CAT_CALL) => (self.call_begin(s, e, track, label), NONE_U32),
            (OP_X, CAT_CALL) => (NONE_U32, self.call_end(s, e, track, label)),
            (OP_B, _) => (self.span_begin(s, e, track, label, &raw), NONE_U32),
            _ => (NONE_U32, self.span_end(s, e, raw.span.as_deref().unwrap_or(""))),
        };
        let st = &mut s.dom.intervals;
        st.edge_open.push(open);
        st.edge_close.push(close);
    }

    fn call_begin(&mut self, s: &mut Store, e: u32, track: u16, label: u32) -> u32 {
        let stack = self.stacks.entry(track).or_default();
        if stack.frames.len() >= DEPTH_MAX {
            stack.overflow += 1;
            if !stack.warned {
                stack.warned = true;
                s.warn(e, W_DEPTH_LIMIT, DEPTH_MAX as u64);
            }
            return NONE_U32;
        }
        let st = &mut s.dom.intervals;
        let parent = stack.frames.last().copied().unwrap_or(NONE_U32);
        let i = Self::new_interval(st, CAT_CALL, track as u32, e, stack.frames.len() as u16, parent, label);
        st.calls.entry(track).or_default().push(i);
        stack.frames.push(i);
        i
    }

    fn call_end(&mut self, s: &mut Store, e: u32, track: u16, label: u32) -> u32 {
        let stack = self.stacks.entry(track).or_default();
        if stack.overflow > 0 {
            // matches a `B` that opened nothing past the depth limit
            stack.overflow -= 1;
            return NONE_U32;
        }
        let st = &mut s.dom.intervals;
        let at = if label == NONE_U32 {
            stack.frames.len().checked_sub(1)
        } else {
            stack.frames.iter().rposition(|&f| st.name[f as usize] == label)
        };
        let Some(at) = at else {
            s.warn(e, W_UNMATCHED_END, 0);
            return NONE_U32;
        };
        let closed: Vec<u32> = stack.frames.drain(at..).collect();
        for &f in &closed[1..] {
            st.end[f as usize] = e;
            st.flags[f as usize] |= FLAG_IMPLICIT;
        }
        st.end[closed[0] as usize] = e;
        for &f in &closed[1..] {
            s.warn(e, W_IMPLICIT_CLOSE, s.dom.intervals.begin[f as usize] as u64);
        }
        closed[0]
    }

    fn span_begin(&mut self, s: &mut Store, e: u32, track: u16, label: u32, raw: &RawEdge) -> u32 {
        let id = raw.span.as_deref().unwrap_or("");
        if self.open_spans.contains_key(id) {
            s.warn(e, W_DUP_SPAN, 0);
            return NONE_U32;
        }
        if self.open_spans.len() >= OPEN_SPANS_MAX {
            s.warn(e, W_TOO_MANY_OPEN, OPEN_SPANS_MAX as u64);
            return NONE_U32;
        }
        let mut parent = match raw.parent.as_deref() {
            None => NONE_U32,
            Some(p) => match self.last_span.get(p) {
                Some(&p) => p,
                None => {
                    s.warn(e, W_UNKNOWN_PARENT, 0);
                    NONE_U32
                }
            },
        };
        let st = &mut s.dom.intervals;
        let mut depth = if parent == NONE_U32 { 0 } else { st.depth[parent as usize] as usize + 1 };
        if depth >= DEPTH_MAX {
            s.warn(e, W_DEPTH_LIMIT, DEPTH_MAX as u64);
            parent = NONE_U32;
            depth = 0;
        }
        let sid = self.intern_span(&mut s.dom.intervals, id);
        let st = &mut s.dom.intervals;
        let i = Self::new_interval(st, CAT_SPAN, track as u32, e, depth as u16, parent, label);
        st.span[i as usize] = sid;
        st.spans.push(i);
        st.track_spans.entry(track).or_default().push(i);
        self.open_spans.insert(id.to_string(), i);
        self.last_span.insert(id.to_string(), i);
        i
    }

    fn span_end(&mut self, s: &mut Store, e: u32, id: &str) -> u32 {
        match self.open_spans.remove(id) {
            Some(i) => {
                s.dom.intervals.end[i as usize] = e;
                i
            }
            None => {
                s.warn(e, W_UNMATCHED_END, 0);
                NONE_U32
            }
        }
    }

    /// A `C`: end the CPU's slice, begin the next (IVL-002).
    fn switch(&mut self, s: &mut Store, e: u32, track: u16, raw: &RawEdge) -> (u32, u32) {
        let cpu = raw.cpu;
        let st = &mut s.dom.intervals;
        let close = match self.cpu_cur.remove(&cpu) {
            Some(prev) => {
                st.end[prev as usize] = e;
                if st.flags[prev as usize] & FLAG_IDLE == 0 {
                    let run = s.thr_idx[st.begin[prev as usize] as usize];
                    if let Some(n) = self.running.get_mut(&run) {
                        *n = n.saturating_sub(1);
                    }
                }
                prev
            }
            None => NONE_U32,
        };
        let i = Self::new_interval(st, CAT_SCHED, cpu as u32, e, 0, NONE_U32, NONE_U32);
        st.cpus.entry(cpu).or_default().push(i);
        if raw.idle {
            st.flags[i as usize] |= FLAG_IDLE;
        } else if track != NONE_U16 {
            let n = self.running.entry(track).or_insert(0);
            if *n > 0 {
                st.flags[i as usize] |= FLAG_DOUBLE_RUN;
                s.warn(e, W_DOUBLE_RUN, cpu as u64);
            }
            *n += 1;
        }
        self.cpu_cur.insert(cpu, i);
        (i, close)
    }

    /// End of trace: flag every call and span still open (run slices are
    /// exempt), and build the open-span index.
    pub fn finish(self, s: &mut Store) {
        let n = s.dom.intervals.len();
        for i in 0..n {
            let st = &s.dom.intervals;
            if st.end[i as usize] == NONE_U32 && st.cat[i as usize] != CAT_SCHED {
                let b = st.begin[i as usize];
                s.warn(b, W_UNCLOSED, b as u64);
            }
        }
        s.dom.intervals.build_span_tree();
        let st = &s.dom.intervals;
        let build = |lists: &BTreeMap<u16, Vec<u32>>| -> BTreeMap<u16, WindowTree> {
            lists.iter().map(|(&k, list)| (k, WindowTree::build(s, st, list))).collect()
        };
        let (calls, spans, cpus) = (build(&st.calls), build(&st.track_spans), build(&st.cpus));
        let st = &mut s.dom.intervals;
        (st.call_win, st.span_win, st.cpu_win) = (calls, spans, cpus);
    }
}

// --------------------------------------------------------------- queries

/// Which track an interval query selects.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackSel {
    /// A spine track: its calls, the spans begun or ended on it, and the
    /// slices it ran in.
    Thread(u16),
    Cpu(u16),
    /// A track the trace does not have: matches nothing.
    Missing,
}

/// An interval query (IVL-007). `seq_hi` is inclusive; an interval matches
/// the seq range when it overlaps it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IntervalQuery {
    pub cat: Option<u8>,
    pub track: Option<TrackSel>,
    pub text: String,
    pub seq_lo: Option<u32>,
    pub seq_hi: Option<u32>,
    pub min_dur: u64,
    /// Only this interval (`ivl`, or the one an `edge` begins or ends);
    /// NONE_U32 matches nothing.
    pub ivl: Option<u32>,
}

impl IntervalQuery {
    /// The matching intervals, in begin order: one scan, with names decided
    /// once over the dictionary.
    pub fn run(&self, s: &Store) -> Vec<u32> {
        let st = &s.dom.intervals;
        let needle: Vec<u8> = self.text.bytes().map(|c| c.to_ascii_lowercase()).collect();
        let name_hit: Vec<bool> = st.edges.labels.iter().map(|n| contains_ci(n.as_bytes(), &needle)).collect();
        let span_hit: Vec<bool> = if needle.is_empty() {
            Vec::new()
        } else {
            st.span_ids.iter().map(|n| contains_ci(n.as_bytes(), &needle)).collect()
        };
        // intervals are in begin order: those beginning after `seq_hi` end the scan
        let stop = match self.seq_hi {
            Some(hi) => st.begin.partition_point(|&b| b <= hi),
            None => st.len() as usize,
        };
        // one interval by id: a lookup, the other operands still apply
        let (start, stop) = match self.ivl {
            Some(i) => ((i as usize).min(stop), stop.min((i as usize).saturating_add(1))),
            None => (0, stop),
        };
        let mut out = Vec::new();
        for i in start..stop {
            let iu = i as u32;
            let cat = st.cat[i];
            if self.cat.is_some_and(|c| c != cat) {
                continue;
            }
            if let Some(lo) = self.seq_lo {
                if st.end[i] != NONE_U32 && st.end[i] < lo {
                    continue;
                }
            }
            if let Some(sel) = self.track {
                if !track_matches(s, iu, sel) {
                    continue;
                }
            }
            if !needle.is_empty() {
                let by_name = st.name[i] != NONE_U32 && name_hit[st.name[i] as usize];
                let by_span = st.span[i] != NONE_U32 && span_hit[st.span[i] as usize];
                if !by_name && !by_span {
                    continue;
                }
            }
            if self.min_dur > 0 && duration(s, iu) < self.min_dur {
                continue;
            }
            out.push(iu);
        }
        out
    }
}

fn track_matches(s: &Store, i: u32, sel: TrackSel) -> bool {
    let st = &s.dom.intervals;
    let iu = i as usize;
    match (sel, st.cat[iu]) {
        (TrackSel::Missing, _) => false,
        (TrackSel::Cpu(c), cat) => cat == CAT_SCHED && st.track[iu] == c as u32,
        (TrackSel::Thread(t), CAT_SCHED) => st.flags[iu] & FLAG_IDLE == 0 && s.thr_idx[st.begin[iu] as usize] == t,
        (TrackSel::Thread(t), CAT_SPAN) => {
            st.track[iu] == t as u32 || (st.end[iu] != NONE_U32 && s.thr_idx[st.end[iu] as usize] == t)
        }
        (TrackSel::Thread(t), _) => st.track[iu] == t as u32,
    }
}

/// An interval's duration in trace time; an open one extends to the end of
/// the trace.
pub fn duration(s: &Store, i: u32) -> u64 {
    let st = &s.dom.intervals;
    let b = s.t[st.begin[i as usize] as usize];
    let e = match st.end[i as usize] {
        NONE_U32 => s.t_max,
        x => s.t[x as usize],
    };
    e.saturating_sub(b)
}

/// The spine track a `thr` (and optional `pid`) names, or `pid` alone its
/// process track. Cold: a scan of the track table.
pub fn find_track(s: &Store, thr: Option<i64>, pid: Option<u32>) -> Option<u16> {
    (0..s.thrs.len()).map(|i| i as u16).find(|&i| s.track_thr(i) == thr && (pid.is_none() || s.track_pid_of(i).unwrap_or(0) == pid.unwrap()))
}

fn number_param(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(t) if !t.is_empty() => t.parse().ok(),
        _ => None,
    }
}

fn cat_from_name(name: &str) -> Option<u8> {
    CATEGORIES.iter().position(|c| c.eq_ignore_ascii_case(name)).map(|c| c as u8)
}

/// Build the query's track selector from `thr`/`pid`/`cpu` operands.
fn track_sel(s: &Store, thr: Option<i64>, pid: Option<u32>, cpu: Option<u64>) -> Option<TrackSel> {
    if let Some(cpu) = cpu {
        return Some(if cpu < CPU_MAX { TrackSel::Cpu(cpu as u16) } else { TrackSel::Missing });
    }
    if thr.is_none() && pid.is_none() {
        return None;
    }
    Some(find_track(s, thr, pid).map_or(TrackSel::Missing, TrackSel::Thread))
}

// ------------------------------------------------------------ the domain

pub struct IntervalView<'a> {
    pub s: &'a Store,
}

/// The interval domain over store `s`.
pub fn view(s: &Store) -> IntervalView<'_> {
    IntervalView { s }
}

impl<'a> IntervalView<'a> {
    fn st(&self) -> &'a IntervalStore {
        &self.s.dom.intervals
    }

    fn fragment(&self, row: u32) -> Option<&'a str> {
        match self.st().edges.fields[row as usize] {
            NONE_U32 => None,
            f => Some(self.st().edges.frags[f as usize].as_str()),
        }
    }

    fn edge_fields(&self, seq: u32) -> Option<&'a str> {
        let row = self.st().edges.row_at_or_after(seq);
        self.fragment(row)
    }

    /// Display name of a spine track: its `T` name, else `thr`.
    fn track_label(&self, track: u16) -> String {
        let s = self.s;
        if let Some(name) = s.track_name(track) {
            return name.to_string();
        }
        match s.track_thr(track) {
            Some(t) => format!("thread {t}"),
            None => match s.track_pid_of(track) {
                Some(pid) if track != NONE_U16 => format!("process {pid}"),
                _ => "no thread".to_string(),
            },
        }
    }

    /// One-line title of edge row `row`: `→ name`, `← name`, `cpu 3 ⇐ main`.
    fn edge_title(&self, row: u32) -> String {
        let (s, st) = (self.s, self.st());
        let seq = st.edges.seq[row as usize];
        let op = s.op[seq as usize];
        let ivl = match op {
            OP_X => st.edge_close[row as usize],
            _ => st.edge_open[row as usize],
        };
        if op == OP_C {
            let cpu = st.track[ivl as usize];
            return if st.flags[ivl as usize] & FLAG_IDLE != 0 {
                format!("cpu {cpu} idle")
            } else {
                format!("cpu {cpu} ⇐ {}", self.track_label(s.thr_idx[seq as usize]))
            };
        }
        let name = st
            .edges
            .label_name(row)
            .or_else(|| (ivl != NONE_U32).then(|| st.name_of(ivl)).flatten())
            .or_else(|| (ivl != NONE_U32).then(|| st.span_id(ivl)).flatten())
            .unwrap_or("?");
        let arrow = if op == OP_B { '→' } else { '←' };
        format!("{arrow} {name}")
    }

    /// An interval as a document. `exact` gives times as strings (agent).
    pub fn interval_value(&self, i: u32, exact: bool) -> Value {
        let (s, st) = (self.s, self.st());
        let iu = i as usize;
        let (b, e) = (st.begin[iu], st.end[iu]);
        let time = |t: u64| if exact { json!(t.to_string()) } else { json!(t as f64) };
        let cat = st.cat[iu];
        let mut v = json!({
            "ivl": i,
            "category": CATEGORIES[cat as usize],
            "seq": b,
            "end": (e != NONE_U32).then_some(e),
            "t": time(s.t[b as usize]),
            "endT": if e == NONE_U32 { Value::Null } else { time(s.t[e as usize]) },
            "dur": time(duration(s, i)),
            "open": e == NONE_U32,
            "depth": st.depth[iu],
            "parent": (st.parent[iu] != NONE_U32).then_some(st.parent[iu]),
            "name": st.name_of(i),
            "fields": fields_value(self.edge_fields(b)),
            "endFields": if e == NONE_U32 { Value::Null } else { fields_value(self.edge_fields(e)) },
        });
        let run = s.thr_idx[b as usize];
        if cat == CAT_SCHED {
            v["cpu"] = json!(st.track[iu]);
            v["idle"] = json!(st.flags[iu] & FLAG_IDLE != 0);
            v["thr"] = thr_value(s, b);
            if let Some(pid) = s.track_pid_of(run).filter(|_| st.flags[iu] & FLAG_IDLE == 0) {
                v["pid"] = json!(pid);
            }
            v["name"] = json!(if st.flags[iu] & FLAG_IDLE != 0 { "idle".to_string() } else { self.track_label(run) });
        } else {
            v["thr"] = thr_value(s, b);
            if let Some(pid) = s.track_pid_of(run) {
                v["pid"] = json!(pid);
            }
        }
        if cat == CAT_SPAN {
            v["span"] = json!(st.span_id(i));
            v["parentSpan"] = json!((st.parent[iu] != NONE_U32).then(|| st.span_id(st.parent[iu])).flatten());
            if e != NONE_U32 {
                v["endThr"] = thr_value(s, e);
            }
        }
        if st.flags[iu] & FLAG_IMPLICIT != 0 {
            v["implicitClose"] = json!(true);
        }
        if st.flags[iu] & FLAG_DOUBLE_RUN != 0 {
            v["doubleRun"] = json!(true);
        }
        v
    }

    fn browser_query(&self, req: &Request) -> IntervalQuery {
        let thr = number_param(&req.thr).map(|t| t as i64);
        let pid = number_param(&req.pid).map(|p| p as u32);
        let cpu = number_param(&req.cpu).map(|c| c.max(0.0) as u64);
        IntervalQuery {
            cat: req.category.as_deref().and_then(cat_from_name),
            track: track_sel(self.s, thr, pid, cpu),
            text: req.text.clone().unwrap_or_default(),
            seq_lo: req.seq_lo(),
            seq_hi: req.seq_hi(),
            min_dur: number_param(&req.min_dur).map_or(0, |d| d.max(0.0) as u64),
            ivl: match (number_param(&req.ivl), number_param(&req.edge)) {
                (Some(i), _) => Some(if i >= 0.0 { clamp_u32(i) } else { NONE_U32 }),
                (None, Some(seq)) => Some(if seq >= 0.0 { self.edge_interval(clamp_u32(seq)) } else { NONE_U32 }),
                (None, None) => None,
            },
        }
    }

    /// The interval the edge record at `seq` begins (`B`, `C`) or ends
    /// (`X`); NONE_U32 when `seq` is not an edge or pairs with none.
    pub fn edge_interval(&self, seq: u32) -> u32 {
        let st = self.st();
        let Some(row) = self.row_of(seq) else { return NONE_U32 };
        match self.s.op[seq as usize] {
            OP_X => st.edge_close[row as usize],
            _ => st.edge_open[row as usize],
        }
    }

    fn matches<'c>(&self, cache: &'c mut QueryCache, q: IntervalQuery) -> &'c [u32] {
        if !matches!(&cache.1, Some((k, _)) if *k == q) {
            let m = q.run(self.s);
            cache.1 = Some((q, m));
        }
        &cache.1.as_ref().unwrap().1
    }

    /// The state at `applied` (IVL-005).
    pub fn state(&self, applied: u32) -> Value {
        let (s, st) = (self.s, self.st());
        let applied = applied.min(s.len());
        let frame = |i: u32| {
            json!({ "ivl": i, "name": st.name_of(i), "depth": st.depth[i as usize], "seq": st.begin[i as usize] })
        };
        let mut threads = Vec::new();
        for &track in st.calls.keys() {
            let stack = st.stack_at(track, applied);
            if stack.is_empty() {
                continue;
            }
            let mut t = json!({
                "thr": s.track_thr(track),
                "name": self.track_label(track),
                "stack": stack.iter().map(|&i| frame(i)).collect::<Vec<_>>(),
            });
            if let Some(pid) = s.track_pid_of(track) {
                t["pid"] = json!(pid);
            }
            threads.push(t);
        }
        let spans: Vec<Value> = st
            .open_spans_at(applied)
            .into_iter()
            .map(|i| {
                let p = st.parent[i as usize];
                json!({
                    "ivl": i, "span": st.span_id(i), "name": st.name_of(i), "depth": st.depth[i as usize],
                    "seq": st.begin[i as usize], "thr": thr_value(s, st.begin[i as usize]),
                    "parent": (p != NONE_U32).then_some(p),
                    "parentSpan": (p != NONE_U32).then(|| st.span_id(p)).flatten(),
                })
            })
            .collect();
        let cpus: Vec<Value> = st
            .cpus
            .keys()
            .map(|&cpu| match st.cpu_at(cpu, applied) {
                None => json!({ "cpu": cpu, "state": "unknown" }),
                Some(i) if st.flags[i as usize] & FLAG_IDLE != 0 => {
                    json!({ "cpu": cpu, "state": "idle", "since": st.begin[i as usize], "ivl": i })
                }
                Some(i) => {
                    let b = st.begin[i as usize];
                    let run = s.thr_idx[b as usize];
                    let mut v = json!({ "cpu": cpu, "state": "running", "thr": s.track_thr(run), "name": self.track_label(run), "since": b, "ivl": i });
                    if let Some(pid) = s.track_pid_of(run) {
                        v["pid"] = json!(pid);
                    }
                    v
                }
            })
            .collect();
        json!({ "applied": applied, "threads": threads, "spans": spans, "cpus": cpus })
    }

    /// Thread tracks that carry calls or begin spans, and CPUs: the
    /// descriptor's `tracks` and `hp_tracks_json` (IVL-008).
    pub fn tracks_value(&self) -> Value {
        let (s, st) = (self.s, self.st());
        let mut keys: Vec<u16> = st.calls.keys().chain(st.track_spans.keys()).copied().collect();
        keys.sort_unstable();
        keys.dedup();
        let threads: Vec<Value> = keys
            .into_iter()
            .map(|track| {
                let calls = st.calls.get(&track).map_or(0, Vec::len);
                let spans = st.track_spans.get(&track).map_or(0, Vec::len);
                let mut v = json!({ "thr": s.track_thr(track), "name": self.track_label(track), "calls": calls, "spans": spans });
                if let Some(pid) = s.track_pid_of(track) {
                    v["pid"] = json!(pid);
                }
                v
            })
            .collect();
        let cpus: Vec<Value> = st.cpus.iter().map(|(&cpu, list)| json!({ "cpu": cpu, "slices": list.len() })).collect();
        json!({ "threads": threads, "cpus": cpus })
    }

    /// The window document for a JSON request (IVL-008): `{rows, culled,
    /// truncated}`, or `{rows: [], culled: 0, truncated: false, error}`.
    pub fn window_json(&self, request: &Value, out: &mut String) {
        let req = match WindowRequest::parse(self.s, request) {
            Ok(req) => req,
            Err(error) => {
                *out = json!({ "rows": [], "culled": 0, "truncated": false, "error": error }).to_string();
                return;
            }
        };
        let w = super::interval_window::window(self.s, &req);
        out.clear();
        out.reserve(w.rows.len() * 160);
        out.push_str("{\"rows\":[");
        for (k, &(i, lane)) in w.rows.iter().enumerate() {
            if k > 0 {
                out.push(',');
            }
            super::interval_window::push_row(out, self.s, self.st(), req.axis, i, lane, |t| self.track_label(t));
        }
        out.push_str(&format!("],\"culled\":{},\"truncated\":{}}}", w.culled, w.truncated));
    }
}

/// The interval kinds, a begin and an end refined by the edge's category (the
/// summary's `source`): a call reads differently from a span.
fn kinds_with_sources() -> Value {
    let mut kinds = kinds_value(INTERVALS);
    let sources = |kind: &str| match kind {
        "begin" => json!({
            "call": { "label": "call ▸", "description": "Function call begins" },
            "span": { "label": "span ▸", "description": "Span begins" },
        }),
        "end" => json!({
            "call": { "label": "ret ◂", "description": "Function call returns" },
            "span": { "label": "span ◂", "description": "Span ends" },
        }),
        _ => Value::Null,
    };
    for k in kinds.as_array_mut().into_iter().flatten() {
        let s = sources(k["kind"].as_str().unwrap_or(""));
        if !s.is_null() {
            k["sources"] = s;
        }
    }
    kinds
}

impl Domain for IntervalView<'_> {
    fn id(&self) -> DomainId {
        INTERVALS
    }

    fn descriptor(&self) -> Value {
        let st = self.st();
        json!({
            "id": self.name(),
            "name": "Intervals",
            "kinds": kinds_with_sources(),
            "shape": "interval",
            "count": self.count(),
            "intervals": st.len(),
            "categories": CATEGORIES,
            "byCategory": st.by_cat,
            "tracks": self.tracks_value(),
            "lanes": lanes_value(self.name(), self.lanes()),
            "fields": catalog_value(st.edges.catalog.iter()),
            "query": { "params": [
                { "name": "category", "type": "category" },
                { "name": "thr", "type": "thread" },
                { "name": "pid", "type": "process" },
                { "name": "cpu", "type": "cpu" },
                { "name": "text", "type": "text" },
                { "name": "minDur", "type": "duration" },
                { "name": "seqLo", "type": "seq" },
                { "name": "seqHi", "type": "seq" },
                { "name": "ivl", "type": "interval" },
                { "name": "edge", "type": "seq" },
            ] },
            "limits": {
                "page": PAGE_MAX, "agentPage": RECORDS_COUNT_MAX, "agentDefault": RECORDS_COUNT_DEFAULT,
                "textBytes": TEXT_MAX, "depth": DEPTH_MAX, "openSpans": OPEN_SPANS_MAX, "cpus": CPU_MAX,
            },
        })
    }

    fn query_params(&self) -> &'static [&'static str] {
        &["category", "thr", "pid", "cpu", "text", "minDur", "seqLo", "seqHi", "ivl", "edge"]
    }

    fn count(&self) -> u32 {
        self.st().edges.len()
    }

    fn seq_of(&self, row: u32) -> u32 {
        self.st().edges.seq[row as usize]
    }

    fn row_of(&self, seq: u32) -> Option<u32> {
        let row = self.st().edges.row_at_or_after(seq);
        (self.st().edges.seq.get(row as usize) == Some(&seq)).then_some(row)
    }

    fn summary(&self, row: u32) -> Summary<'_> {
        let st = self.st();
        let seq = st.edges.seq[row as usize];
        Summary {
            seq,
            domain: INTERVALS,
            kind: op_kind(self.s.op[seq as usize]),
            title: Some(self.edge_title(row)),
            level: None,
            source: Some(CATEGORIES[st.edges.cat[row as usize] as usize]),
            fields: self.fragment(row),
        }
    }

    fn record_json(&self, row: u32, out: &mut String) {
        self.summary(row).push_json(self.s, out);
    }

    /// Intervals, not edges: `{row, ivl, category, seq, end, t, …}`.
    fn query_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String) {
        let q = self.browser_query(req);
        let m = self.matches(cache, q);
        write_page(out, m.len() as u32, req.from(), req.count(PAGE_MAX), PAGE_MAX, |k, o| {
            let mut v = self.interval_value(m[k as usize], false);
            let mut row = serde_json::Map::new();
            row.insert("row".into(), json!(k));
            row.append(v.as_object_mut().unwrap());
            o.push_str(&Value::Object(row).to_string());
        });
    }

    /// The last interval begun at or before `seq`.
    fn locate_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String) {
        let seq = req.seq();
        let q = self.browser_query(req);
        let begin = &self.st().begin;
        let m = self.matches(cache, q);
        let row = m.partition_point(|&i| begin[i as usize] <= seq) as i64 - 1;
        *out = format!("{{\"row\":{},\"total\":{}}}", row, m.len());
    }

    fn lanes(&self) -> &'static [Lane] {
        if self.st().edges.is_empty() {
            &[]
        } else {
            &[LANE]
        }
    }

    fn lane_cell(&self, _lane: usize, a: u32, b: u32) -> Option<[u8; 3]> {
        self.st().edges.max_cat(a, b).map(|c| LANE_COLORS[c as usize])
    }

    fn lane_hover(&self, a: u32, b: u32, out: &mut String) {
        if self.lanes().is_empty() {
            return;
        }
        let counts = self.st().edges.counts(a, b);
        out.push_str(&format!(",\"{}\":{{\"count\":{},\"byCategory\":", self.name(), counts.iter().sum::<u32>()));
        super::point::push_counts(out, &counts);
        out.push('}');
    }

    fn state_at(&self, seq: u32) -> Option<Value> {
        (!self.st().is_empty()).then(|| self.state(seq))
    }

    /// An edge with the interval it begins or ends.
    fn agent_item(&self, row: u32) -> Value {
        let st = self.st();
        let mut v = self.summary(row).agent_value(self.s);
        let ivl = match self.s.op[st.edges.seq[row as usize] as usize] {
            OP_X => st.edge_close[row as usize],
            _ => st.edge_open[row as usize],
        };
        v["interval"] = if ivl == NONE_U32 { Value::Null } else { self.interval_value(ivl, true) };
        v
    }

    /// A page of intervals (not edges), with `category`, `thr`, `pid`,
    /// `cpu`, `text` and `minDur`.
    fn agent_records(&self, p: &RecordParams) -> Result<Value, Error> {
        p.only(&["category", "thr", "pid", "cpu", "text", "minDur"])?;
        let count = p.page_count()?;
        let get = |k: &str| p.params.get(k).map(String::as_str).filter(|v| !v.is_empty());
        let cat = match get("category") {
            None => None,
            Some(c) => Some(cat_from_name(c).ok_or_else(|| param_error("category must be sched, call, or span"))?),
        };
        let int = |k: &str| -> Result<Option<i64>, Error> {
            get(k).map(|v| v.parse::<i64>().map_err(|_| param_error(&format!("{k} must be an integer")))).transpose()
        };
        let thr = int("thr")?;
        let pid = int("pid")?.map(|p| u32::try_from(p).map_err(|_| param_error("pid must be 0 through 4294967295"))).transpose()?;
        let cpu = int("cpu")?.map(|c| u64::try_from(c).map_err(|_| param_error("cpu must not be negative"))).transpose()?;
        let min_dur = get("minDur")
            .map(|v| v.parse::<u64>().map_err(|_| param_error("minDur must be a non-negative integer")))
            .transpose()?
            .unwrap_or(0);
        let text = get("text").unwrap_or("").to_string();
        if text.len() > TEXT_MAX {
            return Err(param_error(&format!("text is limited to {TEXT_MAX} bytes")));
        }
        let q = IntervalQuery { cat, track: track_sel(self.s, thr, pid, cpu), text, seq_lo: p.seq_lo, seq_hi: p.seq_hi, min_dur, ivl: None };
        let m = q.run(self.s);
        Ok(agent_page(m.len(), p.from, count, |k| self.interval_value(m[k], true)))
    }
}
