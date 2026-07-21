//! Columnar event store: the parsed trace, plus load-time derived indexes
//! (death links, kill lists, span/log tables, snapshots, prefix sums,
//! warnings/anomalies).

pub const NONE_U32: u32 = u32::MAX;
pub const NONE_U16: u16 = u16::MAX;

pub const OP_M: u8 = 0;
pub const OP_F: u8 = 1;
pub const OP_R: u8 = 2;
pub const OP_B: u8 = 3;
pub const OP_E: u8 = 4;
pub const OP_L: u8 = 5;

// Warning / anomaly codes. INVALID_FREE and OVERLAP are *anomalies*: producer
// bugs the viewer surfaces as data (click-to-seek list) rather than errors.
pub const W_MALFORMED: u8 = 0;
pub const W_T_DECREASE: u8 = 1;
pub const W_INVALID_FREE: u8 = 2;
pub const W_OVERLAP: u8 = 3;
pub const W_BAD_SIZE: u8 = 4;
pub const W_VERSION: u8 = 5;
pub const W_SPAN_MISMATCH: u8 = 6;
pub const NWARN: usize = 7;

pub fn warn_name(code: u8) -> &'static str {
    match code {
        W_MALFORMED => "malformed line skipped",
        W_T_DECREASE => "decreasing t clamped",
        W_INVALID_FREE => "free of a non-live address",
        W_OVERLAP => "allocation overlaps live region (implicitly ended)",
        W_BAD_SIZE => "size missing or zero",
        W_VERSION => "unsupported format version",
        W_SPAN_MISMATCH => "span end name differs from open span",
        _ => "warning",
    }
}

/// Anomalies are the warnings worth a dedicated view (spec I.2).
pub fn is_anomaly(code: u8) -> bool {
    code == W_INVALID_FREE || code == W_OVERLAP
}

#[derive(Clone, Copy)]
pub struct Warning {
    /// Event index the warning is attached to; NONE_U32 if none.
    pub seq: u32,
    pub code: u8,
    /// Free detail (addr, t, ... depending on code).
    pub detail: u64,
}

/// One span: profiling (thr lane), program phase (global lane), see spec I.3.
#[derive(Clone, Copy)]
pub struct Span {
    /// Index into `span_names`.
    pub name: u32,
    /// Lane: thread index, or NONE_U16 for the global lane.
    pub thr_idx: u16,
    /// Event index of the opening B; NONE_U32 = began before the trace.
    pub begin: u32,
    /// Event index of the closing E; NONE_U32 = still open at end-of-stream.
    pub end: u32,
}

/// One log record (op L). The event row carries t/thr; the payload lives here.
pub struct LogRec {
    pub msg: String,
    /// 0 trace, 1 debug, 2 info, 3 warn, 4 error, 5 fatal.
    pub lvl: u8,
    /// Index into `srcs`; NONE_U32 = absent.
    pub src: u32,
}

pub const LVL_INFO: u8 = 2;

pub fn lvl_name(lvl: u8) -> &'static str {
    match lvl {
        0 => "trace",
        1 => "debug",
        2 => "info",
        3 => "warn",
        4 => "error",
        5 => "fatal",
        _ => "info",
    }
}

pub struct Store {
    // per-event columns
    pub op: Vec<u8>,
    pub t: Vec<u64>,
    pub addr: Vec<u64>,
    pub size: Vec<u64>,
    /// usable size hint (0 = absent). Rendered as a slack band.
    pub usable: Vec<u64>,
    pub thr_idx: Vec<u16>,
    pub site: Vec<u32>,
    pub stack: Vec<u32>,
    /// Index into `extras` of this event's caller-defined JSON fields
    /// (unrecognized top-level keys, plus B `args` / L `fields`), interned as
    /// a raw JSON object body fragment; NONE_U32 = none.
    pub extra: Vec<u32>,
    /// Per-op payload link:
    ///   F/R -> creator event (M/R) being killed (NONE_U32 = invalid free)
    ///   B/E -> index into `spans`
    ///   L   -> index into `logs`
    pub target: Vec<u32>,
    /// For R events: old geometry (resolved from target, else record copy).
    pub old_addr: Vec<u64>,
    pub old_size: Vec<u64>,
    /// For creator events (M/R): the event index that ends this allocation
    /// (an F/R that names it, or an M/R that overlaps it).
    pub death: Vec<u32>,
    /// User-assigned tag per creator event (0 = untagged). Session state,
    /// mutated by the viewer, not part of the wire format.
    pub tag: Vec<u8>,

    /// Implicit ends: (killer event, victim creator event), sorted by killer.
    /// A new M/R that overlaps live allocations ends every one of them here
    /// (its own F/R target, if any, is in `target` instead).
    pub kills: Vec<(u32, u32)>,

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

    // spans & logs
    pub spans: Vec<Span>,
    pub span_names: Vec<String>,
    pub logs: Vec<LogRec>,
    pub srcs: Vec<String>,

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
    pub n_span: u32,
    pub n_log: u32,

    pub warnings: Vec<Warning>,
    pub warn_counts: [u32; NWARN],

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

    /// Creator events implicitly ended by event `e` (overlap victims).
    pub fn kills_of(&self, e: u32) -> &[(u32, u32)] {
        let lo = self.kills.partition_point(|&(k, _)| k < e);
        let hi = self.kills.partition_point(|&(k, _)| k <= e);
        &self.kills[lo..hi]
    }

    /// Rendered byte span of a creator event (requested size or usable, whichever
    /// is larger; always at least 1 so zero-size flagged records still show).
    pub fn span(&self, e: u32) -> u64 {
        let e = e as usize;
        self.size[e].max(self.usable[e]).max(1)
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
