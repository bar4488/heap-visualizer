//! The log evidence domain ([spec/13]): `L` record parsing, the columnar log
//! store, log queries, and the per-level prefix sums behind the timeline lane.
//!
//! A log record occupies a spine index like every other record, and nothing
//! else of it touches the heap: the heap store gains no row for it
//! ([DOM-002]), and the log store holds rows only for log records.
//!
//! Messages live in one byte arena with offsets ([LOG-003]); loggers and
//! custom-field fragments are interned. A query decides loggers once over the
//! dictionary and then scans message bytes in place, so a scan allocates
//! nothing per row ([LOG-004]).
//!
//! [spec/13]: ../../../spec/13-domains-and-logs.md
//! [DOM-002]: ../../../spec/13-domains-and-logs.md#dom-002-domains-own-their-payloads
//! [LOG-003]: ../../../spec/13-domains-and-logs.md#log-003-the-log-store
//! [LOG-004]: ../../../spec/13-domains-and-logs.md#log-004-log-queries

use crate::json::{push_json_str, unescape, Scan};
use crate::store::{Store, NONE_U16, NONE_U32};

/// Number of severity levels (LOG-002), `trace` = 0 through `fatal` = 5.
pub const NLEVEL: usize = 6;
pub const LEVEL_INFO: u8 = 2;
pub const LEVEL_NAMES: [&str; NLEVEL] = ["trace", "debug", "info", "warn", "error", "fatal"];
/// A message longer than this is truncated at a character boundary and the
/// record is flagged `long-log` (LOG-001).
pub const MSG_MAX: usize = 16 * 1024;
/// Rows per page of a browser query (LOG-004).
pub const PAGE_MAX: u32 = 500;
/// Loggers listed by `hp_logs_meta_json` (LOG-009).
pub const META_LOGGERS_MAX: usize = 200;

/// Level from its name: case-insensitive, with `warning` and `err` accepted
/// as aliases (LOG-001). `None` for anything else.
pub fn level_from_name(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    Some(match lower.as_str() {
        "trace" => 0,
        "debug" => 1,
        "info" => 2,
        "warn" | "warning" => 3,
        "error" | "err" => 4,
        "fatal" => 5,
        _ => return None,
    })
}

/// How a record's `level` key read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LevelRead {
    Absent,
    Known(u8),
    /// Present but not a known level name (or not a string): read as `info`,
    /// flagged `bad-level`.
    Bad,
}

/// One `L` line, decoded but not yet stored.
#[derive(Debug, Default)]
pub struct RawLog {
    pub t: Option<u64>,
    pub seq: Option<i64>,
    pub thr: Option<i64>,
    pub level: Option<LevelRead>,
    pub logger: Option<String>,
    pub msg: Option<String>,
    /// Raw JSON object body fragment of every other top-level key, verbatim.
    pub extra: String,
}

impl RawLog {
    pub fn level(&self) -> LevelRead {
        self.level.unwrap_or(LevelRead::Absent)
    }
}

/// Decode one line as an `L` record. `None` when the line is not a JSON
/// object, its `op` is not `"L"`, or a spine field (`t`, `seq`, `thr`) is
/// unreadable. A missing or non-string `msg` is left as `None` for the caller
/// to drop with a `malformed` warning.
///
/// Everything but `op`, `t`, `seq`, `thr`, `level`, `logger` and `msg` is a
/// custom field of the log — including names the heap reads (`site`, `id`,
/// …), which mean nothing on a log record.
pub fn parse_log_line(line: &[u8]) -> Option<RawLog> {
    let mut sc = Scan::new(line);
    if !sc.eat(b'{') {
        return None;
    }
    let mut raw = RawLog::default();
    let mut is_log = false;
    sc.ws();
    if sc.peek() == b'}' {
        return None;
    }
    loop {
        let (ks, ke) = sc.string_span()?;
        if !sc.eat(b':') {
            return None;
        }
        sc.ws();
        let head = sc.peek();
        match &sc.b[ks..ke] {
            b"op" => {
                let (a, b) = sc.string_span()?;
                is_log = &sc.b[a..b] == b"L";
            }
            b"t" => raw.t = Some(sc.unsigned_integer()?),
            b"seq" => raw.seq = Some(sc.integer()?),
            b"thr" => raw.thr = Some(sc.integer()?),
            b"level" => {
                raw.level = Some(if head == b'"' {
                    let (a, b) = sc.string_span()?;
                    match level_from_name(&unescape(&sc.b[a..b])) {
                        Some(level) => LevelRead::Known(level),
                        None => LevelRead::Bad,
                    }
                } else {
                    sc.skip_value()?;
                    LevelRead::Bad
                });
            }
            b"logger" if head == b'"' => {
                let (a, b) = sc.string_span()?;
                raw.logger = Some(unescape(&sc.b[a..b]));
            }
            b"msg" => {
                if head == b'"' {
                    let (a, b) = sc.string_span()?;
                    raw.msg = Some(unescape(&sc.b[a..b]));
                } else {
                    sc.skip_value()?;
                }
            }
            _ => {
                let key = unescape(&sc.b[ks..ke]);
                let (a, b) = sc.skip_value()?;
                if !raw.extra.is_empty() {
                    raw.extra.push(',');
                }
                push_json_str(&mut raw.extra, &key);
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
    is_log.then_some(raw)
}

/// Truncate `msg` to at most `MSG_MAX` bytes at a character boundary.
/// Returns whether it was cut.
pub fn truncate_msg(msg: &mut String) -> bool {
    if msg.len() <= MSG_MAX {
        return false;
    }
    let mut cut = MSG_MAX;
    while !msg.is_char_boundary(cut) {
        cut -= 1;
    }
    msg.truncate(cut);
    true
}

/// The log store (LOG-003): one row per `L` record, ordered by spine index.
#[derive(Default)]
pub struct LogStore {
    /// Spine index of each log row, strictly increasing.
    pub seq: Vec<u32>,
    pub level: Vec<u8>,
    /// Index into `loggers` (NONE_U32 = no logger).
    pub logger: Vec<u32>,
    /// Message `i` is `msg[msg_off[i]..msg_off[i + 1]]`. Always at least `[0]`
    /// once a row exists.
    pub msg_off: Vec<u32>,
    /// The message arena: every message, back to back, UTF-8.
    pub msg: Vec<u8>,
    /// Index into `frags` of the row's custom fields (NONE_U32 = none).
    pub fields: Vec<u32>,
    /// Interned custom-field fragments (`"k":v,"k2":v2`).
    pub frags: Vec<String>,
    pub loggers: Vec<String>,
    pub logger_count: Vec<u32>,
    /// `ge[i][l]` = log rows in `[0, i)` with level ≥ `l`. Length rows + 1.
    /// Makes "how many logs of level ≥ L in this range" two lookups.
    pub ge: Vec<[u32; NLEVEL]>,
}

impl LogStore {
    pub fn len(&self) -> u32 {
        self.seq.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.seq.is_empty()
    }

    /// Append one row. `logger` and `fields` are already interned.
    pub fn push(&mut self, seq: u32, level: u8, logger: u32, msg: &str, fields: u32) {
        if self.ge.is_empty() {
            self.ge.push([0; NLEVEL]);
            self.msg_off.push(0);
        }
        self.seq.push(seq);
        self.level.push(level);
        self.logger.push(logger);
        if logger != NONE_U32 {
            self.logger_count[logger as usize] += 1;
        }
        self.msg.extend_from_slice(msg.as_bytes());
        self.msg_off.push(u32::try_from(self.msg.len()).unwrap_or(u32::MAX));
        self.fields.push(fields);
        let mut next = *self.ge.last().unwrap();
        for slot in next.iter_mut().take(level as usize + 1) {
            *slot += 1;
        }
        self.ge.push(next);
    }

    #[inline]
    pub fn msg(&self, row: u32) -> &str {
        let (a, b) = (self.msg_off[row as usize] as usize, self.msg_off[row as usize + 1] as usize);
        // the arena only ever receives whole `&str`s
        core::str::from_utf8(&self.msg[a..b]).unwrap_or("")
    }

    #[inline]
    pub fn logger_name(&self, row: u32) -> Option<&str> {
        match self.logger[row as usize] {
            NONE_U32 => None,
            id => Some(&self.loggers[id as usize]),
        }
    }

    /// First log row whose spine index is ≥ `seq`.
    #[inline]
    pub fn row_at_or_after(&self, seq: u32) -> u32 {
        self.seq.partition_point(|&s| s < seq) as u32
    }

    /// Log row range covering the spine range `[a, b)`.
    #[inline]
    pub fn rows_in(&self, a: u32, b: u32) -> (u32, u32) {
        (self.row_at_or_after(a), self.row_at_or_after(b))
    }

    #[inline]
    fn ge_at(&self, row: u32) -> [u32; NLEVEL] {
        self.ge.get(row as usize).copied().unwrap_or([0; NLEVEL])
    }

    /// Exact per-level counts of log records in spine range `[a, b)`.
    pub fn counts(&self, a: u32, b: u32) -> [u32; NLEVEL] {
        let (r0, r1) = self.rows_in(a, b);
        let (lo, hi) = (self.ge_at(r0), self.ge_at(r1));
        let mut out = [0; NLEVEL];
        for l in 0..NLEVEL {
            let ge_l = hi[l] - lo[l];
            let ge_next = if l + 1 < NLEVEL { hi[l + 1] - lo[l + 1] } else { 0 };
            out[l] = ge_l - ge_next;
        }
        out
    }

    /// Most severe level among log records in spine range `[a, b)`, from
    /// the prefix sums: two binary searches, no scan.
    pub fn max_level(&self, a: u32, b: u32) -> Option<u8> {
        let (r0, r1) = self.rows_in(a, b);
        if r0 >= r1 {
            return None;
        }
        let (lo, hi) = (self.ge_at(r0), self.ge_at(r1));
        (0..NLEVEL).rev().find(|&l| hi[l] > lo[l]).map(|l| l as u8)
    }

    /// Records per level over the whole trace.
    pub fn by_level(&self) -> [u32; NLEVEL] {
        self.counts(0, u32::MAX)
    }
}

/// A log query (LOG-004). `seq_hi` is inclusive.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LogQuery {
    pub min_level: u8,
    pub text: String,
    pub seq_lo: Option<u32>,
    pub seq_hi: Option<u32>,
}

impl LogQuery {
    /// The log-row range the seq bounds select.
    fn rows(&self, logs: &LogStore) -> (u32, u32) {
        let r0 = self.seq_lo.map_or(0, |lo| logs.row_at_or_after(lo));
        let r1 = match self.seq_hi {
            Some(hi) => logs.row_at_or_after(hi.saturating_add(1)).max(r0),
            None => logs.len(),
        };
        (r0, r1)
    }
}

/// The rows a query matches, in seq order.
pub enum Matches {
    /// No text: the matches are every row in `[r0, r1)` with level ≥ `min`,
    /// answered from the prefix sums without materializing anything.
    Level { r0: u32, r1: u32, min: u8 },
    /// A text query's matching rows, found by one scan.
    List(Vec<u32>),
}

impl Matches {
    pub fn new(logs: &LogStore, q: &LogQuery) -> Matches {
        let (r0, r1) = q.rows(logs);
        let min = q.min_level.min(NLEVEL as u8 - 1);
        if q.text.is_empty() {
            return Matches::Level { r0, r1, min };
        }
        let needle: Vec<u8> = q.text.bytes().map(|c| c.to_ascii_lowercase()).collect();
        // loggers are decided once over the dictionary, not once per row
        let logger_hit: Vec<bool> = logs
            .loggers
            .iter()
            .map(|name| contains_ci(name.as_bytes(), &needle))
            .collect();
        let mut out = Vec::new();
        for row in r0..r1 {
            let r = row as usize;
            if logs.level[r] < min {
                continue;
            }
            let logger = logs.logger[r];
            let hit = (logger != NONE_U32 && logger_hit[logger as usize]) || {
                let (a, b) = (logs.msg_off[r] as usize, logs.msg_off[r + 1] as usize);
                contains_ci(&logs.msg[a..b], &needle)
            };
            if hit {
                out.push(row);
            }
        }
        Matches::List(out)
    }

    pub fn total(&self, logs: &LogStore) -> u32 {
        match self {
            Matches::Level { r0, r1, min } => {
                logs.ge_at(*r1)[*min as usize] - logs.ge_at(*r0)[*min as usize]
            }
            Matches::List(rows) => rows.len() as u32,
        }
    }

    /// Log row of the `k`th match (0-based); `k < total`.
    pub fn row(&self, logs: &LogStore, k: u32) -> u32 {
        match self {
            Matches::Level { r0, r1, min } => {
                if *min == 0 {
                    return r0 + k;
                }
                let m = *min as usize;
                let base = logs.ge_at(*r0)[m];
                // smallest row r with (matches in [r0, r + 1)) > k
                let span = RowRange { lo: *r0, hi: *r1 };
                r0 + span.partition_point(|r| logs.ge[r as usize + 1][m] - base <= k)
            }
            Matches::List(rows) => rows[k as usize],
        }
    }

    /// Index within the match list of the last match whose seq ≤ `seq`, or
    /// -1 when none is (LOG-004 "locate").
    pub fn locate(&self, logs: &LogStore, seq: u32) -> i64 {
        let end = logs.row_at_or_after(seq.saturating_add(1));
        match self {
            Matches::Level { r0, r1, min } => {
                let end = end.clamp(*r0, *r1);
                let m = *min as usize;
                (logs.ge_at(end)[m] - logs.ge_at(*r0)[m]) as i64 - 1
            }
            Matches::List(rows) => rows.partition_point(|&r| r < end) as i64 - 1,
        }
    }
}

/// A half-open row range with a binary search, so `Matches::row` can search
/// the prefix sums without collecting anything.
struct RowRange {
    lo: u32,
    hi: u32,
}

impl RowRange {
    fn partition_point(&self, pred: impl Fn(u32) -> bool) -> u32 {
        let (mut lo, mut hi) = (self.lo, self.hi);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if pred(mid) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo - self.lo
    }
}

/// ASCII case-insensitive substring test; `needle` is already lowercased.
/// Non-ASCII bytes compare exactly. Allocates nothing.
#[inline]
pub fn contains_ci(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    let first = needle[0];
    let last = hay.len() - needle.len();
    let mut i = 0;
    while i <= last {
        if hay[i].to_ascii_lowercase() == first
            && hay[i + 1..i + needle.len()]
                .iter()
                .zip(&needle[1..])
                .all(|(a, b)| a.to_ascii_lowercase() == *b)
        {
            return true;
        }
        i += 1;
    }
    false
}

/// Read a level operand: a number 0–5, or a level name. `None` when absent.
pub fn level_operand(v: &serde_json::Value) -> Option<u8> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().map(|n| n.min(NLEVEL as u64 - 1) as u8),
        serde_json::Value::String(s) => level_from_name(s),
        _ => None,
    }
}

// ------------------------------------------------------------------- JSON

fn push_thr(o: &mut String, s: &Store, seq: u32) {
    match s.thr_idx[seq as usize] {
        NONE_U16 => o.push_str("null"),
        t => o.push_str(&s.thrs[t as usize].to_string()),
    }
}

fn push_fields(o: &mut String, logs: &LogStore, row: u32) -> bool {
    match logs.fields[row as usize] {
        NONE_U32 => false,
        f => {
            o.push('{');
            o.push_str(&logs.frags[f as usize]);
            o.push('}');
            true
        }
    }
}

/// The Events-list row for log record `seq` (LOG-006): the shape of an `E`
/// row, with level, logger and message in place of a title.
pub fn push_event_json(o: &mut String, s: &Store, seq: u32) {
    let logs = &s.dom.logs;
    let row = logs.row_at_or_after(seq);
    o.push_str(&format!(
        "{{\"seq\":{},\"op\":{},\"t\":{},\"e\":null,\"level\":{},\"logger\":",
        seq,
        crate::store::OP_L,
        s.t[seq as usize] as f64,
        logs.level[row as usize]
    ));
    match logs.logger_name(row) {
        Some(name) => push_json_str(o, name),
        None => o.push_str("null"),
    }
    o.push_str(",\"msg\":");
    push_json_str(o, logs.msg(row));
    o.push_str(",\"thr\":");
    push_thr(o, s, seq);
    if logs.fields[row as usize] != NONE_U32 {
        o.push_str(",\"extra\":");
        push_fields(o, logs, row);
    }
    o.push('}');
}

/// `hp_logs_meta_json` (LOG-009).
pub fn meta_json(o: &mut String, logs: &LogStore) {
    o.clear();
    o.push_str(&format!("{{\"count\":{},\"byLevel\":", logs.len()));
    push_levels(o, &logs.by_level());
    o.push_str(",\"loggers\":[");
    let mut order: Vec<usize> = (0..logs.loggers.len()).collect();
    order.sort_by(|&a, &b| {
        logs.logger_count[b]
            .cmp(&logs.logger_count[a])
            .then_with(|| logs.loggers[a].cmp(&logs.loggers[b]))
    });
    for (i, &l) in order.iter().take(META_LOGGERS_MAX).enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"name\":");
        push_json_str(o, &logs.loggers[l]);
        o.push_str(&format!(",\"count\":{}}}", logs.logger_count[l]));
    }
    o.push_str("]}");
}

pub fn push_levels(o: &mut String, levels: &[u32; NLEVEL]) {
    o.push('[');
    for (i, n) in levels.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&n.to_string());
    }
    o.push(']');
}

/// One page of `hp_logs_query` (LOG-009): `{total, from, rows:[...]}`.
pub fn query_json(o: &mut String, s: &Store, m: &Matches, from: u32, count: u32) {
    let logs = &s.dom.logs;
    let total = m.total(logs);
    let from = from.min(total);
    let hi = from.saturating_add(count.min(PAGE_MAX)).min(total);
    o.clear();
    o.push_str(&format!("{{\"total\":{},\"from\":{},\"rows\":[", total, from));
    for k in from..hi {
        if k > from {
            o.push(',');
        }
        let row = m.row(logs, k);
        let seq = logs.seq[row as usize];
        o.push_str(&format!(
            "{{\"row\":{},\"seq\":{},\"t\":{},\"thr\":",
            k, seq, s.t[seq as usize] as f64
        ));
        push_thr(o, s, seq);
        o.push_str(&format!(",\"level\":{},\"logger\":", logs.level[row as usize]));
        match logs.logger_name(row) {
            Some(name) => push_json_str(o, name),
            None => o.push_str("null"),
        }
        o.push_str(",\"msg\":");
        push_json_str(o, logs.msg(row));
        o.push_str(",\"fields\":");
        if !push_fields(o, logs, row) {
            o.push_str("null");
        }
        o.push('}');
    }
    o.push_str("]}");
}

/// The agent page item (LOG-008): exact time as a string, level by name.
pub fn agent_item(s: &Store, row: u32) -> serde_json::Value {
    let logs = &s.dom.logs;
    let seq = logs.seq[row as usize];
    let fields = match logs.fields[row as usize] {
        NONE_U32 => serde_json::Value::Null,
        f => serde_json::from_str(&format!("{{{}}}", logs.frags[f as usize]))
            .unwrap_or(serde_json::Value::Null),
    };
    serde_json::json!({
        "seq": seq,
        "t": s.t[seq as usize].to_string(),
        "thr": match s.thr_idx[seq as usize] { NONE_U16 => None, t => Some(s.thrs[t as usize]) },
        "level": LEVEL_NAMES[logs.level[row as usize] as usize],
        "logger": logs.logger_name(row),
        "msg": logs.msg(row),
        "fields": fields,
    })
}

// ------------------------------------------------------------- the domain

/// Longest accepted agent `text` operand, in bytes (LOG-008).
pub const TEXT_MAX: usize = 1024;

/// The log domain's cold surface ([`crate::domain::Domain`]).
pub struct LogsView<'a>(pub &'a Store);

impl LogsView<'_> {
    fn query(req: &crate::domain::Request) -> LogQuery {
        LogQuery {
            min_level: level_operand(&req.min_level).unwrap_or(0),
            text: req.text.clone().unwrap_or_default(),
            seq_lo: req.seq_lo(),
            seq_hi: req.seq_hi(),
        }
    }

    /// The cached matches of `q`, scanning only when the query changed.
    fn matches<'c>(&self, cache: &'c mut crate::domain::QueryCache, q: LogQuery) -> &'c Matches {
        if !matches!(&cache.logs, Some((k, _)) if *k == q) {
            let m = Matches::new(&self.0.dom.logs, &q);
            cache.logs = Some((q, m));
        }
        &cache.logs.as_ref().unwrap().1
    }
}

impl crate::domain::Domain for LogsView<'_> {
    fn id(&self) -> crate::domain::DomainId {
        crate::domain::LOGS
    }

    fn descriptor(&self) -> serde_json::Value {
        use crate::domain::*;
        serde_json::json!({
            "id": self.name(),
            "name": "Logs",
            "kinds": kinds_value(LOGS),
            "shape": "point",
            "count": self.count(),
            "categories": LEVEL_NAMES,
            "lanes": [],
            "fields": [],
            "query": {
                "params": [
                    { "name": "minLevel", "type": "level" },
                    { "name": "text", "type": "text" },
                    { "name": "seqLo", "type": "seq" },
                    { "name": "seqHi", "type": "seq" },
                ],
            },
            "limits": { "page": PAGE_MAX, "agentPage": RECORDS_COUNT_MAX, "agentDefault": RECORDS_COUNT_DEFAULT, "textBytes": TEXT_MAX },
        })
    }

    fn count(&self) -> u32 {
        self.0.dom.logs.len()
    }

    fn seq_of(&self, row: u32) -> u32 {
        self.0.dom.logs.seq[row as usize]
    }

    fn row_of(&self, seq: u32) -> Option<u32> {
        let logs = &self.0.dom.logs;
        let row = logs.row_at_or_after(seq);
        (logs.seq.get(row as usize) == Some(&seq)).then_some(row)
    }

    fn summary(&self, row: u32) -> crate::domain::Summary<'_> {
        let logs = &self.0.dom.logs;
        let level = logs.level[row as usize];
        crate::domain::Summary {
            seq: logs.seq[row as usize],
            domain: crate::domain::LOGS,
            kind: "log",
            title: Some(logs.msg(row).to_string()),
            level: Some((level, LEVEL_NAMES[level as usize])),
            source: logs.logger_name(row),
            fields: match logs.fields[row as usize] {
                NONE_U32 => None,
                f => Some(logs.frags[f as usize].as_str()),
            },
        }
    }

    fn record_json(&self, row: u32, out: &mut String) {
        self.summary(row).push_json(self.0, out);
    }

    fn query_json(&self, req: &crate::domain::Request, cache: &mut crate::domain::QueryCache, out: &mut String) {
        let m = self.matches(cache, Self::query(req));
        query_json(out, self.0, m, req.from(), req.count(PAGE_MAX));
    }

    fn locate_json(&self, req: &crate::domain::Request, cache: &mut crate::domain::QueryCache, out: &mut String) {
        let m = self.matches(cache, Self::query(req));
        let logs = &self.0.dom.logs;
        *out = format!("{{\"row\":{},\"total\":{}}}", m.locate(logs, req.seq()), m.total(logs));
    }

    fn agent_item(&self, row: u32) -> serde_json::Value {
        agent_item(self.0, row)
    }

    fn agent_records(&self, p: &crate::domain::RecordParams) -> Result<serde_json::Value, crate::agent::Error> {
        use crate::domain::param_error;
        p.only(&["minLevel", "text"])?;
        let min_level = match p.params.get("minLevel").map(String::as_str) {
            None | Some("") => 0,
            Some(name) => match name.parse::<u8>() {
                Ok(n) if (n as usize) < NLEVEL => n,
                Ok(_) => return Err(param_error("minLevel must be 0 through 5 or a level name")),
                Err(_) => level_from_name(name)
                    .ok_or_else(|| param_error("minLevel must be trace, debug, info, warn, error, or fatal"))?,
            },
        };
        let count = p.page_count()?;
        let text = p.params.get("text").cloned().unwrap_or_default();
        if text.len() > TEXT_MAX {
            return Err(param_error("text is limited to 1024 bytes"));
        }
        let query = LogQuery { min_level, text, seq_lo: p.seq_lo, seq_hi: p.seq_hi };
        let logs = &self.0.dom.logs;
        let m = Matches::new(logs, &query);
        Ok(crate::domain::agent_page(m.total(logs) as usize, p.from, count, |k| {
            self.agent_item(m.row(logs, k as u32))
        }))
    }
}
