//! Columnar event store: the parsed trace, plus load-time derived indexes
//! (death links, snapshots, prefix sums, warnings).

pub const NONE_U32: u32 = u32::MAX;
pub const NONE_U16: u16 = u16::MAX;

pub const OP_M: u8 = 0;
pub const OP_F: u8 = 1;
pub const OP_R: u8 = 2;

// Warning codes.
pub const W_MALFORMED: u8 = 0;
pub const W_T_DECREASE: u8 = 1;
pub const W_SEQ_MISMATCH: u8 = 2;
pub const W_UNKNOWN_ID: u8 = 3;
pub const W_DOUBLE_FREE: u8 = 4;
pub const W_DUP_ID: u8 = 5;
pub const W_OVERLAP: u8 = 6;
pub const W_BAD_SIZE: u8 = 7;
pub const W_VERSION: u8 = 8;
pub const NWARN: usize = 9;

pub fn warn_name(code: u8) -> &'static str {
    match code {
        W_MALFORMED => "malformed line skipped",
        W_T_DECREASE => "decreasing t clamped",
        W_SEQ_MISMATCH => "seq differs from stream position",
        W_UNKNOWN_ID => "free of unknown id",
        W_DOUBLE_FREE => "double free",
        W_DUP_ID => "allocation id reused",
        W_OVERLAP => "allocation overlaps live region",
        W_BAD_SIZE => "size missing or zero",
        W_VERSION => "unknown format version",
        _ => "warning",
    }
}

#[derive(Clone, Copy)]
pub struct Warning {
    /// Event index (seq) the warning is attached to; NONE_U32 if none.
    pub seq: u32,
    pub code: u8,
    /// Free detail (id, t, ... depending on code).
    pub detail: u64,
}

pub struct Store {
    // per-event columns
    pub op: Vec<u8>,
    pub t: Vec<u64>,
    pub id: Vec<u64>,
    pub addr: Vec<u64>,
    pub size: Vec<u64>,
    /// usable size hint (0 = absent). Rendered as a slack band. Lazy column:
    /// stays empty until the first event with a hint (empty = all zero), so
    /// traces without the hint pay nothing. Read via `usable_at`.
    pub usable: Vec<u64>,
    pub thr_idx: Vec<u16>,
    pub site: Vec<u32>,
    /// Lazy column like `usable` (empty = all NONE_U32). Read via `stack_at`.
    pub stack: Vec<u32>,
    /// Index into `extras` of this event's caller-defined JSON fields
    /// (unrecognized top-level keys), interned as a raw JSON object body
    /// fragment; NONE_U32 = none. Lazy column; read via `extra_at`.
    pub extra: Vec<u32>,
    /// For F/R events: index of the creating event (M/R) being killed.
    pub target: Vec<u32>,
    /// For R events only: old geometry (resolved from target, else record
    /// copy), keyed by event index. Side table so non-R events cost nothing.
    pub old_geom: std::collections::HashMap<u32, (u64, u64)>,
    /// For creator events (M/R): the event index that kills this allocation.
    pub death: Vec<u32>,
    /// User-assigned tag per creator event (0 = untagged). Session state,
    /// mutated by the viewer, not part of the wire format. Written through
    /// `set_tag`/`clear_tags` so the count and index below stay correct.
    pub tag: Vec<u8>,
    /// Number of creator events currently tagged — lets per-frame consumers
    /// (the timeline tag lanes) skip tag work for untagged traces.
    pub tagged: u32,
    /// Sorted event indexes feeding the timeline tag lanes: creators with a
    /// tag, and F/R events whose target is tagged. Rebuilt lazily via
    /// `ensure_tag_index` after any tag mutation.
    pub(crate) tag_alloc_idx: Vec<u32>,
    pub(crate) tag_free_idx: Vec<u32>,
    pub(crate) tag_idx_dirty: bool,

    // prefix sums for timeline binning: count of green (M/R) and red (F/R)
    // marks in events [0, i). An R contributes to both.
    pub green_pre: Vec<u32>,
    pub red_pre: Vec<u32>,

    // interning tables
    pub sites: Vec<String>,
    pub site_count: Vec<u32>,
    pub thrs: Vec<i64>,
    pub thr_count: Vec<u32>,
    pub stacks: Vec<String>,
    pub extras: Vec<String>,

    // header
    pub has_header: bool,
    pub version: i64,
    pub unit: String,
    pub title: String,
    pub hdr_row_bytes: u64,
    pub arena_base: u64,
    pub meta_raw: String,

    // global stats
    pub t_min: u64,
    pub t_max: u64,
    pub addr_min: u64,
    pub addr_max: u64,
    /// Largest rendered span (max of size/usable) — bounds pick scans.
    pub max_span: u64,
    pub peak_live_bytes: u64,
    pub total_alloc_bytes: u64,
    pub n_malloc: u32,
    pub n_free: u32,
    pub n_realloc: u32,

    pub warnings: Vec<Warning>,
    pub warn_counts: [u32; NWARN],

    /// Creator events flagged W_OVERLAP at load, sorted by (addr, event) —
    /// the candidate set for ghost rendering (freed-inside-live markers).
    /// Unlike `warnings` this is never capped, but it only holds overlapping
    /// creators, so a trace without nesting pays nothing.
    pub overlap_index: Vec<(u64, u32)>,

    /// Snapshots: (events_applied, live creator-event indices, sorted by index).
    pub snaps: Vec<(u32, Vec<u32>)>,
}

impl Store {
    pub fn len(&self) -> u32 {
        self.op.len() as u32
    }

    pub fn warn(&mut self, seq: u32, code: u8, detail: u64) {
        self.warn_counts[code as usize] += 1;
        if self.warnings.len() < 1000 {
            self.warnings.push(Warning { seq, code, detail });
        }
    }

    /// Usable-size hint for event `e` (0 = absent). Lazy column: empty means
    /// no event in the trace carried the hint.
    #[inline]
    pub fn usable_at(&self, e: u32) -> u64 {
        if self.usable.is_empty() {
            0
        } else {
            self.usable[e as usize]
        }
    }

    /// Stack intern index for event `e` (NONE_U32 = absent). Lazy column.
    #[inline]
    pub fn stack_at(&self, e: u32) -> u32 {
        if self.stack.is_empty() {
            NONE_U32
        } else {
            self.stack[e as usize]
        }
    }

    /// Extra-fields intern index for event `e` (NONE_U32 = absent). Lazy column.
    #[inline]
    pub fn extra_at(&self, e: u32) -> u32 {
        if self.extra.is_empty() {
            NONE_U32
        } else {
            self.extra[e as usize]
        }
    }

    /// Old (addr, size) geometry of the allocation an R event replaced;
    /// (0, 0) for anything else.
    #[inline]
    pub fn old_geom_at(&self, e: u32) -> (u64, u64) {
        self.old_geom.get(&e).copied().unwrap_or((0, 0))
    }

    /// Rendered byte span of a creator event (requested size or usable, whichever
    /// is larger; always at least 1 so zero-size flagged records still show).
    #[inline]
    pub fn span(&self, e: u32) -> u64 {
        self.size[e as usize].max(self.usable_at(e)).max(1)
    }

    /// Write a tag assignment. Not `self.tag[..] = ..` directly: this keeps
    /// `tagged` and the timeline's tagged-event index in sync.
    pub fn set_tag(&mut self, e: u32, tag: u8) {
        let old = std::mem::replace(&mut self.tag[e as usize], tag);
        if old != tag {
            self.tag_idx_dirty = true;
            if old == 0 {
                self.tagged += 1;
            } else if tag == 0 {
                self.tagged -= 1;
            }
        }
    }

    /// Remove every tag assignment.
    pub fn clear_tags(&mut self) {
        for t in self.tag.iter_mut() {
            *t = 0;
        }
        self.tagged = 0;
        self.tag_idx_dirty = true;
    }

    /// Rebuild `tag_alloc_idx` / `tag_free_idx` if tags changed since the
    /// last build. O(n), but only after a tag mutation — the per-column
    /// timeline reads are binary searches over the result.
    pub fn ensure_tag_index(&mut self) {
        if !self.tag_idx_dirty {
            return;
        }
        self.tag_alloc_idx.clear();
        self.tag_free_idx.clear();
        for e in 0..self.len() {
            let ei = e as usize;
            let op = self.op[ei];
            if (op == OP_M || op == OP_R) && self.tag[ei] != 0 {
                self.tag_alloc_idx.push(e);
            }
            if op == OP_F || op == OP_R {
                let tgt = self.target[ei];
                if tgt != NONE_U32 && self.tag[tgt as usize] != 0 {
                    self.tag_free_idx.push(e);
                }
            }
        }
        self.tag_idx_dirty = false;
    }

    /// Timestamp of the playhead "after `applied` events".
    pub fn t_at(&self, applied: u32) -> u64 {
        if applied == 0 {
            self.t_min
        } else {
            self.t[(applied - 1) as usize]
        }
    }

    /// Number of events with t <= tt (i.e. the playhead seq for time tt).
    pub fn seq_for_t(&self, tt: u64) -> u32 {
        self.t.partition_point(|&x| x <= tt) as u32
    }

    /// First event index with t >= tt.
    pub fn lower_bound_t(&self, tt: u64) -> u32 {
        self.t.partition_point(|&x| x < tt) as u32
    }
}
