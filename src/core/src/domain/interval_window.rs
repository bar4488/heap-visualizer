//! The interval window ([IVL-008]): the intervals of one track overlapping a
//! viewport, culled to what is wide enough to draw — the data behind a flame
//! chart or a CPU track.
//!
//! Each begin index (a track's calls, a track's spans, a CPU's slices) gets a
//! [`WindowTree`] at load: a segment tree over blocks of [`BLOCK`]
//! consecutive intervals holding each node's latest end and widest interval
//! on both axes. A query visits the intervals beginning at or before the
//! window's end (one binary search), drops every node ending before the
//! window, and counts a node whose intervals all begin inside the window and
//! are all narrower than half a pixel as culled without opening it. The cost
//! is O((v + 1) log n) for v drawn intervals, never a scan of the trace.
//!
//! [IVL-008]: ../../../../spec/14-intervals.md#ivl-008-the-window

use serde_json::{json, Value};

use super::interval::{find_track, IntervalStore, CATEGORIES, CAT_CALL, CAT_SCHED, CAT_SPAN, FLAG_IDLE};
use crate::json::push_json_str;
use crate::store::{Store, NONE_U32};

/// Rows a window answers at most; past it the answer is `truncated`.
pub const WINDOW_ROWS_MAX: usize = 20_000;
/// Intervals per leaf of a [`WindowTree`].
pub const BLOCK: usize = 16;
/// An interval narrower than this many device pixels is culled.
pub const CULL_PX: f64 = 0.5;

/// A window tree over one begin-ordered list of intervals.
#[derive(Default, Debug)]
pub struct WindowTree {
    /// Per node: the latest end seq (an open interval ends at the trace's
    /// length), the widest interval in seqs and in trace time.
    end: Vec<u32>,
    wseq: Vec<u32>,
    wt: Vec<u64>,
    blocks: usize,
}

/// End seq with an open interval extended to the end of the trace.
#[inline]
fn end_seq(s: &Store, st: &IntervalStore, i: u32) -> u32 {
    match st.end[i as usize] {
        NONE_U32 => s.len(),
        e => e,
    }
}

/// Trace time of an end seq from [`end_seq`].
#[inline]
fn seq_t(s: &Store, seq: u32) -> u64 {
    s.t.get(seq as usize).copied().unwrap_or(s.t_max)
}

impl WindowTree {
    pub fn build(s: &Store, st: &IntervalStore, list: &[u32]) -> WindowTree {
        let blocks = list.len().div_ceil(BLOCK);
        let mut tree = WindowTree { end: vec![0; 4 * blocks.max(1)], wseq: vec![0; 4 * blocks.max(1)], wt: vec![0; 4 * blocks.max(1)], blocks };
        if blocks > 0 {
            tree.fill(s, st, list, 1, 0, blocks);
        }
        tree
    }

    fn fill(&mut self, s: &Store, st: &IntervalStore, list: &[u32], node: usize, lo: usize, hi: usize) {
        if hi - lo == 1 {
            let (mut end, mut wseq, mut wt) = (0, 0, 0);
            for &i in &list[lo * BLOCK..((lo + 1) * BLOCK).min(list.len())] {
                let (b, e) = (st.begin[i as usize], end_seq(s, st, i));
                end = end.max(e);
                wseq = wseq.max(e - b);
                wt = wt.max(seq_t(s, e) - s.t[b as usize]);
            }
            (self.end[node], self.wseq[node], self.wt[node]) = (end, wseq, wt);
            return;
        }
        let mid = (lo + hi) / 2;
        self.fill(s, st, list, 2 * node, lo, mid);
        self.fill(s, st, list, 2 * node + 1, mid, hi);
        self.end[node] = self.end[2 * node].max(self.end[2 * node + 1]);
        self.wseq[node] = self.wseq[2 * node].max(self.wseq[2 * node + 1]);
        self.wt[node] = self.wt[2 * node].max(self.wt[2 * node + 1]);
    }
}

/// The window's axis: spine position or trace time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Axis {
    Seq,
    T,
}

/// The track a window reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowTrack {
    /// A spine track: its calls, then the spans begun on it.
    Thread(u16),
    Cpu(u16),
    /// A track the trace does not have: an empty window.
    Missing,
}

/// A window request, validated.
#[derive(Clone, Debug)]
pub struct WindowRequest {
    pub track: WindowTrack,
    pub axis: Axis,
    pub lo: f64,
    pub hi: f64,
    /// Device pixels across `[lo, hi]`.
    pub width: f64,
    pub category: Option<u8>,
}

/// Which list a row came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lane {
    Call,
    Span,
    Slice,
}

impl Lane {
    pub fn name(self) -> &'static str {
        match self {
            Lane::Call => "call",
            Lane::Span => "span",
            Lane::Slice => "slice",
        }
    }
}

/// A window's answer: the drawn intervals in lane then begin order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Window {
    pub rows: Vec<(u32, Lane)>,
    pub culled: u64,
    pub truncated: bool,
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

impl WindowRequest {
    /// Read `{track: {thr, pid?} | {pid} | {cpu}, axis, lo, hi, width,
    /// category?}`, rejecting unknown keys.
    pub fn parse(s: &Store, v: &Value) -> Result<WindowRequest, String> {
        let obj = v.as_object().ok_or("invalid request")?;
        if let Some(k) = obj.keys().find(|k| !["track", "axis", "lo", "hi", "width", "category"].contains(&k.as_str())) {
            return Err(format!("unknown parameter {k}"));
        }
        let track = obj.get("track").and_then(Value::as_object).ok_or("track must be {thr, pid?} or {cpu}")?;
        if let Some(k) = track.keys().find(|k| !["thr", "pid", "cpu"].contains(&k.as_str())) {
            return Err(format!("unknown track key {k}"));
        }
        let int = |k: &str| -> Result<Option<i64>, String> {
            match track.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v) => v.as_i64().map(Some).ok_or_else(|| format!("track.{k} must be an integer")),
            }
        };
        let track = match (int("cpu")?, int("thr")?, int("pid")?) {
            (Some(cpu), None, None) => match u16::try_from(cpu) {
                Ok(c) if (c as u64) < super::interval::CPU_MAX => WindowTrack::Cpu(c),
                _ => WindowTrack::Missing,
            },
            (Some(_), _, _) => return Err("track takes cpu alone, or thr and pid".into()),
            (None, None, None) => return Err("track must be {thr, pid?} or {cpu}".into()),
            (None, thr, pid) => {
                let pid = pid.map(|p| u32::try_from(p).map_err(|_| "track.pid must be 0 through 4294967295".to_string())).transpose()?;
                find_track(s, thr, pid).map_or(WindowTrack::Missing, WindowTrack::Thread)
            }
        };
        let axis = match obj.get("axis").and_then(Value::as_str) {
            Some("seq") => Axis::Seq,
            Some("t") => Axis::T,
            _ => return Err("axis must be seq or t".into()),
        };
        let lo = obj.get("lo").and_then(number).ok_or("lo must be a number")?;
        let hi = obj.get("hi").and_then(number).ok_or("hi must be a number")?;
        if hi < lo {
            return Err("hi must not be below lo".into());
        }
        let width = obj.get("width").and_then(number).filter(|&w| w > 0.0).ok_or("width must be a positive number")?;
        let category = match obj.get("category") {
            None | Some(Value::Null) => None,
            Some(Value::String(c)) => Some(
                CATEGORIES.iter().position(|n| n == c).ok_or("category must be sched, call, or span")? as u8,
            ),
            Some(_) => return Err("category must be sched, call, or span".into()),
        };
        Ok(WindowRequest { track, axis, lo, hi, width, category })
    }

    /// Axis units below which an interval's visible part is culled.
    pub fn threshold(&self) -> f64 {
        if self.hi > self.lo {
            CULL_PX * (self.hi - self.lo) / self.width
        } else {
            0.0
        }
    }
}

/// An interval's `[start, end]` on the axis; open ends at the trace end.
#[inline]
pub fn extent(s: &Store, st: &IntervalStore, axis: Axis, i: u32) -> (f64, f64) {
    let (b, e) = (st.begin[i as usize], end_seq(s, st, i));
    match axis {
        Axis::Seq => (b as f64, e as f64),
        Axis::T => (s.t[b as usize] as f64, seq_t(s, e) as f64),
    }
}

/// Is the visible part of `[start, end]` too narrow to draw?
#[inline]
pub fn culled(req: &WindowRequest, start: f64, end: f64) -> bool {
    end.min(req.hi) - start.max(req.lo) < req.threshold()
}

struct Walk<'a> {
    s: &'a Store,
    st: &'a IntervalStore,
    req: &'a WindowRequest,
    thresh: f64,
    list: &'a [u32],
    tree: &'a WindowTree,
    /// Entries `[k_lo, k_hi)` begin inside the window; `[0, k_hi)` at or
    /// before its end.
    k_lo: usize,
    k_hi: usize,
    lane: Lane,
}

impl Walk<'_> {
    fn node(&self, node: usize, blo: usize, bhi: usize, out: &mut Window) {
        let (a, b) = (blo * BLOCK, (bhi * BLOCK).min(self.list.len()));
        if a >= self.k_hi || out.truncated {
            return;
        }
        let end = self.tree.end[node];
        let end_ax = match self.req.axis {
            Axis::Seq => end as f64,
            Axis::T => seq_t(self.s, end) as f64,
        };
        if end_ax < self.req.lo {
            return;
        }
        let wide = match self.req.axis {
            Axis::Seq => self.tree.wseq[node] as f64,
            Axis::T => self.tree.wt[node] as f64,
        };
        if a >= self.k_lo && b <= self.k_hi && wide < self.thresh {
            out.culled += (b - a) as u64;
            return;
        }
        if bhi - blo == 1 {
            for &i in &self.list[a..b.min(self.k_hi)] {
                let (start, end) = extent(self.s, self.st, self.req.axis, i);
                if end < self.req.lo {
                    continue;
                }
                if end.min(self.req.hi) - start.max(self.req.lo) < self.thresh {
                    out.culled += 1;
                } else if out.rows.len() == WINDOW_ROWS_MAX {
                    out.truncated = true;
                    return;
                } else {
                    out.rows.push((i, self.lane));
                }
            }
            return;
        }
        let mid = (blo + bhi) / 2;
        self.node(2 * node, blo, mid, out);
        self.node(2 * node + 1, mid, bhi, out);
    }
}

/// The window over `req` (IVL-008).
pub fn window(s: &Store, req: &WindowRequest) -> Window {
    let st = &s.dom.intervals;
    let mut out = Window::default();
    let want = |cat: u8| req.category.is_none_or(|c| c == cat);
    type Lists<'a> = Vec<(Option<&'a Vec<u32>>, Option<&'a WindowTree>, Lane)>;
    let lists: Lists = match req.track {
        WindowTrack::Missing => Vec::new(),
        WindowTrack::Cpu(c) if want(CAT_SCHED) => vec![(st.cpus.get(&c), st.cpu_win.get(&c), Lane::Slice)],
        WindowTrack::Cpu(_) => Vec::new(),
        WindowTrack::Thread(t) => {
            let mut v = Vec::new();
            if want(CAT_CALL) {
                v.push((st.calls.get(&t), st.call_win.get(&t), Lane::Call));
            }
            if want(CAT_SPAN) {
                v.push((st.track_spans.get(&t), st.span_win.get(&t), Lane::Span));
            }
            v
        }
    };
    let begin_ax = |i: u32| match req.axis {
        Axis::Seq => st.begin[i as usize] as f64,
        Axis::T => s.t[st.begin[i as usize] as usize] as f64,
    };
    for (list, tree, lane) in lists {
        let (Some(list), Some(tree)) = (list, tree) else { continue };
        if tree.blocks == 0 {
            continue;
        }
        let walk = Walk {
            s,
            st,
            req,
            thresh: req.threshold(),
            list,
            tree,
            k_lo: list.partition_point(|&i| begin_ax(i) < req.lo),
            k_hi: list.partition_point(|&i| begin_ax(i) <= req.hi),
            lane,
        };
        walk.node(1, 0, tree.blocks, &mut out);
        if out.truncated {
            break;
        }
    }
    out
}

/// Append one row of the window's JSON — written directly, since a
/// zoomed-out flame chart asks for thousands of rows per frame.
pub fn push_row(o: &mut String, s: &Store, st: &IntervalStore, axis: Axis, i: u32, lane: Lane, label: impl Fn(u16) -> String) {
    use std::fmt::Write;
    let iu = i as usize;
    let (start, end) = extent(s, st, axis, i);
    let b = st.begin[iu];
    let run = s.thr_idx[b as usize];
    let cat = st.cat[iu];
    let idle = cat == CAT_SCHED && st.flags[iu] & FLAG_IDLE != 0;
    let _ = write!(o, "{{\"ivl\":{i},\"name\":");
    match (cat, st.name_of(i)) {
        (CAT_SCHED, _) if idle => o.push_str("\"idle\""),
        (CAT_SCHED, _) => push_json_str(o, &label(run)),
        (_, Some(name)) => push_json_str(o, name),
        (_, None) => o.push_str("null"),
    }
    let _ = write!(
        o,
        ",\"category\":\"{}\",\"lane\":\"{}\",\"depth\":{},\"seq\":{b},",
        CATEGORIES[cat as usize],
        lane.name(),
        st.depth[iu]
    );
    match axis {
        Axis::Seq => {
            let _ = write!(o, "\"start\":{},\"end\":{}", start as u64, end as u64);
        }
        Axis::T => {
            let _ = write!(o, "\"start\":{},\"end\":{}", json!(start), json!(end));
        }
    }
    let _ = write!(o, ",\"open\":{},\"thr\":", st.end[iu] == NONE_U32);
    match s.track_thr(run).filter(|_| !idle) {
        Some(thr) => {
            let _ = write!(o, "{thr}");
        }
        None => o.push_str("null"),
    }
    if let Some(pid) = s.track_pid_of(run).filter(|_| !idle) {
        let _ = write!(o, ",\"pid\":{pid}");
    }
    if cat == CAT_SCHED {
        let _ = write!(o, ",\"cpu\":{},\"idle\":{idle}", st.track[iu]);
    }
    if cat == CAT_SPAN {
        o.push_str(",\"span\":");
        match st.span_id(i) {
            Some(id) => push_json_str(o, id),
            None => o.push_str("null"),
        }
    }
    o.push('}');
}
