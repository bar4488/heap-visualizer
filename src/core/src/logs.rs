//! The log evidence domain ([spec/13]): `L` record parsing, and the log
//! domain as a point store (`domain::point`) — the columnar log
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
pub use crate::domain::point::{contains_ci, Matches, PointQuery, PointStore};
use crate::domain::point::{PointSpec, PointView};
use crate::domain::{push_thr, Domain};
use crate::store::Store;

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

/// The log store (LOG-003): a point store over the six levels. Its
/// category is the level, its label the logger, its text the message.
pub type LogStore = PointStore<NLEVEL>;
/// A log query (LOG-004); its `min_cat` is the minimum level.
pub type LogQuery = PointQuery;

impl PointStore<NLEVEL> {
    #[inline]
    pub fn msg(&self, row: u32) -> &str {
        self.text(row)
    }

    #[inline]
    pub fn logger_name(&self, row: u32) -> Option<&str> {
        self.label_name(row)
    }

    /// Most severe level among log records in spine range `[a, b)`.
    pub fn max_level(&self, a: u32, b: u32) -> Option<u8> {
        self.max_cat(a, b)
    }

    /// Records per level over the whole trace.
    pub fn by_level(&self) -> [u32; NLEVEL] {
        self.by_cat()
    }
}

/// The log domain ([`crate::domain::point::PointSpec`]): LOG-009's keys.
pub static SPEC: PointSpec = PointSpec {
    id: crate::domain::LOGS,
    title: "Logs",
    kind: "log",
    categories: &LEVEL_NAMES,
    category_key: Some("level"),
    label_key: "logger",
    text_key: Some("msg"),
    lanes: &[],
    shared_frags: false,
    page_max: PAGE_MAX,
    text_max: TEXT_MAX,
};

/// Longest accepted agent `text` operand, in bytes (LOG-008).
pub const TEXT_MAX: usize = 1024;

/// Read a level operand: a number 0–5, or a level name. `None` when absent.
pub fn level_operand(v: &serde_json::Value) -> Option<u8> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().map(|n| n.min(NLEVEL as u64 - 1) as u8),
        serde_json::Value::String(s) => level_from_name(s),
        _ => None,
    }
}

// ------------------------------------------------------------------- JSON

/// The log domain over store `s`.
pub fn view(s: &Store) -> PointView<'_, NLEVEL> {
    PointView { s, p: &s.dom.logs, spec: &SPEC }
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
        logs.cat[row as usize]
    ));
    match logs.logger_name(row) {
        Some(name) => push_json_str(o, name),
        None => o.push_str("null"),
    }
    o.push_str(",\"msg\":");
    push_json_str(o, logs.msg(row));
    o.push_str(",\"thr\":");
    push_thr(o, s, seq);
    if let Some(fields) = view(s).fragment(row) {
        o.push_str(",\"extra\":");
        crate::domain::push_fields(o, Some(fields));
    }
    o.push('}');
}

/// `hp_logs_meta_json` (LOG-009).
pub fn meta_json(o: &mut String, logs: &LogStore) {
    o.clear();
    o.push_str(&format!("{{\"count\":{},\"byLevel\":", logs.len()));
    push_levels(o, &logs.by_level());
    o.push_str(",\"loggers\":[");
    let mut order: Vec<usize> = (0..logs.labels.len()).collect();
    order.sort_by(|&a, &b| {
        logs.label_count[b]
            .cmp(&logs.label_count[a])
            .then_with(|| logs.labels[a].cmp(&logs.labels[b]))
    });
    for (i, &l) in order.iter().take(META_LOGGERS_MAX).enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"name\":");
        push_json_str(o, &logs.labels[l]);
        o.push_str(&format!(",\"count\":{}}}", logs.label_count[l]));
    }
    o.push_str("]}");
}

pub fn push_levels(o: &mut String, levels: &[u32; NLEVEL]) {
    crate::domain::point::push_counts(o, levels);
}

/// The agent page item (LOG-008): exact time as a string, level by name.
pub fn agent_item(s: &Store, row: u32) -> serde_json::Value {
    view(s).agent_item(row)
}
