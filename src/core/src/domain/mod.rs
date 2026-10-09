//! The domain registry ([DOM-003]): what makes heap, marks and logs — and the
//! next evidence domain — plug into the engine instead of being threaded
//! through it.
//!
//! Three layers, from hottest to coldest:
//!
//! - **The op table** ([`OPS`]): every record type's letter, its domain and
//!   its kind. "Is this a heap record?" is a table lookup ([`op_domain`]),
//!   never a comparison against op numbering.
//! - **[`Domains`]**: the concrete payload stores, one field per domain, so
//!   hot paths (replay, filter scans, timeline bars) reach a domain's columns
//!   by static dispatch and pay nothing for the registry.
//! - **[`Domain`]**: an object-safe trait over a borrowed store — the cold
//!   surface every domain offers in the same shape: its descriptor, a generic
//!   record summary, paged queries and locate, timeline lanes and their hover,
//!   optional state at a seq, and agent pages. The generic browser exports
//!   (`hp_domains_json`, `hp_domain_query`, …) and the agent's
//!   `domain_records` are written once against it.
//!
//! [DOM-003]: ../../../../spec/13-domains-and-logs.md#dom-003-what-a-domain-provides

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::agent::Error;
use crate::json::push_json_str;
use crate::store::*;

/// A domain's index in the registry.
pub type DomainId = u8;
pub const HEAP: DomainId = 0;
pub const MARKS: DomainId = 1;
pub const LOGS: DomainId = 2;
pub const INTERVALS: DomainId = 3;
/// The domain of an op the table does not know.
pub const NO_DOMAIN: DomainId = u8::MAX;
pub const NDOMAIN: usize = 4;
/// Registry names, indexed by [`DomainId`]. These are the `domain` values of
/// every generic request and document.
pub const DOMAIN_NAMES: [&str; NDOMAIN] = ["heap", "marks", "logs", "intervals"];

/// One record type: its wire letter, its domain, and its kind name.
#[derive(Clone, Copy, Debug)]
pub struct OpInfo {
    pub op: u8,
    pub letter: u8,
    pub domain: DomainId,
    pub kind: &'static str,
}

/// Every record type the core reads, indexed by op ([D013]). Adding a record
/// type is one row here plus its reader.
///
/// [D013]: ../../../../docs/decisions/D013-hybrid-record-types.md
pub const OPS: [OpInfo; 8] = [
    OpInfo { op: OP_M, letter: b'M', domain: HEAP, kind: "malloc" },
    OpInfo { op: OP_F, letter: b'F', domain: HEAP, kind: "free" },
    OpInfo { op: OP_R, letter: b'R', domain: HEAP, kind: "realloc" },
    OpInfo { op: OP_E, letter: b'E', domain: MARKS, kind: "event" },
    OpInfo { op: OP_L, letter: b'L', domain: LOGS, kind: "log" },
    // v2 only: a v1 trace skips these letters as unknown (IVL-001)
    OpInfo { op: OP_B, letter: b'B', domain: INTERVALS, kind: "begin" },
    OpInfo { op: OP_X, letter: b'X', domain: INTERVALS, kind: "end" },
    OpInfo { op: OP_C, letter: b'C', domain: INTERVALS, kind: "switch" },
];

const OP_DOMAIN: [DomainId; OPS.len()] = {
    let mut table = [NO_DOMAIN; OPS.len()];
    let mut i = 0;
    while i < OPS.len() {
        table[OPS[i].op as usize] = OPS[i].domain;
        i += 1;
    }
    table
};

/// The domain an op belongs to — the one place that decides it.
#[inline]
pub fn op_domain(op: u8) -> DomainId {
    match OP_DOMAIN.get(op as usize) {
        Some(&d) => d,
        None => NO_DOMAIN,
    }
}

/// The kind name of an op (`"malloc"`, `"log"`, …).
pub fn op_kind(op: u8) -> &'static str {
    OPS.get(op as usize).map_or("unknown", |o| o.kind)
}

/// The op of a wire letter, if the core reads that record type.
pub fn op_for_letter(letter: u8) -> Option<u8> {
    OPS.iter().find(|o| o.letter == letter).map(|o| o.op)
}

/// A domain's id from its registry name.
pub fn by_name(name: &str) -> Option<DomainId> {
    DOMAIN_NAMES.iter().position(|&n| n == name).map(|i| i as DomainId)
}

/// Every domain's payload store, as concrete fields (DOM-002).
#[derive(Default)]
pub struct Domains {
    pub heap: HeapCols,
    pub marks: marks::MarkStore,
    pub logs: crate::logs::LogStore,
    pub intervals: interval::IntervalStore,
}

/// The domain `id` over store `s`, as the cold trait surface. `None` for an
/// id outside the registry.
pub fn get(s: &Store, id: DomainId) -> Option<Box<dyn Domain + '_>> {
    Some(match id {
        HEAP => Box::new(heap::HeapView(s)),
        MARKS => Box::new(marks::view(s)),
        LOGS => Box::new(crate::logs::view(s)),
        INTERVALS => Box::new(interval::view(s)),
        _ => return None,
    })
}

/// Every registered domain, in id order.
pub fn all(s: &Store) -> impl Iterator<Item = Box<dyn Domain + '_>> {
    (0..NDOMAIN as DomainId).filter_map(move |id| get(s, id))
}

// ------------------------------------------------------------------ trait

/// A timeline lane a domain draws ([DOM-003] "timeline lane data"). Lanes
/// stack upward from the bottom tag lane in registry order; each is derived
/// from load-time prefix sums, so a cell is a pair of binary searches.
#[derive(Clone, Copy, Debug)]
pub struct Lane {
    pub id: &'static str,
    pub title: &'static str,
    /// Category names the lane colors by, most severe last.
    pub categories: &'static [&'static str],
    pub colors: &'static [[u8; 3]],
    /// Pixel height for a strip of height `h`.
    pub height: fn(u32) -> i64,
}

/// The generic record summary every domain can give:
/// `{seq, t, thr, domain, kind, title, level?, source?, fields}`.
pub struct Summary<'a> {
    pub seq: u32,
    pub domain: DomainId,
    pub kind: &'static str,
    pub title: Option<String>,
    /// Category (log level) for a domain that orders its records by one.
    pub level: Option<(u8, &'static str)>,
    /// Interned origin of the record: a log's logger, an allocation's site.
    pub source: Option<&'a str>,
    /// Custom-field object body (`"k":v,…`), verbatim.
    pub fields: Option<&'a str>,
}

impl Summary<'_> {
    /// Browser shape: `t` a number, `level` 0–5.
    pub fn push_json(&self, s: &Store, o: &mut String) {
        o.push_str(&format!(
            "{{\"seq\":{},\"t\":{},\"thr\":",
            self.seq, s.t[self.seq as usize] as f64
        ));
        push_thr(o, s, self.seq);
        push_pid(o, s, self.seq);
        o.push_str(",\"domain\":");
        push_json_str(o, DOMAIN_NAMES[self.domain as usize]);
        o.push_str(",\"kind\":");
        push_json_str(o, self.kind);
        o.push_str(",\"title\":");
        match &self.title {
            Some(t) => push_json_str(o, t),
            None => o.push_str("null"),
        }
        if let Some((level, _)) = self.level {
            o.push_str(&format!(",\"level\":{level}"));
        }
        if let Some(source) = self.source {
            o.push_str(",\"source\":");
            push_json_str(o, source);
        }
        o.push_str(",\"fields\":");
        push_fields(o, self.fields);
        o.push('}');
    }

    /// Agent shape (API-001): `t` an exact string, `level` by name.
    pub fn agent_value(&self, s: &Store) -> Value {
        let mut v = json!({
            "seq": self.seq,
            "t": s.t[self.seq as usize].to_string(),
            "thr": thr_value(s, self.seq),
            "domain": DOMAIN_NAMES[self.domain as usize],
            "kind": self.kind,
            "title": self.title,
            "fields": fields_value(self.fields),
        });
        if let Some((_, name)) = self.level {
            v["level"] = json!(name);
        }
        if let Some(pid) = s.track_pid_of(s.thr_idx[self.seq as usize]) {
            v["pid"] = json!(pid);
        }
        if let Some(source) = self.source {
            v["source"] = json!(source);
        }
        v
    }
}

/// A browser query or locate request: the domain's own parameters and the
/// shared paging ones. Numbers are read leniently (they come from
/// JavaScript) and clamped to the unsigned 32-bit range.
#[derive(serde::Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    pub domain: Option<String>,
    pub min_level: Value,
    pub text: Option<String>,
    pub seq_lo: Option<f64>,
    pub seq_hi: Option<f64>,
    pub from: Option<f64>,
    pub count: Option<f64>,
    pub seq: Option<f64>,
    /// Interval queries: `sched`, `call` or `span`.
    pub category: Option<String>,
    /// Interval queries: a track by `thr` (and `pid`), or a CPU.
    pub thr: Value,
    pub pid: Value,
    pub cpu: Value,
    /// Interval queries: minimum duration, in trace time units.
    pub min_dur: Value,
}

pub fn clamp_u32(v: f64) -> u32 {
    if v.is_nan() {
        0
    } else {
        v.clamp(0.0, u32::MAX as f64) as u32
    }
}

impl Request {
    pub fn seq_lo(&self) -> Option<u32> {
        self.seq_lo.map(clamp_u32)
    }
    pub fn seq_hi(&self) -> Option<u32> {
        self.seq_hi.map(clamp_u32)
    }
    pub fn from(&self) -> u32 {
        clamp_u32(self.from.unwrap_or(0.0))
    }
    pub fn count(&self, max: u32) -> u32 {
        clamp_u32(self.count.unwrap_or(max as f64))
    }
    pub fn seq(&self) -> u32 {
        clamp_u32(self.seq.unwrap_or(0.0))
    }
}

/// The engine's one cached query: a text query's matches, kept so that
/// paging and locate against the same query do not rescan (LOG-004).
#[derive(Default)]
pub struct QueryCache(
    pub Option<(DomainId, point::PointQuery, point::Matches)>,
    /// The interval domain's last query and its matching intervals.
    pub Option<(interval::IntervalQuery, Vec<u32>)>,
);

/// Parameters of an agent records page (`/api/v1/domains/{d}/records`):
/// the shared paging bounds plus the domain's own named parameters, as the
/// transport parsed them from the query string.
#[derive(Clone, Debug, Default)]
pub struct RecordParams {
    pub seq_lo: Option<u32>,
    pub seq_hi: Option<u32>,
    pub from: usize,
    pub count: Option<usize>,
    pub params: BTreeMap<String, String>,
}

/// Default and maximum agent page size, for every domain (API-001).
pub const RECORDS_COUNT_DEFAULT: usize = 50;
pub const RECORDS_COUNT_MAX: usize = 200;

pub fn param_error(message: &str) -> Error {
    Error { message: message.into(), start: 0, end: 0 }
}

impl RecordParams {
    /// Reject any domain parameter not in `known`.
    pub fn only(&self, known: &[&str]) -> Result<(), Error> {
        match self.params.keys().find(|k| !known.contains(&k.as_str())) {
            Some(k) => Err(param_error(&format!("unknown parameter {k}"))),
            None => Ok(()),
        }
    }

    pub fn page_count(&self) -> Result<usize, Error> {
        let count = self.count.unwrap_or(RECORDS_COUNT_DEFAULT);
        if count == 0 || count > RECORDS_COUNT_MAX {
            return Err(param_error("count must be from 1 through 200"));
        }
        Ok(count)
    }
}

/// One bounded agent page over `total` matches: `{total, from, items,
/// next}`, item `k` built by `item`.
pub fn agent_page(total: usize, from: usize, count: usize, item: impl Fn(usize) -> Value) -> Value {
    let from = from.min(total);
    let hi = from.saturating_add(count).min(total);
    json!({
        "total": total,
        "from": from,
        "items": (from..hi).map(item).collect::<Vec<_>>(),
        "next": (hi < total).then_some(hi),
    })
}

/// The cold, object-safe surface of one evidence domain.
pub trait Domain {
    fn id(&self) -> DomainId;

    fn name(&self) -> &'static str {
        DOMAIN_NAMES[self.id() as usize]
    }

    /// `{id, name, ops, kinds, shape, count, lanes, fields, query, limits}`.
    fn descriptor(&self) -> Value;

    /// Names of the domain's own browser query parameters — the
    /// descriptor's `query.params`. A browser query or locate naming any
    /// other key (besides `domain`, `from`, `count` and `seq`) is refused.
    fn query_params(&self) -> &'static [&'static str];

    /// Rows in the domain's store.
    fn count(&self) -> u32;

    /// Spine index of row `row`.
    fn seq_of(&self, row: u32) -> u32;

    /// Row of spine record `seq`, when that record belongs to this domain.
    fn row_of(&self, seq: u32) -> Option<u32>;

    /// The generic summary of row `row`.
    fn summary(&self, row: u32) -> Summary<'_>;

    /// `hp_record_json`'s document for row `row`.
    fn record_json(&self, row: u32, out: &mut String);

    /// One page of the domain's own query: `{total, from, rows:[…]}`.
    fn query_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String);

    /// `{row, total}`: the index within the match list of the last match at
    /// or before `req.seq`, or -1.
    fn locate_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String);

    /// Lanes the domain draws on the timelines, bottom first.
    fn lanes(&self) -> &'static [Lane] {
        &[]
    }

    /// Color of lane `lane` over spine range `[a, b)`, or `None` for empty.
    fn lane_cell(&self, _lane: usize, _a: u32, _b: u32) -> Option<[u8; 3]> {
        None
    }

    /// Append the domain's strip-hover entry for spine range `[a, b)`
    /// (`,"<name>":{…}`), or nothing.
    fn lane_hover(&self, _a: u32, _b: u32, _out: &mut String) {}

    /// The domain's state as of `seq` records applied, for a domain whose
    /// records accumulate into one.
    fn state_at(&self, _seq: u32) -> Option<Value> {
        None
    }

    /// The agent item for row `row`.
    fn agent_item(&self, row: u32) -> Value;

    /// One agent records page (`agent::domain_records`).
    fn agent_records(&self, params: &RecordParams) -> Result<Value, Error>;
}

// ------------------------------------------------------------- helpers

pub fn push_thr(o: &mut String, s: &Store, seq: u32) {
    match s.track_thr(s.thr_idx[seq as usize]) {
        None => o.push_str("null"),
        Some(t) => o.push_str(&t.to_string()),
    }
}

pub fn thr_value(s: &Store, seq: u32) -> Value {
    json!(s.track_thr(s.thr_idx[seq as usize]))
}

/// `,"pid":N` for a record on a v2 track; nothing otherwise, so v1
/// documents keep their shape.
pub fn push_pid(o: &mut String, s: &Store, seq: u32) {
    if let Some(pid) = s.track_pid_of(s.thr_idx[seq as usize]) {
        o.push_str(&format!(",\"pid\":{pid}"));
    }
}

/// A custom-field fragment as an object, or `null`.
pub fn push_fields(o: &mut String, fields: Option<&str>) {
    match fields {
        Some(f) => {
            o.push('{');
            o.push_str(f);
            o.push('}');
        }
        None => o.push_str("null"),
    }
}

pub fn fields_value(fields: Option<&str>) -> Value {
    fields
        .and_then(|f| serde_json::from_str(&format!("{{{f}}}")).ok())
        .unwrap_or(Value::Null)
}

/// A field catalog as descriptor JSON, in the shape of `hp_fields_json`.
pub fn catalog_value<'a>(fields: impl Iterator<Item = &'a FieldInfo>) -> Value {
    Value::Array(
        fields
            .map(|f| {
                json!({
                    "name": f.name,
                    "type": match f.scalar() {
                        Some(FIELD_BOOL) => Some("bool"),
                        Some(FIELD_INT) => Some("int"),
                        Some(FIELD_FLOAT) => Some("float"),
                        Some(FIELD_STRING) => Some("string"),
                        _ => None,
                    },
                    "optional": f.optional(),
                    "events": f.events,
                })
            })
            .collect(),
    )
}

/// Lanes as descriptor JSON.
pub fn lanes_value(domain: &str, lanes: &[Lane]) -> Value {
    Value::Array(
        lanes
            .iter()
            .map(|l| {
                json!({
                    "id": l.id,
                    "domain": domain,
                    "title": l.title,
                    "categories": l.categories,
                    "colors": l.colors.iter().map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// The kinds of a domain, from the op table.
pub fn kinds_value(id: DomainId) -> Value {
    Value::Array(
        OPS.iter()
            .filter(|o| o.domain == id)
            .map(|o| json!({ "op": (o.letter as char).to_string(), "kind": o.kind }))
            .collect(),
    )
}

/// Write one browser page: `{total, from, rows:[…]}`, row `k` by `row`.
pub fn write_page(out: &mut String, total: u32, from: u32, count: u32, max: u32, mut row: impl FnMut(u32, &mut String)) {
    let from = from.min(total);
    let hi = from.saturating_add(count.min(max)).min(total);
    out.clear();
    out.push_str(&format!("{{\"total\":{total},\"from\":{from},\"rows\":["));
    for k in from..hi {
        if k > from {
            out.push(',');
        }
        row(k, out);
    }
    out.push_str("]}");
}

pub mod heap;
pub mod interval;
pub mod interval_window;
pub mod marks;
pub mod point;

#[cfg(test)]
mod interval_tests;
#[cfg(test)]
mod interval_window_tests;
#[cfg(test)]
mod tests;
