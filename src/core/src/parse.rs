//! Streaming JSONL parser: feed chunks of bytes, get a populated Store.
//!
//! Load-time work beyond raw decoding, all done in this single pass:
//!   - id -> creating-event resolution (target/death links)
//!   - liveness bookkeeping for warnings (double free, overlap) and snapshots
//!   - periodic live-set snapshots for fast seeking
//!   - prefix sums for timeline binning

use std::collections::{BTreeMap, HashMap};

use crate::domain::point::PointStore;
use crate::json::{parse_addr, push_json_str, unescape, Scan};
use crate::store::*;

const SNAP_MAX: usize = 96;

pub struct Parser {
    pub store: Store,
    carry: Vec<u8>,
    /// id -> creating event index, for every id ever seen (liveness = death[e]).
    id_map: HashMap<u64, u32>,
    /// live regions keyed by (addr, event): value = end address. Used for
    /// overlap warnings and to take snapshots.
    live: BTreeMap<(u64, u32), u64>,
    /// Multiset of the spans in `live`, so the overlap walk-back is bounded
    /// by the widest block *currently live* — one early huge allocation,
    /// once freed, must not make every later check scan the whole window.
    live_spans: BTreeMap<u64, u32>,
    prev_t: u64,
    saw_t: bool,
    cur_live_bytes: u64,
    snap_interval: u32,
    site_map: HashMap<String, u32>,
    thr_map: HashMap<i64, u16>,
    stack_map: HashMap<String, u32>,
    label_map: HashMap<String, u32>,
    extra_map: HashMap<String, u32>,
    /// Custom field name -> index into `store.fields`.
    field_map: HashMap<String, u32>,
    logger_map: HashMap<String, u32>,
    log_frag_map: HashMap<String, u32>,
    /// Log custom field name -> index into the log domain's own catalog.
    log_field_map: HashMap<String, u32>,
    seq_warned: bool,
}

#[derive(Default)]
struct Raw {
    op: u8, // b'M' | b'F' | b'R' | b'E' | b'H' | 0
    id: Option<u64>,
    old_id: Option<u64>,
    addr: Option<u64>,
    old_addr: Option<u64>,
    size: Option<u64>,
    old_size: Option<u64>,
    usable: Option<u64>,
    t: Option<u64>,
    seq: Option<i64>,
    thr: Option<i64>,
    site: Option<String>,
    stack: Option<String>,
    /// Raw JSON object body fragment (`"k":v,"k2":v2`) of unrecognized
    /// top-level keys, verbatim from the source (already valid JSON text).
    extra: String,
    // header fields
    v: Option<i64>,
    unit: Option<String>,
    title: Option<String>,
    row_bytes: Option<u64>,
    arena_base: Option<u64>,
    meta: Option<String>,
}

impl Parser {
    pub fn new() -> Self {
        Parser {
            store: Store::default(),
            carry: Vec::new(),
            id_map: HashMap::new(),
            live: BTreeMap::new(),
            live_spans: BTreeMap::new(),
            prev_t: 0,
            saw_t: false,
            cur_live_bytes: 0,
            snap_interval: 16384,
            site_map: HashMap::new(),
            thr_map: HashMap::new(),
            stack_map: HashMap::new(),
            label_map: HashMap::new(),
            extra_map: HashMap::new(),
            field_map: HashMap::new(),
            logger_map: HashMap::new(),
            log_frag_map: HashMap::new(),
            log_field_map: HashMap::new(),
            seq_warned: false,
        }
    }

    pub fn chunk(&mut self, data: &[u8]) {
        let mut start = 0usize;
        if !self.carry.is_empty() {
            match data.iter().position(|&c| c == b'\n') {
                Some(nl) => {
                    let mut line = std::mem::take(&mut self.carry);
                    line.extend_from_slice(&data[..nl]);
                    self.line(&line);
                    start = nl + 1;
                }
                None => {
                    self.carry.extend_from_slice(data);
                    return;
                }
            }
        }
        let mut i = start;
        while i < data.len() {
            match data[i..].iter().position(|&c| c == b'\n') {
                Some(off) => {
                    self.line(&data[i..i + off]);
                    i += off + 1;
                }
                None => {
                    self.carry.extend_from_slice(&data[i..]);
                    break;
                }
            }
        }
    }

    pub fn finish(&mut self) {
        let line = std::mem::take(&mut self.carry);
        if !line.is_empty() {
            self.line(&line);
        }
        let s = &mut self.store;
        s.t_max = self.prev_t;
        if s.len() == 0 {
            s.t_min = 0;
            s.t_max = 0;
        }
        if s.addr_min == u64::MAX {
            s.addr_min = s.arena_base;
            s.addr_max = s.arena_base;
        }
        // ghost candidates are queried by address range at render time
        s.overlap_index.sort_unstable();
        // free load-time maps
        self.id_map = HashMap::new();
        self.live = BTreeMap::new();
        self.live_spans = BTreeMap::new();
        self.site_map = HashMap::new();
        self.thr_map = HashMap::new();
        self.stack_map = HashMap::new();
        self.label_map = HashMap::new();
        self.extra_map = HashMap::new();
        self.field_map = HashMap::new();
        self.logger_map = HashMap::new();
        self.log_frag_map = HashMap::new();
        self.log_field_map = HashMap::new();
    }

    fn line(&mut self, line: &[u8]) {
        // trim, skip blank / comment lines
        let mut a = 0;
        let mut b = line.len();
        while a < b && (line[a] == b' ' || line[a] == b'\t' || line[a] == b'\r') {
            a += 1;
        }
        while b > a && (line[b - 1] == b' ' || line[b - 1] == b'\t' || line[b - 1] == b'\r') {
            b -= 1;
        }
        if a == b || line[a] == b'#' {
            return;
        }
        let line = &line[a..b];
        // A log line is read by its own domain's parser: its keys mean
        // something else there, and every other key is a custom field. The
        // record's `op` is peeked first so each line is normally read once.
        //
        // The peek only picks which reader goes first. The outcome is the
        // same whichever does: a heap read naming any op but `L` is a heap
        // record, else a log read naming `L` is a log record (a log line
        // whose keys the heap reader cannot type, `"size":"x"`, included),
        // else the line is malformed. The second reader runs only on the rare
        // line the first rejects — a malformed one, or one repeating `op`.
        let log = if peek_op(line) == Some(b"L") {
            match crate::logs::parse_log_line(line) {
                Some(log) => Some(log),
                None => match parse_raw(line) {
                    Some(raw) if raw.op != b'L' => return self.apply(raw),
                    _ => None,
                },
            }
        } else {
            match parse_raw(line) {
                Some(raw) if raw.op != b'L' => return self.apply(raw),
                _ => crate::logs::parse_log_line(line),
            }
        };
        match log {
            Some(log) => self.apply_log(log),
            None => {
                // no event row is produced: attach to the previous event so
                // "jump to warning" lands where the bad line sat in the stream
                let seq = self.store.len().saturating_sub(1);
                self.store.warn(seq, W_MALFORMED, 0);
            }
        }
    }

    fn intern_site(&mut self, name: String) -> u32 {
        if let Some(&i) = self.site_map.get(&name) {
            return i;
        }
        let i = self.store.sites.len() as u32;
        self.site_map.insert(name.clone(), i);
        self.store.sites.push(name);
        self.store.site_count.push(0);
        i
    }

    /// Thread intern index for record `e`. The column is 16-bit with
    /// `NONE_U16` reserved, so at most 65,535 distinct threads are kept; a
    /// record on any thread past that reads as thread-less and is flagged
    /// rather than aliasing another thread's index.
    fn intern_thr(&mut self, thr: i64, e: u32) -> u16 {
        if let Some(&i) = self.thr_map.get(&thr) {
            return i;
        }
        if self.store.thrs.len() >= NONE_U16 as usize {
            self.store.warn(e, W_THREADS, thr as u64);
            return NONE_U16;
        }
        let i = self.store.thrs.len() as u16;
        self.thr_map.insert(thr, i);
        self.store.thrs.push(thr);
        self.store.thr_count.push(0);
        i
    }

    fn intern_stack(&mut self, st: String) -> u32 {
        if let Some(&i) = self.stack_map.get(&st) {
            return i;
        }
        let i = self.store.stacks.len() as u32;
        self.stack_map.insert(st.clone(), i);
        self.store.stacks.push(st);
        i
    }

    fn intern_extra(&mut self, ex: String) -> u32 {
        if let Some(&i) = self.extra_map.get(&ex) {
            return i;
        }
        let i = self.store.extras.len() as u32;
        // The catalog is built here, on the fragment that is new, so each
        // distinct combination of custom keys is scanned exactly once however
        // many events carry it.
        let members = catalog_fragment(&mut self.field_map, &mut self.store.fields, &ex);
        self.extra_map.insert(ex.clone(), i);
        self.store.extras.push(ex);
        self.store.extra_fields.push(members);
        i
    }

    /// Append one record to the event spine (DOM-001). The spine -> heap rank
    /// is materialized the first time a non-heap record arrives — until then
    /// every record is a heap record and the heap row is the spine index, so
    /// a heap-only trace never builds the mapping.
    fn push_spine(&mut self, op: u8, t: u64, thr_idx: u16) {
        let heap = crate::domain::op_domain(op) == crate::domain::HEAP;
        let s = &mut self.store;
        let e = s.len();
        if !heap && s.hrank.is_empty() {
            debug_assert_eq!(s.dom.heap.addr.len(), e as usize);
            s.hrank = (0..=e).collect();
            s.dom.heap.seq = (0..e).collect();
        }
        s.op.push(op);
        s.t.push(t);
        s.thr_idx.push(thr_idx);
        if let Some(&r) = s.hrank.last() {
            s.hrank.push(r + heap as u32);
            if heap {
                s.dom.heap.seq.push(e);
            }
        }
    }

    fn apply(&mut self, raw: Raw) {
        if raw.op == b'H' {
            let s = &mut self.store;
            s.has_header = true;
            s.version = raw.v.unwrap_or(1);
            if s.version != 1 {
                let seq = s.len().saturating_sub(1);
                s.warn(seq, W_VERSION, s.version as u64);
            }
            if let Some(u) = raw.unit {
                s.unit = u;
            }
            if let Some(t) = raw.title {
                s.title = t;
            }
            if let Some(rb) = raw.row_bytes {
                s.hdr_row_bytes = rb;
            }
            if let Some(ab) = raw.arena_base {
                s.arena_base = ab;
            }
            if let Some(m) = raw.meta {
                s.meta_raw = m;
            }
            return;
        }

        // Every record that will be dropped (TRACE-009) is decided here,
        // before anything is stamped or interned: a dropped record must leave
        // no trace — no clock movement, no catalogued site or field, and no
        // warning pinned to whichever record comes next.
        // the op table names every record type; a letter it does not know
        // (or one another domain's reader owns) is ignored: forward-compat
        let Some(op) = crate::domain::op_for_letter(raw.op).filter(|&op| op != OP_L) else {
            return;
        };
        // op F with the reserved null id is a no-op record
        if op == OP_F && raw.id == Some(0) {
            return;
        }
        if (op == OP_M || op == OP_R) && raw.addr.is_none() {
            // no event row is produced: attach to the previous event
            let seq = self.store.len().saturating_sub(1);
            self.store.warn(seq, W_MALFORMED, raw.id.unwrap_or(0));
            return;
        }

        let (e, t) = self.stamp(raw.t, raw.seq);
        if op == OP_E {
            self.apply_mark(raw, e, t);
        } else {
            self.apply_heap(raw, op, e, t);
        }
    }

    /// Timestamp and seq checks shared by every domain's records (TRACE-007):
    /// a missing `t` inherits, a decreasing one clamps, and a `seq` that
    /// disagrees with stream position is flagged once. Returns the spine
    /// index the record will take and its timestamp.
    fn stamp(&mut self, t: Option<u64>, seq: Option<i64>) -> (u32, u64) {
        let e = self.store.len();
        let t = match t {
            Some(t) => {
                if self.saw_t && t < self.prev_t {
                    self.store.warn(e, W_T_DECREASE, t);
                    self.prev_t
                } else {
                    t
                }
            }
            None => self.prev_t,
        };
        if !self.saw_t {
            self.store.t_min = t;
            self.saw_t = true;
        }
        self.prev_t = t;

        // seq sanity (stream order is authoritative regardless)
        if let Some(sq) = seq {
            if sq != e as i64 && !self.seq_warned {
                self.store.warn(e, W_SEQ_MISMATCH, sq as u64);
                self.seq_warned = true;
            }
        }
        (e, t)
    }

    /// One `E` landmark (TRACE-010): a spine row and a mark row, nothing
    /// else. `site` and `stack` describe an allocation, so they are not read
    /// off a mark — a site nobody ever allocated from would sit in the legend
    /// at count zero. Its custom fields go to the trace-wide fragment table
    /// and catalog, as they did when marks were heap rows.
    fn apply_mark(&mut self, mut raw: Raw, e: u32, t: u64) {
        let label = match raw.title.take() {
            Some(title) => intern_label(&mut self.label_map, &mut self.store.dom.marks, title),
            None => NONE_U32,
        };
        let thr_idx = match raw.thr {
            Some(v) => self.intern_thr(v, e),
            None => NONE_U16,
        };
        let extra = self.intern_counted_extra(&mut raw.extra);
        self.push_spine(OP_E, t, thr_idx);
        self.store.dom.marks.push(e, 0, label, "", extra);
        self.store.n_custom += 1;
    }

    /// Intern a heap-or-mark fragment in the trace-wide table and count one
    /// more event on each of its keys. NONE_U32 for an empty fragment.
    fn intern_counted_extra(&mut self, extra: &mut String) -> u32 {
        if extra.is_empty() {
            return NONE_U32;
        }
        let index = self.intern_extra(std::mem::take(extra));
        // exact per-key event counts, without re-scanning the fragment
        for i in 0..self.store.extra_fields[index as usize].len() {
            let field = self.store.extra_fields[index as usize][i] as usize;
            self.store.fields[field].events += 1;
        }
        index
    }

    /// One `L` record (LOG-001): a spine row and a log row, nothing else.
    fn apply_log(&mut self, mut log: crate::logs::RawLog) {
        use crate::logs::{truncate_msg, LevelRead, LEVEL_INFO};
        let Some(mut msg) = log.msg.take() else {
            // no event row is produced, as for any other dropped record
            let seq = self.store.len().saturating_sub(1);
            self.store.warn(seq, W_MALFORMED, 0);
            return;
        };
        let (e, t) = self.stamp(log.t, log.seq);
        let level = match log.level() {
            LevelRead::Known(level) => level,
            LevelRead::Absent => LEVEL_INFO,
            LevelRead::Bad => {
                self.store.warn(e, W_BAD_LEVEL, 0);
                LEVEL_INFO
            }
        };
        let full = msg.len();
        if truncate_msg(&mut msg) {
            self.store.warn(e, W_LONG_LOG, full as u64);
        }
        let thr_idx = match log.thr {
            Some(v) => self.intern_thr(v, e),
            None => NONE_U16,
        };
        let logger = match log.logger.take() {
            Some(name) => intern_label(&mut self.logger_map, &mut self.store.dom.logs, name),
            None => NONE_U32,
        };
        let fields = if log.extra.is_empty() {
            NONE_U32
        } else {
            intern_frag(
                &mut self.log_frag_map,
                &mut self.log_field_map,
                &mut self.store.dom.logs,
                std::mem::take(&mut log.extra),
            )
        };
        self.push_spine(OP_L, t, thr_idx);
        self.store.dom.logs.push(e, level, logger, &msg, fields);
        self.store.n_log += 1;
    }

    fn apply_heap(&mut self, mut raw: Raw, op: u8, e: u32, t: u64) {
        let site = match raw.site {
            Some(name) => self.intern_site(name),
            None => NONE_U32,
        };
        let thr_idx = match raw.thr {
            Some(v) => self.intern_thr(v, e),
            None => NONE_U16,
        };
        let stack = match raw.stack {
            Some(st) => self.intern_stack(st),
            None => NONE_U32,
        };
        let extra = self.intern_counted_extra(&mut raw.extra);

        // resolve the killed allocation for F / R
        let mut target = NONE_U32;
        if op == OP_F || op == OP_R {
            let kid = if op == OP_F { raw.id } else { raw.old_id };
            match kid.and_then(|k| self.id_map.get(&k).copied()) {
                Some(ce) => {
                    if self.store.death(ce) != NONE_U32 {
                        self.store.warn(e, W_DOUBLE_FREE, kid.unwrap_or(0));
                    } else {
                        target = ce;
                    }
                }
                None => {
                    self.store.warn(e, W_UNKNOWN_ID, kid.unwrap_or(0));
                }
            }
        }

        // geometry of the new allocation for M / R
        let (mut addr, mut size, mut usable) = (0u64, 0u64, 0u64);
        if op == OP_M || op == OP_R {
            // `apply` has already dropped a creator without an address
            addr = raw.addr.unwrap_or(0);
            size = raw.size.unwrap_or(0);
            if size == 0 {
                self.store.warn(e, W_BAD_SIZE, raw.id.unwrap_or(0));
                size = 1;
            }
            usable = raw.usable.unwrap_or(0);
            if usable <= size {
                usable = 0;
            }
        }

        // old geometry for R (prefer the resolved creator, fall back to record)
        let (mut o_addr, mut o_size) = (0u64, 0u64);
        if op == OP_R {
            if target != NONE_U32 {
                o_addr = self.store.addr(target);
                o_size = self.store.size(target);
            } else {
                o_addr = raw.old_addr.unwrap_or(0);
                o_size = raw.old_size.unwrap_or(0);
            }
        }

        // ---- push the spine row, then the heap row ----
        self.push_spine(op, t, thr_idx);
        let s = &mut self.store;
        let h = s.dom.heap.addr.len();
        let hc = &mut s.dom.heap;
        hc.id.push(raw.id.unwrap_or(0));
        hc.addr.push(addr);
        hc.size.push(size);
        // lazy columns: materialize (backfilled with the default) only once a
        // real value appears, so traces without them pay no per-row memory
        push_lazy(&mut hc.usable, h, usable, 0);
        hc.site.push(site);
        push_lazy(&mut hc.stack, h, stack, NONE_U32);
        push_lazy(&mut hc.extra, h, extra, NONE_U32);
        hc.target.push(target);
        hc.death.push(NONE_U32);
        let gp = hc.green_pre[h];
        let rp = hc.red_pre[h];
        hc.green_pre.push(gp + (op == OP_M || op == OP_R) as u32);
        if h.is_multiple_of(64) {
            hc.creators.push(0);
        }
        if op == OP_M || op == OP_R {
            hc.creators[h / 64] |= 1 << (h % 64);
        }
        hc.red_pre.push(rp + (op == OP_F || op == OP_R) as u32);
        if op == OP_R && (o_addr != 0 || o_size != 0) {
            s.old_geom.insert(e, (o_addr, o_size));
        }

        // ---- liveness bookkeeping ----
        if target != NONE_U32 {
            let th = s.heap_rank(target) as usize;
            s.dom.heap.death[th] = e;
            let ta = s.addr(target);
            if let Some(tend) = self.live.remove(&(ta, target)) {
                multiset_remove(&mut self.live_spans, tend - ta);
            }
            self.cur_live_bytes = self.cur_live_bytes.saturating_sub(s.size(target));
        }

        if op == OP_M || op == OP_R {
            let span = size.max(usable);
            // Malformed geometry is warning-worthy input, not a reason for a
            // debug build to panic or a release build to wrap back to zero.
            let end = addr.saturating_add(span);

            // duplicate-id check + registration
            if let Some(id) = raw.id {
                if let Some(&prev) = self.id_map.get(&id) {
                    if s.death(prev) == NONE_U32 {
                        s.warn(e, W_DUP_ID, id);
                    }
                }
                self.id_map.insert(id, e);
            }

            // overlap check against the live map. Walking left, the nearest
            // block by start address is not enough: a large earlier block can
            // cover `addr` even with other (non-overlapping) blocks between —
            // scan the whole window a live block could span, bounded by the
            // widest block live right now (not the widest ever seen).
            let mut overlaps = false;
            let widest = self.live_spans.keys().next_back().copied().unwrap_or(0);
            let floor = addr.saturating_sub(widest.max(1));
            for (&(_, _), &pend) in self.live.range((floor, 0)..=(addr, u32::MAX)).rev() {
                if pend > addr {
                    overlaps = true;
                    break;
                }
            }
            if addr != u64::MAX {
                if let Some((&(na, _), _)) = self.live.range((addr + 1, 0)..).next() {
                    overlaps |= na < end;
                }
            }
            if overlaps {
                s.warn(e, W_OVERLAP, addr);
                s.overlap_index.push((addr, e));
            }
            self.live.insert((addr, e), end);
            *self.live_spans.entry(end - addr).or_insert(0) += 1;

            self.cur_live_bytes += size;
            s.peak_live_bytes = s.peak_live_bytes.max(self.cur_live_bytes);
            s.total_alloc_bytes += size;
            s.addr_min = s.addr_min.min(addr);
            s.addr_max = s.addr_max.max(end);
            if site != NONE_U32 {
                s.site_count[site as usize] += 1;
            }
            if thr_idx != NONE_U16 {
                s.thr_count[thr_idx as usize] += 1;
            }
        }

        match op {
            OP_M => s.n_malloc += 1,
            OP_F => s.n_free += 1,
            _ => s.n_realloc += 1,
        }

        // ---- periodic snapshot ----
        // Cadence counts heap rows, so records of other domains never make
        // snapshots denser; the position stored is the spine count applied.
        let applied = e + 1;
        if (h as u32 + 1) % self.snap_interval == 0 {
            let mut lv: Vec<u32> = self.live.keys().map(|&(_, ev)| ev).collect();
            lv.sort_unstable();
            s.snaps.push((applied, lv));
            if s.snaps.len() >= SNAP_MAX {
                // thin out: keep every other snapshot, double the interval
                let old = std::mem::take(&mut s.snaps);
                s.snaps = old
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| i % 2 == 1)
                    .map(|(_, v)| v)
                    .collect();
                self.snap_interval *= 2;
            }
        }
    }
}

impl Default for Store {
    fn default() -> Self {
        Store {
            op: Vec::new(),
            t: Vec::new(),
            thr_idx: Vec::new(),
            hrank: Vec::new(),
            dom: crate::domain::Domains::default(),
            old_geom: std::collections::HashMap::new(),
            tag_members: Vec::new(),
            tag_any: Vec::new(),
            tag_block: Vec::new(),
            tag_free_any: Vec::new(),
            tag_count: [0; 256],
            tagged: 0,
            tag_alloc_idx: Vec::new(),
            tag_free_idx: Vec::new(),
            tag_idx_dirty: false,
            sites: Vec::new(),
            site_count: Vec::new(),
            thrs: Vec::new(),
            thr_count: Vec::new(),
            stacks: Vec::new(),
            extras: Vec::new(),
            fields: Vec::new(),
            extra_fields: Vec::new(),
            has_header: false,
            version: 1,
            unit: "ns".to_string(),
            title: String::new(),
            hdr_row_bytes: 0,
            arena_base: 0,
            meta_raw: String::new(),
            t_min: 0,
            t_max: 0,
            addr_min: u64::MAX,
            addr_max: 0,
            peak_live_bytes: 0,
            total_alloc_bytes: 0,
            n_malloc: 0,
            n_free: 0,
            n_realloc: 0,
            n_custom: 0,
            n_log: 0,
            warnings: Vec::new(),
            warn_counts: [0; NWARN],
            overlap_index: Vec::new(),
            snaps: Vec::new(),
        }
    }
}

/// Intern `name` in a point store's label dictionary (a logger, a title).
fn intern_label<const N: usize>(map: &mut HashMap<String, u32>, p: &mut PointStore<N>, name: String) -> u32 {
    if let Some(&i) = map.get(&name) {
        return i;
    }
    let i = p.labels.len() as u32;
    map.insert(name.clone(), i);
    p.labels.push(name);
    p.label_count.push(0);
    i
}

/// Intern a custom-field fragment in a point store's own fragment table,
/// cataloguing a new fragment's keys in the domain's own field catalog
/// (`field_map` names its entries) once, and counting this record on each.
fn intern_frag<const N: usize>(
    map: &mut HashMap<String, u32>,
    field_map: &mut HashMap<String, u32>,
    p: &mut PointStore<N>,
    frag: String,
) -> u32 {
    let i = match map.get(&frag) {
        Some(&i) => i,
        None => {
            let i = p.frags.len() as u32;
            let members = catalog_fragment(field_map, &mut p.catalog, &frag);
            map.insert(frag.clone(), i);
            p.frags.push(frag);
            p.frag_fields.push(members);
            i
        }
    };
    for &field in &p.frag_fields[i as usize] {
        p.catalog[field as usize].events += 1;
    }
    i
}

/// Record every key of one raw object-body fragment (`"k":v,"k2":v2`) in
/// a field catalog (the trace's, or one domain's), returning the catalog indexes
/// it carries.
fn catalog_fragment(field_map: &mut HashMap<String, u32>, catalog: &mut Vec<FieldInfo>, ex: &str) -> Vec<u32> {
    let bytes = ex.as_bytes();
    let mut sc = Scan::new(bytes);
    let mut members = Vec::new();
    loop {
        let Some((lo, hi)) = sc.string_span() else {
            break;
        };
        if !sc.eat(b':') {
            break;
        }
        sc.ws();
        let head = sc.peek();
        let Some((vlo, vhi)) = sc.skip_value() else {
            break;
        };
        let shape = match head {
            b'"' => FIELD_STRING,
            b't' | b'f' => FIELD_BOOL,
            b'n' => FIELD_NULL,
            b'{' | b'[' => FIELD_OTHER,
            // a number: a fraction or an exponent makes it a float, and
            // the two are one numeric type at the catalog level (T034)
            _ => {
                if bytes[vlo..vhi]
                    .iter()
                    .any(|c| matches!(c, b'.' | b'e' | b'E'))
                {
                    FIELD_FLOAT
                } else {
                    FIELD_INT
                }
            }
        };
        let name = unescape(&bytes[lo..hi]);
        let index = match field_map.get(&name) {
            Some(&index) => index,
            None => {
                let index = catalog.len() as u32;
                field_map.insert(name.clone(), index);
                catalog.push(FieldInfo {
                    name,
                    types: 0,
                    events: 0,
                });
                index
            }
        };
        catalog[index as usize].types |= shape;
        // a fragment repeating a key counts once; the value the evaluator
        // will read is the last, so the duplicate is not a second member
        if !members.contains(&index) {
            members.push(index);
        }
        if !sc.eat(b',') {
            break;
        }
    }
    members
}


/// Drop one occurrence of `key` from a counted multiset.
fn multiset_remove(set: &mut BTreeMap<u64, u32>, key: u64) {
    if let Some(c) = set.get_mut(&key) {
        *c -= 1;
        if *c == 0 {
            set.remove(&key);
        }
    }
}

/// Push to a lazy column: while every value so far equals `default` the
/// column stays empty; the first real value backfills `default` up to `e`.
fn push_lazy<T: Copy + PartialEq>(col: &mut Vec<T>, e: usize, v: T, default: T) {
    if col.is_empty() {
        if v == default {
            return;
        }
        col.resize(e, default);
    }
    col.push(v);
}

/// A key whose meaning depends on the record's `op` ([TRACE-001]): read as
/// its defined field only on the op that defines it, and an ordinary custom
/// field everywhere else. Field order is free, so these are held as spans and
/// resolved once the whole line — and therefore `op` — has been read.
///
/// [TRACE-001]: ../../../spec/02-trace-format.md#trace-001-general-rules
#[derive(Clone, Copy, PartialEq)]
enum OpKey {
    V,
    Unit,
    Title,
    RowBytes,
    ArenaBase,
    Meta,
    OldId,
    OldAddr,
    OldSize,
}

impl OpKey {
    fn of(key: &[u8]) -> Option<Self> {
        Some(match key {
            b"v" => OpKey::V,
            b"unit" => OpKey::Unit,
            b"title" => OpKey::Title,
            b"row_bytes" => OpKey::RowBytes,
            b"arena_base" => OpKey::ArenaBase,
            b"meta" => OpKey::Meta,
            b"old_id" => OpKey::OldId,
            b"old_addr" => OpKey::OldAddr,
            b"old_size" => OpKey::OldSize,
            _ => return None,
        })
    }

    /// Does record type `op` define this key?
    fn defined_on(self, op: u8) -> bool {
        match self {
            OpKey::Title => op == b'H' || op == b'E',
            OpKey::OldId | OpKey::OldAddr | OpKey::OldSize => op == b'R',
            _ => op == b'H',
        }
    }

    /// Read the value text `v` into `raw`; `None` when it has the wrong shape.
    fn read(self, v: &[u8], raw: &mut Raw) -> Option<()> {
        let mut sc = Scan::new(v);
        match self {
            OpKey::V => raw.v = Some(sc.integer()?),
            OpKey::Unit | OpKey::Title => {
                let (a, b) = sc.string_span()?;
                let text = Some(unescape(&v[a..b]));
                if self == OpKey::Unit {
                    raw.unit = text;
                } else {
                    raw.title = text;
                }
            }
            OpKey::RowBytes => raw.row_bytes = Some(sc.unsigned_integer()?),
            OpKey::ArenaBase | OpKey::OldAddr => {
                let (a, b) = sc.string_span()?;
                let addr = parse_addr(&v[a..b]);
                if self == OpKey::ArenaBase {
                    raw.arena_base = addr;
                } else {
                    raw.old_addr = addr;
                }
            }
            OpKey::Meta => raw.meta = Some(String::from_utf8_lossy(v).into_owned()),
            OpKey::OldId => raw.old_id = Some(sc.unsigned_integer()?),
            OpKey::OldSize => raw.old_size = Some(sc.unsigned_integer()?),
        }
        Some(())
    }
}

/// The raw text of the first top-level `op` value, when the line is an object
/// that gets that far. The values before it are skipped, never decoded, so
/// this costs a fraction of either reader; `Parser::line` uses it only to
/// choose which reader to try first.
fn peek_op(line: &[u8]) -> Option<&[u8]> {
    let mut sc = Scan::new(line);
    if !sc.eat(b'{') {
        return None;
    }
    loop {
        let (ks, ke) = sc.string_span()?;
        if !sc.eat(b':') {
            return None;
        }
        if &line[ks..ke] == b"op" {
            let (a, b) = sc.string_span()?;
            return Some(&line[a..b]);
        }
        sc.skip_value()?;
        if !sc.eat(b',') {
            return None;
        }
    }
}

fn parse_raw(line: &[u8]) -> Option<Raw> {
    let mut sc = Scan::new(line);
    if !sc.eat(b'{') {
        return None;
    }
    let mut raw = Raw::default();
    // empty object?
    sc.ws();
    if sc.peek() == b'}' {
        return None; // no op field
    }
    // Keys that are custom fields, or may be once `op` is known, in source
    // order: (key span, value span, op-dependent meaning).
    type Deferred = ((usize, usize), (usize, usize), Option<OpKey>);
    let mut rest: Vec<Deferred> = Vec::new();
    loop {
        let (ks, ke) = sc.string_span()?;
        if !sc.eat(b':') {
            return None;
        }
        let key = &sc.b[ks..ke];
        match key {
            b"op" => {
                let (a, b) = sc.string_span()?;
                raw.op = if b - a == 1 { sc.b[a] } else { 0 };
            }
            b"id" => raw.id = Some(sc.unsigned_integer()?),
            b"addr" => {
                let (a, b) = sc.string_span()?;
                raw.addr = parse_addr(&sc.b[a..b]);
            }
            b"size" => raw.size = Some(sc.unsigned_integer()?),
            b"usable" => raw.usable = Some(sc.unsigned_integer()?),
            b"t" => raw.t = Some(sc.unsigned_integer()?),
            b"seq" => raw.seq = Some(sc.integer()?),
            b"thr" => raw.thr = Some(sc.integer()?),
            b"site" => {
                let (a, b) = sc.string_span()?;
                raw.site = Some(unescape(&sc.b[a..b]));
            }
            b"stack" => {
                // array of strings, joined with newlines (outermost-last kept as-is)
                sc.ws();
                if sc.peek() == b'[' {
                    sc.i += 1;
                    let mut joined = String::new();
                    loop {
                        sc.ws();
                        if sc.peek() == b']' {
                            sc.i += 1;
                            break;
                        }
                        if sc.peek() == b'"' {
                            let (a, b) = sc.string_span()?;
                            if !joined.is_empty() {
                                joined.push('\n');
                            }
                            joined.push_str(&unescape(&sc.b[a..b]));
                        } else {
                            sc.skip_value()?;
                        }
                        sc.ws();
                        if sc.peek() == b',' {
                            sc.i += 1;
                        }
                    }
                    raw.stack = Some(joined);
                } else {
                    sc.skip_value()?;
                }
            }
            _ => {
                let span = sc.skip_value()?;
                rest.push(((ks, ke), span, OpKey::of(key)));
            }
        }
        sc.ws();
        if sc.peek() == b',' {
            sc.i += 1;
            continue;
        }
        if sc.peek() == b'}' {
            break;
        }
        return None;
    }
    if raw.op == 0 {
        return None;
    }
    for ((ks, ke), (a, b), key) in rest {
        match key {
            Some(key) if key.defined_on(raw.op) => key.read(&line[a..b], &mut raw)?,
            _ => {
                if !raw.extra.is_empty() {
                    raw.extra.push(',');
                }
                push_json_str(&mut raw.extra, &unescape(&line[ks..ke]));
                raw.extra.push(':');
                raw.extra.push_str(&String::from_utf8_lossy(&line[a..b]));
            }
        }
    }
    Some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(input: &str) -> Store {
        let mut p = Parser::new();
        p.chunk(input.as_bytes());
        p.finish();
        p.store
    }

    fn field_names(s: &Store) -> Vec<&str> {
        s.fields.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn op_specific_keys_are_custom_fields_elsewhere() {
        let s = load(concat!(
            r#"{"op":"H","v":1,"title":"trace","unit":"us"}"#, "\n",
            r#"{"op":"M","id":1,"addr":"0x10","size":4,"title":"t","meta":{"k":1},"v":"two","unit":3,"old_id":5}"#, "\n",
            r#"{"old_id":1,"op":"R","id":2,"addr":"0x20","size":8,"old_size":4}"#, "\n",
            r#"{"op":"F","id":2,"old_addr":7}"#, "\n",
        ));
        assert_eq!(s.len(), 3, "no line is malformed");
        assert_eq!(s.warn_counts[W_MALFORMED as usize], 0);
        assert_eq!((s.title.as_str(), s.unit.as_str()), ("trace", "us"));
        assert_eq!(field_names(&s), ["title", "meta", "v", "unit", "old_id", "old_addr"]);
        // the R record still reads its own `old_id`, whatever the key order
        assert_eq!(s.target(1), 0);
        assert_eq!(s.extra_at(1), NONE_U32);
        assert_eq!(
            s.extras[s.extra_at(0) as usize],
            r#""title":"t","meta":{"k":1},"v":"two","unit":3,"old_id":5"#
        );
    }

    /// The `op` peek only orders the two readers; a line whose first `op`
    /// disagrees with its last (the one both readers act on) still reads as
    /// the last says, and a log line the heap reader cannot type stays a log.
    #[test]
    fn the_op_peek_never_changes_which_domain_reads_a_line() {
        assert_eq!(peek_op(br#"{"t":3,"seq":{"op":"M"},"op":"L"}"#), Some(&b"L"[..]));
        assert_eq!(peek_op(br#"{"t":3}"#), None);
        let s = load(concat!(
            r#"{"op":"L","op":"M","id":1,"addr":"0x10","size":4,"msg":"m"}"#, "\n",
            r#"{"op":"M","op":"L","id":2,"addr":"0x20","size":4,"msg":"m"}"#, "\n",
            r#"{"t":5,"size":"x","op":"L","msg":"untypable for the heap"}"#, "\n",
            r#"{"op":"L","msg":7}"#, "\n",
        ));
        assert_eq!(s.op, [OP_M, OP_L, OP_L]);
        assert_eq!(s.warn_counts[W_MALFORMED as usize], 1);
    }

    #[test]
    fn a_defined_key_with_the_wrong_shape_is_still_malformed() {
        let s = load(concat!(
            r#"{"op":"R","id":2,"old_id":"x","addr":"0x20","size":8}"#, "\n",
            r#"{"op":"E","title":3}"#, "\n",
        ));
        assert_eq!(s.len(), 0);
        assert_eq!(s.warn_counts[W_MALFORMED as usize], 2);
    }

    #[test]
    fn dropped_records_leave_no_trace() {
        let s = load(concat!(
            r#"{"op":"X","t":900,"seq":4,"site":"x","thr":9,"k1":1}"#, "\n",
            r#"{"op":"F","id":0,"t":900,"seq":4,"thr":8,"k2":1}"#, "\n",
            r#"{"op":"M","id":3,"t":900,"seq":4,"site":"y","thr":7,"stack":["s"],"k3":1}"#, "\n",
            r#"{"op":"M","id":1,"addr":"0x10","size":4,"t":100}"#, "\n",
        ));
        assert_eq!(s.len(), 1);
        assert_eq!((s.t_min, s.t_max), (100, 100));
        assert!(s.sites.is_empty() && s.thrs.is_empty() && s.stacks.is_empty());
        assert!(s.fields.is_empty() && s.extras.is_empty());
        // the malformed creator is the only warning; nothing is pinned on the
        // record that follows
        assert_eq!(s.warn_counts.iter().sum::<u32>(), 1);
        assert_eq!(s.warn_counts[W_MALFORMED as usize], 1);
    }

    #[test]
    fn overlap_walk_ignores_freed_wide_blocks_but_finds_live_ones() {
        let mut t = String::from(concat!(
            r#"{"op":"M","id":1,"addr":"0x0","size":1099511627776}"#, "\n",
            r#"{"op":"F","id":1}"#, "\n",
        ));
        for i in 0..64u64 {
            t.push_str(&format!(
                "{{\"op\":\"M\",\"id\":{},\"addr\":\"0x{:x}\",\"size\":16}}\n",
                i + 2,
                0x1000 + i * 32
            ));
        }
        // a live wide block, with a non-overlapping freed block between it
        // and the nested one
        t.push_str(concat!(
            r#"{"op":"M","id":100,"addr":"0x100000","size":65536}"#, "\n",
            r#"{"op":"M","id":101,"addr":"0x100000","size":16}"#, "\n",
            r#"{"op":"F","id":101}"#, "\n",
            r#"{"op":"M","id":102,"addr":"0x108000","size":16}"#, "\n",
        ));
        let s = load(&t);
        assert_eq!(s.warn_counts[W_OVERLAP as usize], 2);
        let flagged: Vec<u64> = s.overlap_index.iter().map(|&(a, _)| a).collect();
        assert_eq!(flagged, [0x100000, 0x108000]);
    }

    #[test]
    fn threads_past_the_column_capacity_are_dropped_not_aliased() {
        let mut t = String::new();
        for thr in 0..=NONE_U16 as u64 {
            t.push_str(&format!("{{\"op\":\"E\",\"thr\":{thr}}}\n"));
        }
        t.push_str("{\"op\":\"E\",\"thr\":0}\n");
        let s = load(&t);
        let n = s.len() as usize;
        assert_eq!(s.thrs.len(), NONE_U16 as usize);
        assert_eq!(s.thr_idx[n - 3], NONE_U16 - 1);
        assert_eq!(s.thr_idx[n - 2], NONE_U16, "the 65,536th thread is not interned");
        assert_eq!(s.thr_idx[n - 1], 0);
        assert_eq!(s.warn_counts[W_THREADS as usize], 1);
    }
}
