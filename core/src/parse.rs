//! Streaming JSONL parser: feed chunks of bytes, get a populated Store.
//!
//! v2 wire format (see docs/spec-v2-draft.md): no `seq`, no `id` — stream
//! order is authoritative and frees name allocations by address. Load-time
//! work beyond raw decoding, all done in this single pass:
//!   - addr -> creating-event resolution (target/death links)
//!   - anomaly detection (invalid free, overlap with implicit end)
//!   - span (B/E) matching into a span table, log (L) collection
//!   - periodic live-set snapshots for fast seeking
//!   - prefix sums for timeline binning

use std::collections::{BTreeMap, HashMap};

use crate::json::{parse_addr, push_json_str, unescape, Scan};
use crate::store::*;

const SNAP_MAX: usize = 96;

pub struct Parser {
    pub store: Store,
    carry: Vec<u8>,
    /// Multi-file (run) mode: records are staged per file and merged by `t`
    /// at finish — stable, per-file order preserved on ties, earlier file
    /// wins ties. Event indices are assigned over the merged stream.
    staging: bool,
    stage: Vec<Vec<Raw>>,
    /// Decode-time `t` inheritance for the current staged file (an absent
    /// `t` means "same as the previous event of this file").
    file_prev_t: u64,
    /// Live regions: base addr -> (creating event, end addr). The live set
    /// guarantees at most one live allocation per base address, so the
    /// address is the key frees resolve through.
    live: BTreeMap<u64, (u32, u64)>,
    /// Open-span stacks per lane (thr_idx; NONE_U16 = the global lane).
    open_spans: HashMap<u16, Vec<u32>>,
    prev_t: u64,
    saw_t: bool,
    cur_live_bytes: u64,
    snap_interval: u32,
    site_map: HashMap<String, u32>,
    thr_map: HashMap<i64, u16>,
    stack_map: HashMap<String, u32>,
    extra_map: HashMap<String, u32>,
    span_name_map: HashMap<String, u32>,
    src_map: HashMap<String, u32>,
}

#[derive(Default)]
struct Raw {
    op: u8, // b'M' | b'F' | b'R' | b'B' | b'E' | b'L' | b'H' | 0
    addr: Option<u64>,
    old_addr: Option<u64>,
    size: Option<u64>,
    usable: Option<u64>,
    t: Option<u64>,
    thr: Option<i64>,
    site: Option<String>,
    stack: Option<String>,
    name: Option<String>,
    msg: Option<String>,
    lvl: Option<String>,
    src: Option<String>,
    /// Raw JSON object body fragment (`"k":v,"k2":v2`) of unrecognized
    /// top-level keys (incl. B `args` / L `fields`), verbatim from the
    /// source (already valid JSON text).
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
            staging: false,
            stage: Vec::new(),
            file_prev_t: 0,
            live: BTreeMap::new(),
            open_spans: HashMap::new(),
            prev_t: 0,
            saw_t: false,
            cur_live_bytes: 0,
            snap_interval: 16384,
            site_map: HashMap::new(),
            thr_map: HashMap::new(),
            stack_map: HashMap::new(),
            extra_map: HashMap::new(),
            span_name_map: HashMap::new(),
            src_map: HashMap::new(),
        }
    }

    /// Enable multi-file (run) staging when the run has more than one file.
    /// Must be called before any chunk.
    pub fn begin_files(&mut self, n: u32) {
        self.staging = n > 1;
    }

    /// Start the next file of the run. Flushes a trailing unterminated line
    /// of the previous file and resets per-file `t` inheritance.
    pub fn file_begin(&mut self) {
        let line = std::mem::take(&mut self.carry);
        if !line.is_empty() {
            self.line(&line);
        }
        self.file_prev_t = 0;
        if self.staging {
            self.stage.push(Vec::new());
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
        if self.staging {
            // k-way merge of the staged files by resolved t; ties keep the
            // earlier file, and within a file stream order is preserved
            let stage = std::mem::take(&mut self.stage);
            let mut iters: Vec<std::iter::Peekable<std::vec::IntoIter<Raw>>> =
                stage.into_iter().map(|v| v.into_iter().peekable()).collect();
            loop {
                let mut best: Option<(u64, usize)> = None;
                for (i, it) in iters.iter_mut().enumerate() {
                    if let Some(r) = it.peek() {
                        let t = r.t.unwrap_or(0);
                        if best.map_or(true, |(bt, _)| t < bt) {
                            best = Some((t, i));
                        }
                    }
                }
                match best {
                    Some((_, i)) => {
                        let raw = iters[i].next().unwrap();
                        self.apply(raw);
                    }
                    None => break,
                }
            }
            self.staging = false;
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
        // spans still open at end-of-stream keep end = NONE_U32: the
        // consumer renders them to the last event
        s.n_span = s.spans.len() as u32;
        s.n_log = s.logs.len() as u32;
        // free load-time maps
        self.live = BTreeMap::new();
        self.open_spans = HashMap::new();
        self.site_map = HashMap::new();
        self.thr_map = HashMap::new();
        self.stack_map = HashMap::new();
        self.extra_map = HashMap::new();
        self.span_name_map = HashMap::new();
        self.src_map = HashMap::new();
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
            Some(mut raw) => {
                if self.staging && raw.op != b'H' {
                    // resolve per-file t inheritance now — the merged stream
                    // has no notion of "this file's previous event"
                    let t = raw.t.unwrap_or(self.file_prev_t);
                    self.file_prev_t = t;
                    raw.t = Some(t);
                    self.stage.last_mut().expect("file_begin not called").push(raw);
                } else {
                    self.apply(raw);
                }
            }
            None => {
                let seq = if self.staging { NONE_U32 } else { self.store.len() };
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

    fn intern_span_name(&mut self, name: String) -> u32 {
        if let Some(&i) = self.span_name_map.get(&name) {
            return i;
        }
        let i = self.store.span_names.len() as u32;
        self.span_name_map.insert(name.clone(), i);
        self.store.span_names.push(name);
        i
    }

    fn intern_src(&mut self, src: String) -> u32 {
        if let Some(&i) = self.src_map.get(&src) {
            return i;
        }
        let i = self.store.srcs.len() as u32;
        self.src_map.insert(src.clone(), i);
        self.store.srcs.push(src);
        i
    }

    fn apply(&mut self, mut raw: Raw) {
        if raw.op == b'H' {
            let s = &mut self.store;
            s.has_header = true;
            s.version = raw.v.unwrap_or(2);
            if s.version != 2 {
                let seq = s.len();
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

        let op = match raw.op {
            b'M' => OP_M,
            b'F' => OP_F,
            b'R' => OP_R,
            b'B' => OP_B,
            b'E' => OP_E,
            b'L' => OP_L,
            _ => {
                // unknown record type: robustness, skip
                return;
            }
        };

        let e = self.store.len();

        // required-field checks that make a line unusable
        let missing = match op {
            OP_M => raw.addr.is_none(),
            OP_F => raw.addr.is_none(),
            OP_R => raw.addr.is_none() || raw.old_addr.is_none(),
            OP_B => raw.name.is_none(),
            OP_L => raw.msg.is_none(),
            _ => false,
        };
        if missing {
            self.store.warn(e, W_MALFORMED, 0);
            return;
        }

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

        let thr_idx = match raw.thr {
            Some(v) => self.intern_thr(v),
            None => NONE_U16,
        };

        // ---- span matching (B/E). An E with no open span on its lane and
        // no name is ignored entirely (spec I.3), so resolve before the row
        // is committed.
        let mut span_target = NONE_U32;
        if op == OP_B {
            let name = self.intern_span_name(raw.name.take().unwrap());
            let idx = self.store.spans.len() as u32;
            self.store.spans.push(Span {
                name,
                thr_idx,
                begin: e,
                end: NONE_U32,
            });
            self.open_spans.entry(thr_idx).or_default().push(idx);
            span_target = idx;
        } else if op == OP_E {
            match self.open_spans.entry(thr_idx).or_default().pop() {
                Some(idx) => {
                    self.store.spans[idx as usize].end = e;
                    span_target = idx;
                    if let Some(name) = raw.name.take() {
                        let open_name =
                            &self.store.span_names[self.store.spans[idx as usize].name as usize];
                        if *open_name != name {
                            self.store.warn(e, W_SPAN_MISMATCH, idx as u64);
                        }
                    }
                }
                None => match raw.name.take() {
                    // began before the trace started: renders from the first
                    // event to this E
                    Some(name) => {
                        let name = self.intern_span_name(name);
                        let idx = self.store.spans.len() as u32;
                        self.store.spans.push(Span {
                            name,
                            thr_idx,
                            begin: NONE_U32,
                            end: e,
                        });
                        span_target = idx;
                    }
                    None => return, // nothing to close, nothing to name: ignore
                },
            }
        }

        if !self.saw_t {
            self.store.t_min = t;
            self.saw_t = true;
        }
        self.prev_t = t;

        let site = match raw.site {
            Some(name) => self.intern_site(name),
            None => NONE_U32,
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

        // ---- resolve the ended allocation for F / R by address ----
        let mut target = NONE_U32;
        if op == OP_F || op == OP_R {
            let key = if op == OP_F { raw.addr } else { raw.old_addr };
            let key = key.unwrap();
            match self.live.remove(&key) {
                Some((ce, _)) => target = ce,
                None => self.store.warn(e, W_INVALID_FREE, key),
            }
        } else if op == OP_L {
            let lvl = match raw.lvl.as_deref() {
                Some("trace") => 0,
                Some("debug") => 1,
                Some("warn") => 3,
                Some("error") => 4,
                Some("fatal") => 5,
                _ => LVL_INFO,
            };
            let src = match raw.src.take() {
                Some(s) => self.intern_src(s),
                None => NONE_U32,
            };
            target = self.store.logs.len() as u32;
            self.store.logs.push(LogRec {
                msg: raw.msg.take().unwrap(),
                lvl,
                src,
            });
        } else if op == OP_B || op == OP_E {
            target = span_target;
        }

        // geometry of the new allocation for M / R
        let (mut addr, mut size, mut usable) = (0u64, 0u64, 0u64);
        if op == OP_M || op == OP_R {
            addr = raw.addr.unwrap();
            size = raw.size.unwrap_or(0);
            if size == 0 {
                self.store.warn(e, W_BAD_SIZE, addr);
                size = 1;
            }
            usable = raw.usable.unwrap_or(0);
            if usable <= size {
                usable = 0;
            }
        } else if op == OP_F {
            // the named address, kept for anomaly display; geometry comes
            // from the target
            addr = raw.addr.unwrap();
        }

        // old geometry for R (prefer the resolved creator, fall back to record)
        let (mut o_addr, mut o_size) = (0u64, 0u64);
        if op == OP_R {
            if target != NONE_U32 {
                o_addr = self.store.addr[target as usize];
                o_size = self.store.size[target as usize];
            } else {
                o_addr = raw.old_addr.unwrap_or(0);
            }
        }

        // ---- push the event row ----
        let s = &mut self.store;
        s.op.push(op);
        s.t.push(t);
        s.addr.push(addr);
        s.size.push(size);
        s.usable.push(usable);
        s.thr_idx.push(thr_idx);
        s.site.push(site);
        s.stack.push(stack);
        s.extra.push(extra);
        s.target.push(target);
        s.old_addr.push(o_addr);
        s.old_size.push(o_size);
        s.death.push(NONE_U32);
        s.tag.push(0);

        let gp = *s.green_pre.last().unwrap_or(&0);
        let rp = *s.red_pre.last().unwrap_or(&0);
        if s.green_pre.is_empty() {
            s.green_pre.push(0);
            s.red_pre.push(0);
        }
        s.green_pre.push(gp + (op == OP_M || op == OP_R) as u32);
        s.red_pre.push(rp + (op == OP_F || op == OP_R) as u32);

        // ---- liveness bookkeeping ----
        if target != NONE_U32 && (op == OP_F || op == OP_R) {
            s.death[target as usize] = e;
            self.cur_live_bytes = self
                .cur_live_bytes
                .saturating_sub(s.size[target as usize]);
        }

        if op == OP_M || op == OP_R {
            let span = size.max(usable);
            let end = addr + span;

            // overlap anomaly: the new allocation wins; every overlapped
            // live allocation is implicitly ended here
            let mut victims: Vec<(u64, u32)> = Vec::new();
            if let Some((&pa, &(pe, pend))) = self.live.range(..addr).next_back() {
                if pend > addr {
                    victims.push((pa, pe));
                }
            }
            for (&na, &(ne, _)) in self.live.range(addr..) {
                if na >= end {
                    break;
                }
                victims.push((na, ne));
            }
            for (va, ve) in victims {
                s.warn(e, W_OVERLAP, va);
                s.death[ve as usize] = e;
                s.kills.push((e, ve));
                self.live.remove(&va);
                self.cur_live_bytes = self.cur_live_bytes.saturating_sub(s.size[ve as usize]);
            }

            self.live.insert(addr, (e, end));

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
            OP_R => s.n_realloc += 1,
            _ => {}
        }

        // ---- periodic snapshot ----
        let applied = e + 1;
        if applied % self.snap_interval == 0 {
            let mut lv: Vec<u32> = self.live.values().map(|&(ev, _)| ev).collect();
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
            addr: Vec::new(),
            size: Vec::new(),
            usable: Vec::new(),
            thr_idx: Vec::new(),
            site: Vec::new(),
            stack: Vec::new(),
            extra: Vec::new(),
            target: Vec::new(),
            old_addr: Vec::new(),
            old_size: Vec::new(),
            death: Vec::new(),
            tag: Vec::new(),
            kills: Vec::new(),
            green_pre: Vec::new(),
            red_pre: Vec::new(),
            sites: Vec::new(),
            site_count: Vec::new(),
            thrs: Vec::new(),
            thr_count: Vec::new(),
            stacks: Vec::new(),
            extras: Vec::new(),
            spans: Vec::new(),
            span_names: Vec::new(),
            logs: Vec::new(),
            srcs: Vec::new(),
            has_header: false,
            version: 2,
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
            n_span: 0,
            n_log: 0,
            warnings: Vec::new(),
            warn_counts: [0; NWARN],
            snaps: Vec::new(),
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
            b"usable" => raw.usable = Some(sc.integer()?.max(0) as u64),
            b"t" => raw.t = Some(sc.integer()?.max(0) as u64),
            b"thr" => raw.thr = Some(sc.integer()?),
            b"v" => raw.v = Some(sc.integer()?),
            b"row_bytes" => raw.row_bytes = Some(sc.integer()?.max(0) as u64),
            // v1 remnants: dropped from the format, skipped silently so old
            // files don't flood the extras table (the version warning is the
            // real signal)
            b"seq" | b"id" | b"old_id" | b"old_size" => {
                let _ = sc.skip_value()?;
            }
            b"site" => {
                let (a, b) = sc.string_span()?;
                raw.site = Some(unescape(&sc.b[a..b]));
            }
            b"name" => {
                let (a, b) = sc.string_span()?;
                raw.name = Some(unescape(&sc.b[a..b]));
            }
            b"msg" => {
                let (a, b) = sc.string_span()?;
                raw.msg = Some(unescape(&sc.b[a..b]));
            }
            b"lvl" => {
                let (a, b) = sc.string_span()?;
                raw.lvl = Some(unescape(&sc.b[a..b]));
            }
            b"src" => {
                let (a, b) = sc.string_span()?;
                raw.src = Some(unescape(&sc.b[a..b]));
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
