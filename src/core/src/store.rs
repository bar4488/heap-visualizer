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
    /// For E events: index into `ev_labels` of the record's `title`
    /// (NONE_U32 = unlabelled). Lazy column; read via `label_at`.
    pub label: Vec<u32>,
    /// For F/R events: index of the creating event (M/R) being killed.
    pub target: Vec<u32>,
    /// For R events only: old geometry (resolved from target, else record
    /// copy), keyed by event index. Side table so non-R events cost nothing.
    pub old_geom: std::collections::HashMap<u32, (u64, u64)>,
    /// For creator events (M/R): the event index that kills this allocation.
    pub death: Vec<u32>,
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
    /// Labels of custom (E) events. Interned like sites: a producer marking
    /// every frame writes the same handful of strings over and over.
    pub ev_labels: Vec<String>,
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
    /// Custom (E) events. Not an allocation count — kept apart from the three
    /// above so nothing sums them into one.
    pub n_custom: u32,

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

    /// Label intern index for event `e` (NONE_U32 = absent). Lazy column: only
    /// a trace carrying custom events materializes it.
    #[inline]
    pub fn label_at(&self, e: u32) -> u32 {
        if self.label.is_empty() {
            NONE_U32
        } else {
            self.label[e as usize]
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

    #[inline]
    pub fn has_tag(&self, e: u32, tag: u8) -> bool {
        if tag == 0 {
            return !self.has_tags(e);
        }
        let word = e as usize / 64;
        self.tag_members
            .get(tag as usize)
            .and_then(|bits| bits.get(word))
            .is_some_and(|bits| bits & (1 << (e % 64)) != 0)
    }

    #[inline]
    pub fn has_tags(&self, e: u32) -> bool {
        self.tag_any
            .get(e as usize / 64)
            .is_some_and(|w| w & (1 << (e % 64)) != 0)
    }

    /// Every tag on `e`, ascending. Scans the tags present in `e`'s 64-event
    /// block rather than every id in `tag_members`: clustered tagging — what
    /// tagging a range or a filter match set produces — puts one tag in a
    /// block, and the worst case is the number of tags in use.
    pub fn tag_ids(&self, e: u32) -> impl Iterator<Item = u8> + '_ {
        let mask = self.block_mask(e);
        BlockTags { mask, word: 0 }.filter(move |&tag| self.has_tag(e, tag))
    }

    #[inline]
    pub fn first_tag(&self, e: u32) -> u8 {
        self.tag_ids(e).next().unwrap_or(0)
    }

    /// The tag ids present anywhere in `e`'s block; zeroed when `e` is out of
    /// range or nothing has been tagged.
    #[inline]
    fn block_mask(&self, e: u32) -> [u64; 4] {
        self.tag_block
            .get(e as usize / 64)
            .copied()
            .unwrap_or([0; 4])
    }

    #[inline]
    fn is_creator(&self, e: u32) -> bool {
        matches!(self.op.get(e as usize), Some(&OP_M) | Some(&OP_R))
    }

    /// Total creator events, from the prefix sum the parser already built.
    #[inline]
    pub fn creator_count(&self) -> u32 {
        self.green_pre.last().copied().unwrap_or(0)
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

    /// Grow the derived bitsets to cover every event. Called before the first
    /// membership is recorded; a trace with no tags allocates none of this.
    fn ensure_tag_capacity(&mut self) {
        let words = (self.len() as usize).div_ceil(64);
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
        if self.has_tag(e, tag) {
            return;
        }
        self.ensure_tag_capacity();
        if !self.has_tags(e) {
            self.tagged += 1;
            self.set_any(e, true);
            if self.is_creator(e) {
                self.tag_count[0] += 1;
            }
        }
        if self.tag_members.len() <= tag as usize {
            self.tag_members.resize_with(tag as usize + 1, Vec::new);
        }
        let words = (self.len() as usize).div_ceil(64);
        let bits = &mut self.tag_members[tag as usize];
        bits.resize(words, 0);
        bits[e as usize / 64] |= 1 << (e % 64);
        self.tag_block[e as usize / 64][tag as usize / 64] |= 1 << (tag % 64);
        if self.is_creator(e) {
            self.tag_count[tag as usize] += 1;
        }
        self.tag_idx_dirty = true;
    }

    pub fn remove_tag(&mut self, e: u32, tag: u8) {
        if !self.has_tag(e, tag) || tag == 0 {
            return;
        }
        let block = e as usize / 64;
        let bits = &mut self.tag_members[tag as usize];
        bits[block] &= !(1 << (e % 64));
        // The block keeps advertising `tag` only while some event in it still
        // holds one — one word read, not a scan.
        if bits[block] == 0 {
            self.tag_block[block][tag as usize / 64] &= !(1 << (tag % 64));
        }
        if self.is_creator(e) {
            self.tag_count[tag as usize] -= 1;
        }
        if !self.has_any_tag_now(e) {
            self.tagged -= 1;
            self.set_any(e, false);
            if self.is_creator(e) {
                self.tag_count[0] -= 1;
            }
        }
        self.tag_idx_dirty = true;
    }

    pub fn clear_event_tags(&mut self, e: u32) {
        if !self.has_tags(e) {
            return;
        }
        let block = e as usize / 64;
        for tag in self.tag_ids(e).collect::<Vec<u8>>() {
            let bits = &mut self.tag_members[tag as usize];
            bits[block] &= !(1 << (e % 64));
            if bits[block] == 0 {
                self.tag_block[block][tag as usize / 64] &= !(1 << (tag % 64));
            }
            if self.is_creator(e) {
                self.tag_count[tag as usize] -= 1;
            }
        }
        self.tagged -= 1;
        self.set_any(e, false);
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

    /// Does `e` still hold any tag, read from the block mask? Used after a
    /// removal has already updated `tag_members` and the block.
    #[inline]
    fn has_any_tag_now(&self, e: u32) -> bool {
        let mask = self.block_mask(e);
        BlockTags { mask, word: 0 }.any(|tag| self.has_tag(e, tag))
    }

    /// Set or clear `e` in the union bitset, and the event that frees `e` in
    /// the free-side bitset — which is what spares the lane rebuild a scan.
    fn set_any(&mut self, e: u32, on: bool) {
        let (w, bit) = (e as usize / 64, 1u64 << (e % 64));
        if on {
            self.tag_any[w] |= bit;
        } else {
            self.tag_any[w] &= !bit;
        }
        let d = self.death.get(e as usize).copied().unwrap_or(NONE_U32);
        if d != NONE_U32 {
            let (dw, dbit) = (d as usize / 64, 1u64 << (d % 64));
            if on {
                self.tag_free_any[dw] |= dbit;
            } else {
                self.tag_free_any[dw] &= !dbit;
            }
        }
    }

    /// Rebuild `tag_alloc_idx` / `tag_free_idx` if tags changed since the last
    /// build. O(events / 64) over the two derived bitsets — the tag lanes read
    /// the result with a binary search per column.
    pub fn ensure_tag_index(&mut self) {
        if !self.tag_idx_dirty {
            return;
        }
        self.tag_alloc_idx.clear();
        self.tag_free_idx.clear();
        for w in 0..self.tag_any.len() {
            let mut bits = self.tag_any[w];
            while bits != 0 {
                let e = (w * 64) as u32 + bits.trailing_zeros();
                if self.is_creator(e) {
                    self.tag_alloc_idx.push(e);
                }
                bits &= bits - 1;
            }
            let mut bits = self.tag_free_any[w];
            while bits != 0 {
                self.tag_free_idx.push((w * 64) as u32 + bits.trailing_zeros());
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
        let words = (self.len() as usize).div_ceil(64);
        let (mut any, mut free_any) = (vec![0u64; words], vec![0u64; words]);
        let mut block = vec![[0u64; 4]; words];
        let mut count = [0u32; 256];
        let mut tagged = 0u32;
        for e in 0..self.len() {
            let mut some = false;
            for tag in 1..self.tag_members.len() {
                let bits = &self.tag_members[tag];
                if bits.get(e as usize / 64).is_some_and(|w| w & (1 << (e % 64)) != 0) {
                    some = true;
                    block[e as usize / 64][tag / 64] |= 1 << (tag % 64);
                    if self.is_creator(e) {
                        count[tag] += 1;
                    }
                }
            }
            if some {
                tagged += 1;
                any[e as usize / 64] |= 1 << (e % 64);
                if self.is_creator(e) {
                    count[0] += 1;
                }
                let d = self.death[e as usize];
                if d != NONE_U32 {
                    free_any[d as usize / 64] |= 1 << (d % 64);
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
