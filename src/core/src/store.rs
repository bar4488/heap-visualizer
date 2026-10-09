//! Columnar event store: the parsed trace, plus load-time derived indexes
//! (death links, snapshots, prefix sums, warnings).

pub const NONE_U32: u32 = u32::MAX;
pub const NONE_U16: u16 = u16::MAX;

pub const OP_M: u8 = 0;
pub const OP_F: u8 = 1;
pub const OP_R: u8 = 2;
/// A producer's own landmark record: it occupies a seq and carries a label
/// plus custom fields, and touches no allocation state whatsoever. Every
/// creator-walking path must skip it — it has no geometry to walk.
pub const OP_E: u8 = 3;
/// A structured log line: the log domain's record ([LOG-001]). It occupies a
/// seq on the spine and has no heap row at all — every heap accessor is for
/// heap records only (`domain::op_domain(op) == HEAP`).
///
/// [LOG-001]: ../../../spec/13-domains-and-logs.md#log-001-the-log-record-l
pub const OP_L: u8 = 4;
/// Interval edges (v2 only, [IVL-001]): `B` begins a call or a span, `X`
/// ends one, and `C` switches a CPU to a thread. Each occupies a seq and has
/// a row in the interval domain's store only.
///
/// [IVL-001]: ../../../spec/14-intervals.md
pub const OP_B: u8 = 5;
pub const OP_X: u8 = 6;
pub const OP_C: u8 = 7;

// Ops index `domain::OPS`, which maps each to its domain and kind.

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
pub const W_BAD_LEVEL: u8 = 9;
pub const W_LONG_LOG: u8 = 10;
pub const W_THREADS: u8 = 11;
// interval domain (IVL-006)
pub const W_UNMATCHED_END: u8 = 12;
pub const W_IMPLICIT_CLOSE: u8 = 13;
pub const W_UNCLOSED: u8 = 14;
pub const W_DUP_SPAN: u8 = 15;
pub const W_UNKNOWN_PARENT: u8 = 16;
pub const W_DEPTH_LIMIT: u8 = 17;
pub const W_TOO_MANY_OPEN: u8 = 18;
pub const W_DOUBLE_RUN: u8 = 19;
pub const W_LONG_FIELD: u8 = 20;
pub const NWARN: usize = 21;

/// The domain a warning code belongs to: its canonical name is
/// `<domain>.<warn_code_name>`. Bare names are unique across domains.
pub fn warn_domain(code: u8) -> &'static str {
    match code {
        W_MALFORMED | W_T_DECREASE | W_SEQ_MISMATCH | W_VERSION | W_THREADS | W_LONG_FIELD => "trace",
        W_UNKNOWN_ID | W_DOUBLE_FREE | W_DUP_ID | W_OVERLAP | W_BAD_SIZE => "heap",
        W_BAD_LEVEL | W_LONG_LOG => "log",
        W_DOUBLE_RUN => "sched",
        _ => "interval",
    }
}

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
        W_BAD_LEVEL => "unknown log level read as info",
        W_LONG_LOG => "log message truncated",
        W_THREADS => "too many threads; thread dropped",
        W_UNMATCHED_END => "interval end matches no open interval",
        W_IMPLICIT_CLOSE => "call frame closed by an outer end",
        W_UNCLOSED => "interval still open at trace end",
        W_DUP_SPAN => "span id already open",
        W_UNKNOWN_PARENT => "span parent unknown; span is a root",
        W_DEPTH_LIMIT => "interval depth limit reached",
        W_TOO_MANY_OPEN => "too many open spans",
        W_DOUBLE_RUN => "thread running on two CPUs",
        W_LONG_FIELD => "field truncated",
        _ => "warning",
    }
}

pub fn warn_code_name(code: u8) -> &'static str {
    match code {
        W_MALFORMED => "malformed_line",
        W_T_DECREASE => "decreasing_time",
        W_SEQ_MISMATCH => "sequence_mismatch",
        W_UNKNOWN_ID => "unknown_id",
        W_DOUBLE_FREE => "double_free",
        W_DUP_ID => "duplicate_id",
        W_OVERLAP => "overlap",
        W_BAD_SIZE => "invalid_size",
        W_VERSION => "unknown_version",
        W_BAD_LEVEL => "bad_level",
        W_LONG_LOG => "long_log",
        W_THREADS => "too_many_threads",
        W_UNMATCHED_END => "unmatched_end",
        W_IMPLICIT_CLOSE => "implicit_close",
        W_UNCLOSED => "unclosed",
        W_DUP_SPAN => "duplicate_span",
        W_UNKNOWN_PARENT => "unknown_parent",
        W_DEPTH_LIMIT => "depth_limit",
        W_TOO_MANY_OPEN => "too_many_open",
        W_DOUBLE_RUN => "double_run",
        W_LONG_FIELD => "long_field",
        _ => "warning",
    }
}

// Observed value shapes for a custom trace field, as a bitmask. A field is
// filterable only when it resolves to one scalar type (`null` is missingness,
// not a type of its own, so it never disqualifies a field).
pub const FIELD_NULL: u8 = 1 << 0;
pub const FIELD_BOOL: u8 = 1 << 1;
pub const FIELD_INT: u8 = 1 << 2;
pub const FIELD_STRING: u8 = 1 << 3;
/// An object or an array: present in the trace, displayable, not filterable.
pub const FIELD_OTHER: u8 = 1 << 4;
/// A number written with a fraction or an exponent.
pub const FIELD_FLOAT: u8 = 1 << 5;
/// The scalar bits, minus `null`.
pub const FIELD_SCALARS: u8 = FIELD_BOOL | FIELD_INT | FIELD_STRING | FIELD_FLOAT;

/// One caller-defined top-level field observed somewhere in the trace.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FieldInfo {
    pub name: String,
    /// Bitmask of the `FIELD_*` shapes this key was seen holding.
    pub types: u8,
    /// Events of any op carrying this key. `death.field.<k>` reads the death
    /// event's fragment, so a key seen only on `F` records is real; counting
    /// creators only would report it as absent.
    pub events: u32,
}

impl FieldInfo {
    /// The single scalar type this field can be filtered as, if there is one.
    /// `null` is ignored: it makes the field optional, not untyped.
    ///
    /// Integers and floats are one numeric type rather than a conflict: a
    /// producer writing `0` on one record and `0.5` on the next has written
    /// one number-valued field, and typing that as float loses nothing —
    /// comparison against an integer operand stays exact (T034).
    pub fn scalar(&self) -> Option<u8> {
        if self.types & FIELD_OTHER != 0 {
            return None;
        }
        let scalars = self.types & FIELD_SCALARS;
        if scalars == FIELD_INT | FIELD_FLOAT {
            return Some(FIELD_FLOAT);
        }
        (scalars.count_ones() == 1).then_some(scalars)
    }

    /// True when the key was ever absent-as-null or holds a non-scalar.
    pub fn optional(&self) -> bool {
        self.types & FIELD_NULL != 0
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

/// The heap domain's payload columns ([DOM-002]): one row per heap record
/// (`M`, `F`, `R`), never one per record of another domain — `E` landmarks
/// are the marks domain's. A row is addressed by its **spine index** through the
/// `Store` accessors (`addr(e)`, `size(e)`, …); the heap row behind it is the
/// spine index itself until a non-heap record exists, so a heap-only trace
/// pays nothing for the mapping.
///
/// Link values (`target`, `death`) are spine indexes: an allocation *is* its
/// creator's seq ([MODEL-002]) whatever domain shares the spine with it.
///
/// [DOM-002]: ../../../spec/13-domains-and-logs.md
/// [MODEL-002]: ../../../spec/03-core-model.md
pub struct HeapCols {
    pub id: Vec<u64>,
    pub addr: Vec<u64>,
    pub size: Vec<u64>,
    /// usable size hint (0 = absent). Rendered as a slack band. Lazy column:
    /// stays empty until the first event with a hint (empty = all zero), so
    /// traces without the hint pay nothing. Read via `usable_at`.
    pub usable: Vec<u64>,
    pub site: Vec<u32>,
    /// Lazy column like `usable` (empty = all NONE_U32). Read via `stack_at`.
    pub stack: Vec<u32>,
    /// Index into `extras` of this event's caller-defined JSON fields
    /// (unrecognized top-level keys), interned as a raw JSON object body
    /// fragment; NONE_U32 = none. Lazy column; read via `extra_at`.
    pub extra: Vec<u32>,
    /// For F/R events: spine index of the creating event (M/R) being killed.
    pub target: Vec<u32>,
    /// For creator events (M/R): the spine index that kills this allocation.
    pub death: Vec<u32>,
    /// Heap row -> spine index. Materialized together with `Store::hrank`,
    /// the first time a non-heap record arrives; empty = identity.
    pub seq: Vec<u32>,
    // prefix sums for timeline binning, over heap rows: count of green (M/R)
    // and red (F/R) marks in heap rows [0, i). An R contributes to both.
    // Always at least `[0]`.
    pub green_pre: Vec<u32>,
    pub red_pre: Vec<u32>,
    /// Creator (M/R) membership by heap row, as a bitset: the mask every
    /// allocation filter scan is intersected with. Built once at load so an
    /// apply never re-derives it.
    pub creators: Vec<u64>,
}

impl Default for HeapCols {
    fn default() -> Self {
        HeapCols {
            id: Vec::new(),
            addr: Vec::new(),
            size: Vec::new(),
            usable: Vec::new(),
            site: Vec::new(),
            stack: Vec::new(),
            extra: Vec::new(),
            target: Vec::new(),
            death: Vec::new(),
            seq: Vec::new(),
            green_pre: vec![0],
            red_pre: vec![0],
            creators: Vec::new(),
        }
    }
}

pub struct Store {
    // ---- the event spine (DOM-001): one row per record of any domain ----
    pub op: Vec<u8>,
    pub t: Vec<u64>,
    pub thr_idx: Vec<u16>,
    /// Spine -> heap rank: `hrank[b]` is the number of heap records in spine
    /// `[0, b)`, so a heap record's row is `hrank[e]`. Materialized only when
    /// a non-heap record exists; empty = identity (heap row = spine index).
    pub hrank: Vec<u32>,

    // ---- domains (DOM-002): each domain's payload store, keyed by spine ----
    pub dom: crate::domain::Domains,

    /// For R events only: old geometry (resolved from target, else record
    /// copy), keyed by event index. Side table so non-R events cost nothing.
    pub old_geom: std::collections::HashMap<u32, (u64, u64)>,
    /// Sparse bitset per tag id, indexed by creator event. Inner vectors are
    /// allocated only for tags that are actually used, so overlapping tags
    /// cost one bit per event per used tag rather than 255 bits per event.
    ///
    /// **The sole authority on membership** ([D009]). Everything below is a
    /// derived index: faster to ask, never a different answer, written only by
    /// the four mutation methods, and checked by `assert_tag_indexes`.
    ///
    /// [D009]: ../../../docs/decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md
    pub tag_members: Vec<Vec<u64>>,
    /// Derived: union of every tag bitset, so `has_tags` is one bit test
    /// instead of a scan over `tag_members`.
    pub(crate) tag_any: Vec<u64>,
    /// Derived: per 64-event block, a 256-bit mask of the tags holding any
    /// member in that block. Enumerating one event's tags scans the tags
    /// present near it rather than every id ever used — the whole point of
    /// [E020], where one tag at id 255 measured 206× the same tag at id 1.
    ///
    /// [E020]: ../../../docs/explorations/E020-tags-cost-tracks-the-highest-tag-id.md
    pub(crate) tag_block: Vec<[u64; 4]>,
    /// Derived: `tag_any` projected through `death` onto the freeing event, so
    /// the free-side lane index never scans to find out who died tagged.
    pub(crate) tag_free_any: Vec<u64>,
    /// Derived: tagged creators per tag id. **Index 0 is creators carrying at
    /// least one tag**, which is what makes it maintainable in `O(1)`;
    /// `tag_counts` turns it into the untagged count callers want. Maintained
    /// on mutation, so the refresh after a tag click reads 256 integers
    /// instead of rescanning the trace.
    pub(crate) tag_count: [u32; 256],
    /// Number of creator events currently tagged — lets per-frame consumers
    /// (the timeline tag lanes) skip tag work for untagged traces.
    pub tagged: u32,
    /// Sorted event indexes feeding the timeline tag lanes: creators with a
    /// tag, and F/R events whose target is tagged. Rebuilt lazily via
    /// `ensure_tag_index` after any tag mutation — O(events / 64) over the two
    /// derived bitsets, not a scan over every tag.
    pub(crate) tag_alloc_idx: Vec<u32>,
    pub(crate) tag_free_idx: Vec<u32>,
    pub(crate) tag_idx_dirty: bool,

    // interning tables
    pub sites: Vec<String>,
    pub site_count: Vec<u32>,
    pub thrs: Vec<i64>,
    pub thr_count: Vec<u32>,
    /// v2 only (empty in a v1 trace), parallel to `thrs`: the track's
    /// process. A v2 track is `(pid, thr?)`; `thrs` holds its `thr`.
    pub track_pid: Vec<u32>,
    /// v2 only, parallel to `thrs`: the track is its process's thread-less
    /// **process track** (its `thrs` entry is a placeholder 0).
    pub track_proc: Vec<bool>,
    /// v2 `T` names, by `(pid, thr?)`; the last name wins.
    pub track_names: std::collections::BTreeMap<(u32, Option<i64>), String>,
    pub stacks: Vec<String>,
    pub extras: Vec<String>,
    /// Catalog of the caller-defined top-level fields seen anywhere in the
    /// trace, in first-observation order. Built as fragments are interned —
    /// each distinct fragment is scanned once, never once per event — so a
    /// `&Store` can be type-checked against without a rebuild.
    pub fields: Vec<FieldInfo>,
    /// Parallel to `extras`: the `fields` indexes each interned fragment
    /// carries. Lets an event bump its keys' counts without re-scanning JSON.
    pub extra_fields: Vec<Vec<u32>>,

    // header
    pub has_header: bool,
    pub version: i64,
    /// The trace is read as v2: its first record is a header with `v` ≥ 2.
    pub v2: bool,
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
    pub peak_live_bytes: u64,
    pub total_alloc_bytes: u64,
    pub n_malloc: u32,
    pub n_free: u32,
    pub n_realloc: u32,
    /// Custom (E) events — the marks domain's row count. Not an allocation count — kept apart from the three
    /// above so nothing sums them into one.
    pub n_custom: u32,
    /// Log (L) records — the log domain's row count.
    pub n_log: u32,

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

    /// The `thr` of track `idx`: `None` for no track or a process track.
    #[inline]
    pub fn track_thr(&self, idx: u16) -> Option<i64> {
        if idx == NONE_U16 || self.track_proc.get(idx as usize) == Some(&true) {
            return None;
        }
        Some(self.thrs[idx as usize])
    }

    /// The `pid` of track `idx`, in a v2 trace.
    #[inline]
    pub fn track_pid_of(&self, idx: u16) -> Option<u32> {
        self.track_pid.get(idx as usize).copied()
    }

    /// The `T` name of track `idx`, if it has one.
    pub fn track_name(&self, idx: u16) -> Option<&str> {
        let pid = self.track_pid_of(idx)?;
        self.track_names.get(&(pid, self.track_thr(idx))).map(String::as_str)
    }

    pub fn warn(&mut self, seq: u32, code: u8, detail: u64) {
        self.warn_counts[code as usize] += 1;
        if self.warnings.len() < 1000 {
            self.warnings.push(Warning { seq, code, detail });
        }
    }

    /// Is spine record `e` a heap record? Decided by the op table
    /// ([`crate::domain::op_domain`]), never by op numbering.
    #[inline]
    pub fn is_heap(&self, e: u32) -> bool {
        self.op
            .get(e as usize)
            .is_some_and(|&op| crate::domain::op_domain(op) == crate::domain::HEAP)
    }

    /// Domain of spine record `e` (`domain::NO_DOMAIN` past the end).
    #[inline]
    pub fn domain_of(&self, e: u32) -> crate::domain::DomainId {
        self.op
            .get(e as usize)
            .map_or(crate::domain::NO_DOMAIN, |&op| crate::domain::op_domain(op))
    }

    /// Number of heap records in spine `[0, b)`. The identity until a
    /// non-heap record exists, which is what keeps a heap-only trace free of
    /// any per-event mapping cost.
    #[inline]
    pub fn heap_rank(&self, b: u32) -> u32 {
        if self.hrank.is_empty() {
            b
        } else {
            self.hrank[b as usize]
        }
    }

    /// Heap row of heap record `e`. Callers pass heap records only: for any
    /// other spine index the result is the next heap record's row.
    #[inline]
    fn hr(&self, e: u32) -> usize {
        debug_assert!(self.is_heap(e), "heap column read for non-heap record {e}");
        self.heap_rank(e) as usize
    }

    /// Heap row of `e` when it is a heap record — the checked form, for the
    /// generic per-record readers that may be handed any spine index.
    #[inline]
    pub fn heap_row(&self, e: u32) -> Option<usize> {
        if self.hrank.is_empty() {
            ((e as usize) < self.dom.heap.addr.len()).then_some(e as usize)
        } else if self.is_heap(e) {
            Some(self.hrank[e as usize] as usize)
        } else {
            None
        }
    }

    /// Spine index of heap row `h`.
    #[inline]
    pub fn heap_seq(&self, h: usize) -> u32 {
        if self.dom.heap.seq.is_empty() {
            h as u32
        } else {
            self.dom.heap.seq[h]
        }
    }

    /// Number of heap rows.
    #[inline]
    pub fn heap_len(&self) -> u32 {
        self.dom.heap.addr.len() as u32
    }

    /// Heap rows whose records lie in spine `[lo, hi)` — two rank lookups, so
    /// a range walk over heap records never visits another domain's records.
    #[inline]
    pub fn heap_rows(&self, lo: u32, hi: u32) -> std::ops::Range<usize> {
        let hi = hi.min(self.len());
        let lo = lo.min(hi);
        self.heap_rank(lo) as usize..self.heap_rank(hi) as usize
    }

    /// Spine indexes of the heap records in spine `[lo, hi)`, ascending.
    pub fn heap_events(&self, lo: u32, hi: u32) -> impl DoubleEndedIterator<Item = u32> + '_ {
        self.heap_rows(lo, hi).map(move |h| self.heap_seq(h))
    }

    /// Words in a bitset over heap rows — the shape of an allocation filter's
    /// match set and of every tag bitset.
    #[inline]
    pub fn row_words(&self) -> usize {
        (self.heap_len() as usize).div_ceil(64)
    }

    /// Is spine record `e` set in the heap-row bitset `bits`? A record with
    /// no heap row never is.
    #[inline]
    pub fn row_bit(&self, bits: &[u64], e: u32) -> bool {
        self.heap_row(e).is_some_and(|h| {
            bits.get(h / 64)
                .is_some_and(|w| w & (1 << (h % 64)) != 0)
        })
    }

    /// Spine indexes of the rows set in heap-row bitset `bits`, ascending.
    pub fn row_bits_events<'a>(&'a self, bits: &'a [u64]) -> impl Iterator<Item = u32> + 'a {
        bits.iter().enumerate().flat_map(move |(w, &word)| {
            let mut word = word;
            std::iter::from_fn(move || {
                if word == 0 {
                    return None;
                }
                let b = word.trailing_zeros() as usize;
                word &= word - 1;
                Some(self.heap_seq(w * 64 + b))
            })
        })
    }

    /// Creator events (M/R) in spine `[0, b)`, from the heap prefix sums.
    #[inline]
    pub fn green_before(&self, b: u32) -> u32 {
        self.dom.heap.green_pre[self.heap_rank(b) as usize]
    }

    /// Free marks (F/R) in spine `[0, b)`.
    #[inline]
    pub fn red_before(&self, b: u32) -> u32 {
        self.dom.heap.red_pre[self.heap_rank(b) as usize]
    }

    #[inline]
    pub fn id(&self, e: u32) -> u64 {
        self.dom.heap.id[self.hr(e)]
    }

    #[inline]
    pub fn addr(&self, e: u32) -> u64 {
        self.dom.heap.addr[self.hr(e)]
    }

    #[inline]
    pub fn size(&self, e: u32) -> u64 {
        self.dom.heap.size[self.hr(e)]
    }

    /// Site intern index of heap record `e` (NONE_U32 = absent).
    #[inline]
    pub fn site(&self, e: u32) -> u32 {
        self.dom.heap.site[self.hr(e)]
    }

    /// For F/R: the creator `e` kills (NONE_U32 = unresolved).
    #[inline]
    pub fn target(&self, e: u32) -> u32 {
        self.dom.heap.target[self.hr(e)]
    }

    /// For M/R: the event that kills `e` (NONE_U32 = never freed).
    #[inline]
    pub fn death(&self, e: u32) -> u32 {
        self.dom.heap.death[self.hr(e)]
    }

    /// Usable-size hint for event `e` (0 = absent). Lazy column: empty means
    /// no event in the trace carried the hint.
    #[inline]
    pub fn usable_at(&self, e: u32) -> u64 {
        if self.dom.heap.usable.is_empty() {
            0
        } else {
            self.dom.heap.usable[self.hr(e)]
        }
    }

    /// Stack intern index for event `e` (NONE_U32 = absent). Lazy column.
    #[inline]
    pub fn stack_at(&self, e: u32) -> u32 {
        if self.dom.heap.stack.is_empty() {
            NONE_U32
        } else {
            self.dom.heap.stack[self.hr(e)]
        }
    }

    /// Title intern index of mark record `e` (NONE_U32 = untitled, or not
    /// a mark); the title is `dom.marks.labels[i]`.
    #[inline]
    pub fn label_at(&self, e: u32) -> u32 {
        crate::domain::marks::row(self, e).map_or(NONE_U32, |r| self.dom.marks.label[r as usize])
    }

    /// Extra-fields intern index for heap record `e` (NONE_U32 = absent, or
    /// not a heap record — another domain keeps its own fields). Lazy column.
    #[inline]
    pub fn extra_at(&self, e: u32) -> u32 {
        if self.dom.heap.extra.is_empty() {
            return NONE_U32;
        }
        self.heap_row(e).map_or(NONE_U32, |h| self.dom.heap.extra[h])
    }

    /// Old (addr, size) geometry of the allocation an R event replaced;
    /// (0, 0) for anything else.
    #[inline]
    pub fn old_geom_at(&self, e: u32) -> (u64, u64) {
        self.old_geom.get(&e).copied().unwrap_or((0, 0))
    }

    /// Requested end `addr + size` of a creator event (exclusive, saturating)
    /// — the end every surface shows and `alloc.end` filters on. The slack
    /// band past it is `usable`, never part of the end.
    #[inline]
    pub fn end(&self, e: u32) -> u64 {
        self.addr(e).saturating_add(self.size(e))
    }

    /// Rendered byte span of a creator event (requested size or usable, whichever
    /// is larger; always at least 1 so zero-size flagged records still show).
    #[inline]
    pub fn span(&self, e: u32) -> u64 {
        self.size(e).max(self.usable_at(e)).max(1)
    }

    // ---- tags ----
    //
    // Tag bitsets are heap payload (DOM-002): bit positions are heap rows, so
    // a log record never costs a tag bit. Every method below takes a spine
    // index and converts once at entry; a non-heap record holds no tag and
    // cannot be given one.

    #[inline]
    pub fn has_tag(&self, e: u32, tag: u8) -> bool {
        match self.heap_row(e) {
            Some(h) => self.row_has_tag(h, tag),
            None => false,
        }
    }

    #[inline]
    fn row_has_tag(&self, h: usize, tag: u8) -> bool {
        if tag == 0 {
            return !self.row_has_tags(h);
        }
        self.tag_members
            .get(tag as usize)
            .and_then(|bits| bits.get(h / 64))
            .is_some_and(|bits| bits & (1 << (h % 64)) != 0)
    }

    #[inline]
    pub fn has_tags(&self, e: u32) -> bool {
        self.heap_row(e).is_some_and(|h| self.row_has_tags(h))
    }

    #[inline]
    fn row_has_tags(&self, h: usize) -> bool {
        self.tag_any
            .get(h / 64)
            .is_some_and(|w| w & (1 << (h % 64)) != 0)
    }

    /// Every tag on `e`, ascending. Scans the tags present in `e`'s 64-row
    /// block rather than every id in `tag_members`: clustered tagging — what
    /// tagging a range or a filter match set produces — puts one tag in a
    /// block, and the worst case is the number of tags in use.
    pub fn tag_ids(&self, e: u32) -> impl Iterator<Item = u8> + '_ {
        let h = self.heap_row(e);
        let mask = h.map_or([0; 4], |h| self.block_mask(h));
        BlockTags { mask, word: 0 }.filter(move |&tag| h.is_some_and(|h| self.row_has_tag(h, tag)))
    }

    /// Every tag on heap row `h`, ascending — `tag_ids` for a caller already
    /// working in heap rows.
    pub(crate) fn row_tag_ids(&self, h: usize) -> impl Iterator<Item = u8> + '_ {
        BlockTags { mask: self.block_mask(h), word: 0 }.filter(move |&tag| self.row_has_tag(h, tag))
    }

    #[inline]
    pub fn first_tag(&self, e: u32) -> u8 {
        self.tag_ids(e).next().unwrap_or(0)
    }

    /// The tag ids present anywhere in heap row `h`'s block; zeroed when `h`
    /// is out of range or nothing has been tagged.
    #[inline]
    fn block_mask(&self, h: usize) -> [u64; 4] {
        self.tag_block.get(h / 64).copied().unwrap_or([0; 4])
    }

    #[inline]
    fn is_creator(&self, e: u32) -> bool {
        matches!(self.op.get(e as usize), Some(&OP_M) | Some(&OP_R))
    }

    /// Total creator events, from the prefix sum the parser already built.
    #[inline]
    pub fn creator_count(&self) -> u32 {
        self.dom.heap.green_pre.last().copied().unwrap_or(0)
    }

    /// Tagged creators per tag id, with index 0 flipped to the **untagged**
    /// creator count callers expect. Maintained incrementally, so this is a
    /// read rather than a scan.
    #[inline]
    pub fn tag_counts(&self) -> [u32; 256] {
        let mut c = self.tag_count;
        c[0] = self.creator_count().saturating_sub(c[0]);
        c
    }

    /// Grow the derived bitsets to cover every heap row. Called before the
    /// first membership is recorded; a trace with no tags allocates none of
    /// this.
    fn ensure_tag_capacity(&mut self) {
        let words = (self.heap_len() as usize).div_ceil(64);
        if self.tag_any.len() < words {
            self.tag_any.resize(words, 0);
            self.tag_free_any.resize(words, 0);
            self.tag_block.resize(words, [0; 4]);
        }
    }

    /// Add one membership without disturbing the allocation's other tags.
    pub fn add_tag(&mut self, e: u32, tag: u8) {
        if tag == 0 {
            self.clear_event_tags(e);
            return;
        }
        let Some(h) = self.heap_row(e) else {
            return;
        };
        if self.row_has_tag(h, tag) {
            return;
        }
        self.ensure_tag_capacity();
        if !self.row_has_tags(h) {
            self.tagged += 1;
            self.set_any(e, h, true);
            if self.is_creator(e) {
                self.tag_count[0] += 1;
            }
        }
        if self.tag_members.len() <= tag as usize {
            self.tag_members.resize_with(tag as usize + 1, Vec::new);
        }
        let words = (self.heap_len() as usize).div_ceil(64);
        let bits = &mut self.tag_members[tag as usize];
        bits.resize(words, 0);
        bits[h / 64] |= 1 << (h % 64);
        self.tag_block[h / 64][tag as usize / 64] |= 1 << (tag % 64);
        if self.is_creator(e) {
            self.tag_count[tag as usize] += 1;
        }
        self.tag_idx_dirty = true;
    }

    pub fn remove_tag(&mut self, e: u32, tag: u8) {
        if tag == 0 {
            return;
        }
        let Some(h) = self.heap_row(e) else {
            return;
        };
        if !self.row_has_tag(h, tag) {
            return;
        }
        let block = h / 64;
        let bits = &mut self.tag_members[tag as usize];
        bits[block] &= !(1 << (h % 64));
        // The block keeps advertising `tag` only while some row in it still
        // holds one — one word read, not a scan.
        if bits[block] == 0 {
            self.tag_block[block][tag as usize / 64] &= !(1 << (tag % 64));
        }
        if self.is_creator(e) {
            self.tag_count[tag as usize] -= 1;
        }
        if !self.has_any_tag_now(h) {
            self.tagged -= 1;
            self.set_any(e, h, false);
            if self.is_creator(e) {
                self.tag_count[0] -= 1;
            }
        }
        self.tag_idx_dirty = true;
    }

    pub fn clear_event_tags(&mut self, e: u32) {
        let Some(h) = self.heap_row(e) else {
            return;
        };
        if !self.row_has_tags(h) {
            return;
        }
        let block = h / 64;
        for tag in self.tag_ids(e).collect::<Vec<u8>>() {
            let bits = &mut self.tag_members[tag as usize];
            bits[block] &= !(1 << (h % 64));
            if bits[block] == 0 {
                self.tag_block[block][tag as usize / 64] &= !(1 << (tag % 64));
            }
            if self.is_creator(e) {
                self.tag_count[tag as usize] -= 1;
            }
        }
        self.tagged -= 1;
        self.set_any(e, h, false);
        if self.is_creator(e) {
            self.tag_count[0] -= 1;
        }
        self.tag_idx_dirty = true;
    }

    /// Remove every tag assignment.
    pub fn clear_tags(&mut self) {
        self.tag_members.clear();
        self.tag_any.clear();
        self.tag_block.clear();
        self.tag_free_any.clear();
        self.tag_count = [0; 256];
        self.tagged = 0;
        self.tag_idx_dirty = true;
    }

    /// Does heap row `h` still hold any tag, read from the block mask? Used
    /// after a removal has already updated `tag_members` and the block.
    #[inline]
    fn has_any_tag_now(&self, h: usize) -> bool {
        let mask = self.block_mask(h);
        BlockTags { mask, word: 0 }.any(|tag| self.row_has_tag(h, tag))
    }

    /// Set or clear heap row `h` (spine `e`) in the union bitset, and the row
    /// that frees it in the free-side bitset — which is what spares the lane
    /// rebuild a scan.
    fn set_any(&mut self, e: u32, h: usize, on: bool) {
        let (w, bit) = (h / 64, 1u64 << (h % 64));
        if on {
            self.tag_any[w] |= bit;
        } else {
            self.tag_any[w] &= !bit;
        }
        let d = if self.is_creator(e) { self.death(e) } else { NONE_U32 };
        if d != NONE_U32 {
            let dh = self.hr(d);
            let (dw, dbit) = (dh / 64, 1u64 << (dh % 64));
            if on {
                self.tag_free_any[dw] |= dbit;
            } else {
                self.tag_free_any[dw] &= !dbit;
            }
        }
    }

    /// Rebuild `tag_alloc_idx` / `tag_free_idx` if tags changed since the last
    /// build. O(heap rows / 64) over the two derived bitsets — the tag lanes
    /// read the result with a binary search per column. The indexes hold
    /// spine indexes, sorted, because the lanes bin by spine.
    pub fn ensure_tag_index(&mut self) {
        if !self.tag_idx_dirty {
            return;
        }
        self.tag_alloc_idx.clear();
        self.tag_free_idx.clear();
        for w in 0..self.tag_any.len() {
            let mut bits = self.tag_any[w];
            while bits != 0 {
                let e = self.heap_seq(w * 64 + bits.trailing_zeros() as usize);
                if self.is_creator(e) {
                    self.tag_alloc_idx.push(e);
                }
                bits &= bits - 1;
            }
            let mut bits = self.tag_free_any[w];
            while bits != 0 {
                let e = self.heap_seq(w * 64 + bits.trailing_zeros() as usize);
                self.tag_free_idx.push(e);
                bits &= bits - 1;
            }
        }
        self.tag_idx_dirty = false;
    }

    /// Rebuild every derived tag index from `tag_members` and compare.
    /// [D009] makes this part of the contract rather than a test helper: an
    /// index that silently disagrees hides tags rather than slowing anything
    /// down, which is worse than the cost it removes.
    ///
    /// [D009]: ../../../docs/decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md
    #[cfg(any(test, debug_assertions))]
    pub fn assert_tag_indexes(&self) {
        let words = (self.heap_len() as usize).div_ceil(64);
        let (mut any, mut free_any) = (vec![0u64; words], vec![0u64; words]);
        let mut block = vec![[0u64; 4]; words];
        let mut count = [0u32; 256];
        let mut tagged = 0u32;
        for h in 0..self.heap_len() as usize {
            let e = self.heap_seq(h);
            let mut some = false;
            for tag in 1..self.tag_members.len() {
                let bits = &self.tag_members[tag];
                if bits.get(h / 64).is_some_and(|w| w & (1 << (h % 64)) != 0) {
                    some = true;
                    block[h / 64][tag / 64] |= 1 << (tag % 64);
                    if self.is_creator(e) {
                        count[tag] += 1;
                    }
                }
            }
            if some {
                tagged += 1;
                any[h / 64] |= 1 << (h % 64);
                if self.is_creator(e) {
                    count[0] += 1;
                    let d = self.death(e);
                    if d != NONE_U32 {
                        let dh = self.hr(d);
                        free_any[dh / 64] |= 1 << (dh % 64);
                    }
                }
            }
        }
        let trim = |v: &Vec<u64>| {
            let mut v = v.clone();
            v.truncate(words);
            v.resize(words, 0);
            v
        };
        assert_eq!(trim(&self.tag_any), any, "tag_any disagrees with tag_members");
        assert_eq!(
            trim(&self.tag_free_any),
            free_any,
            "tag_free_any disagrees with tag_members"
        );
        let mut have = self.tag_block.clone();
        have.resize(words, [0; 4]);
        assert_eq!(have, block, "tag_block disagrees with tag_members");
        assert_eq!(self.tag_count, count, "tag_count disagrees with tag_members");
        assert_eq!(self.tagged, tagged, "tagged disagrees with tag_members");
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

/// Ascending tag ids in a 256-bit block mask.
struct BlockTags {
    mask: [u64; 4],
    word: usize,
}

impl Iterator for BlockTags {
    type Item = u8;

    fn next(&mut self) -> Option<u8> {
        while self.word < 4 {
            let w = self.mask[self.word];
            if w == 0 {
                self.word += 1;
                continue;
            }
            let bit = w.trailing_zeros();
            self.mask[self.word] &= w - 1;
            return Some((self.word * 64 + bit as usize) as u8);
        }
        None
    }
}
