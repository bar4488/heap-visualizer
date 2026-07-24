//! Streaming JSONL parser: feed chunks of bytes, get a populated Store.
//!
//! Load-time work beyond raw decoding, all done in this single pass:
//!   - id -> creating-event resolution (target/death links)
//!   - liveness bookkeeping for warnings (double free, overlap) and snapshots
//!   - periodic live-set snapshots for fast seeking
//!   - prefix sums for timeline binning

use std::collections::{BTreeMap, HashMap};

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
    prev_t: u64,
    saw_t: bool,
    cur_live_bytes: u64,
    snap_interval: u32,
    site_map: HashMap<String, u32>,
    thr_map: HashMap<i64, u16>,
    stack_map: HashMap<String, u32>,
    extra_map: HashMap<String, u32>,
    seq_warned: bool,
}

#[derive(Default)]
struct Raw {
    op: u8, // b'M' | b'F' | b'R' | b'H' | 0
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
            prev_t: 0,
            saw_t: false,
            cur_live_bytes: 0,
            snap_interval: 16384,
            site_map: HashMap::new(),
            thr_map: HashMap::new(),
            stack_map: HashMap::new(),
            extra_map: HashMap::new(),
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
        self.site_map = HashMap::new();
        self.thr_map = HashMap::new();
        self.stack_map = HashMap::new();
        self.extra_map = HashMap::new();
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
        match parse_raw(line) {
            Some(raw) => self.apply(raw),
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

    fn intern_thr(&mut self, thr: i64) -> u16 {
        if let Some(&i) = self.thr_map.get(&thr) {
            return i;
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
        self.extra_map.insert(ex.clone(), i);
        self.store.extras.push(ex);
        i
    }

    fn apply(&mut self, mut raw: Raw) {
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

        let e = self.store.len();

        // timestamp: missing inherits previous; decreasing clamps
        let t = match raw.t {
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
        if let Some(sq) = raw.seq {
            if sq != e as i64 && !self.seq_warned {
                self.store.warn(e, W_SEQ_MISMATCH, sq as u64);
                self.seq_warned = true;
            }
        }

        let op = match raw.op {
            b'M' => OP_M,
            b'F' => OP_F,
            b'R' => OP_R,
            _ => {
                // unknown record type: forward-compat, ignore
                return;
            }
        };

        // op F with the reserved null id is a no-op record
        if op == OP_F && raw.id == Some(0) {
            return;
        }

        let site = match raw.site {
            Some(name) => self.intern_site(name),
            None => NONE_U32,
        };
        let thr_idx = match raw.thr {
            Some(v) => self.intern_thr(v),
            None => NONE_U16,
        };
        let stack = match raw.stack {
            Some(st) => self.intern_stack(st),
            None => NONE_U32,
        };
        let extra = if raw.extra.is_empty() {
            NONE_U32
        } else {
            self.intern_extra(std::mem::take(&mut raw.extra))
        };

        // resolve the killed allocation for F / R
        let mut target = NONE_U32;
        if op == OP_F || op == OP_R {
            let kid = if op == OP_F { raw.id } else { raw.old_id };
            match kid.and_then(|k| self.id_map.get(&k).copied()) {
                Some(ce) => {
                    if self.store.death[ce as usize] != NONE_U32 {
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
            addr = match raw.addr {
                Some(a) => a,
                None => {
                    // record is dropped (no event row): attach to the previous
                    // event, not the yet-unpushed next one
                    self.store
                        .warn(e.saturating_sub(1), W_MALFORMED, raw.id.unwrap_or(0));
                    return;
                }
            };
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
                o_addr = self.store.addr[target as usize];
                o_size = self.store.size[target as usize];
            } else {
                o_addr = raw.old_addr.unwrap_or(0);
                o_size = raw.old_size.unwrap_or(0);
            }
        }

        // ---- push the event row ----
        let s = &mut self.store;
        s.op.push(op);
        s.t.push(t);
        s.id.push(raw.id.unwrap_or(0));
        s.addr.push(addr);
        s.size.push(size);
        // lazy columns: materialize (backfilled with the default) only once a
        // real value appears, so traces without them pay no per-event memory
        push_lazy(&mut s.usable, e as usize, usable, 0);
        s.thr_idx.push(thr_idx);
        s.site.push(site);
        push_lazy(&mut s.stack, e as usize, stack, NONE_U32);
        push_lazy(&mut s.extra, e as usize, extra, NONE_U32);
        s.target.push(target);
        if op == OP_R && (o_addr != 0 || o_size != 0) {
            s.old_geom.insert(e, (o_addr, o_size));
        }
        s.death.push(NONE_U32);
        s.tag.push(0);

        let gp = *s.green_pre.last().unwrap_or(&0);
        let rp = *s.red_pre.last().unwrap_or(&0);
        if s.green_pre.is_empty() {
            s.green_pre.push(0);
            s.red_pre.push(0);
        }
        s.green_pre
            .push(gp + (op == OP_M || op == OP_R) as u32);
        s.red_pre.push(rp + (op == OP_F || op == OP_R) as u32);

        // ---- liveness bookkeeping ----
        if target != NONE_U32 {
            s.death[target as usize] = e;
            let ta = s.addr[target as usize];
            self.live.remove(&(ta, target));
            self.cur_live_bytes = self
                .cur_live_bytes
                .saturating_sub(s.size[target as usize]);
        }

        if op == OP_M || op == OP_R {
            let span = size.max(usable);
            let end = addr + span;

            // duplicate-id check + registration
            if let Some(id) = raw.id {
                if let Some(&prev) = self.id_map.get(&id) {
                    if s.death[prev as usize] == NONE_U32 {
                        s.warn(e, W_DUP_ID, id);
                    }
                }
                self.id_map.insert(id, e);
            }

            // overlap check against the live map. Walking left, the nearest
            // block by start address is not enough: a large earlier block can
            // cover `addr` even with other (non-overlapping) blocks between —
            // scan the whole window a live block could span, bounded by
            // max_span like the pick path.
            let mut overlaps = false;
            let floor = addr.saturating_sub(s.max_span.max(1));
            for (&(_, _), &pend) in self.live.range((floor, 0)..=(addr, u32::MAX)).rev() {
                if pend > addr {
                    overlaps = true;
                    break;
                }
            }
            if let Some((&(na, _), _)) = self.live.range((addr + 1, 0)..).next() {
                overlaps |= na < end;
            }
            if overlaps {
                s.warn(e, W_OVERLAP, addr);
                s.overlap_index.push((addr, e));
            }
            self.live.insert((addr, e), end);

            self.cur_live_bytes += size;
            s.peak_live_bytes = s.peak_live_bytes.max(self.cur_live_bytes);
            s.total_alloc_bytes += size;
            s.addr_min = s.addr_min.min(addr);
            s.addr_max = s.addr_max.max(end);
            s.max_span = s.max_span.max(span);
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
        let applied = e + 1;
        if applied % self.snap_interval == 0 {
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
            id: Vec::new(),
            addr: Vec::new(),
            size: Vec::new(),
            usable: Vec::new(),
            thr_idx: Vec::new(),
            site: Vec::new(),
            stack: Vec::new(),
            extra: Vec::new(),
            target: Vec::new(),
            old_geom: std::collections::HashMap::new(),
            death: Vec::new(),
            tag: Vec::new(),
            tagged: 0,
            tag_alloc_idx: Vec::new(),
            tag_free_idx: Vec::new(),
            tag_idx_dirty: false,
            green_pre: Vec::new(),
            red_pre: Vec::new(),
            sites: Vec::new(),
            site_count: Vec::new(),
            thrs: Vec::new(),
            thr_count: Vec::new(),
            stacks: Vec::new(),
            extras: Vec::new(),
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
            max_span: 0,
            peak_live_bytes: 0,
            total_alloc_bytes: 0,
            n_malloc: 0,
            n_free: 0,
            n_realloc: 0,
            warnings: Vec::new(),
            warn_counts: [0; NWARN],
            overlap_index: Vec::new(),
            snaps: Vec::new(),
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
            b"id" => raw.id = Some(sc.integer()? as u64),
            b"old_id" => raw.old_id = Some(sc.integer()? as u64),
            b"addr" => {
                let (a, b) = sc.string_span()?;
                raw.addr = parse_addr(&sc.b[a..b]);
            }
            b"old_addr" => {
                let (a, b) = sc.string_span()?;
                raw.old_addr = parse_addr(&sc.b[a..b]);
            }
            b"arena_base" => {
                let (a, b) = sc.string_span()?;
                raw.arena_base = parse_addr(&sc.b[a..b]);
            }
            b"size" => raw.size = Some(sc.integer()?.max(0) as u64),
            b"old_size" => raw.old_size = Some(sc.integer()?.max(0) as u64),
            b"usable" => raw.usable = Some(sc.integer()?.max(0) as u64),
            b"t" => raw.t = Some(sc.integer()?.max(0) as u64),
            b"seq" => raw.seq = Some(sc.integer()?),
            b"thr" => raw.thr = Some(sc.integer()?),
            b"v" => raw.v = Some(sc.integer()?),
            b"row_bytes" => raw.row_bytes = Some(sc.integer()?.max(0) as u64),
            b"site" => {
                let (a, b) = sc.string_span()?;
                raw.site = Some(unescape(&sc.b[a..b]));
            }
            b"unit" => {
                let (a, b) = sc.string_span()?;
                raw.unit = Some(unescape(&sc.b[a..b]));
            }
            b"title" => {
                let (a, b) = sc.string_span()?;
                raw.title = Some(unescape(&sc.b[a..b]));
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
            b"meta" => {
                let (a, b) = sc.skip_value()?;
                raw.meta = Some(String::from_utf8_lossy(&sc.b[a..b]).into_owned());
            }
            _ => {
                let key_str = unescape(&sc.b[ks..ke]);
                let (a, b) = sc.skip_value()?;
                if !raw.extra.is_empty() {
                    raw.extra.push(',');
                }
                push_json_str(&mut raw.extra, &key_str);
                raw.extra.push(':');
                raw.extra.push_str(&String::from_utf8_lossy(&sc.b[a..b]));
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
    Some(raw)
}
