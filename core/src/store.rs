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
    /// usable size hint (0 = absent). Rendered as a slack band.
    pub usable: Vec<u64>,
    pub thr_idx: Vec<u16>,
    pub site: Vec<u32>,
    pub stack: Vec<u32>,
    /// Index into `extras` of this event's caller-defined JSON fields
    /// (unrecognized top-level keys), interned as a raw JSON object body
    /// fragment; NONE_U32 = none.
    pub extra: Vec<u32>,
    /// For F/R events: index of the creating event (M/R) being killed.
    pub target: Vec<u32>,
    /// For R events: old geometry (resolved from target, else record copy).
    pub old_addr: Vec<u64>,
    pub old_size: Vec<u64>,
    /// For creator events (M/R): the event index that kills this allocation.
    pub death: Vec<u32>,
    /// User-assigned tag per creator event (0 = untagged). Session state,
    /// mutated by the viewer, not part of the wire format.
    pub tag: Vec<u8>,

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
