//! The reusable point store: one row per record of a domain whose records
//! are instants — logs, landmarks, and any producer kind that is a point
//! ([D013]). It is LOG-003's store with the log-specific names taken off:
//!
//! - a **category** per row (a log's level, 0..N), with load-time prefix
//!   sums `ge` so "rows of category ≥ c in this seq range" is two lookups and
//!   a lane cell is two binary searches;
//! - an interned **label** per row (a log's logger, a landmark's title);
//! - a **text** arena with offsets (a log's message) — no per-row strings;
//! - interned custom-field **fragments** and the domain's own field catalog;
//! - [`Matches`]: a query (minimum category, ASCII case-insensitive text over
//!   label and text, a seq range) answered from the prefix sums when it has
//!   no text, and by one allocation-free scan when it has, plus "locate".
//!
//! [`PointView`] turns a store and its static [`PointSpec`] into a
//! [`Domain`]; the JSON key names a domain shows (`level`/`logger`/`msg` for
//! logs, `title` for marks) come from the spec.
//!
//! [D013]: ../../../../docs/decisions/D013-hybrid-record-types.md

use serde_json::{json, Value};

use super::*;

/// A point store with `N` categories (LOG-003, generalized).
pub struct PointStore<const N: usize> {
    /// Spine index of each row, strictly increasing.
    pub seq: Vec<u32>,
    /// Category of each row, `0..N`.
    pub cat: Vec<u8>,
    /// Index into `labels` (NONE_U32 = no label).
    pub label: Vec<u32>,
    /// Text `i` is `text[text_off[i]..text_off[i + 1]]`. At least `[0]` once
    /// a row exists.
    pub text_off: Vec<u32>,
    /// The text arena: every row's text, back to back, UTF-8.
    pub text: Vec<u8>,
    /// Index of the row's custom-field fragment (NONE_U32 = none): into
    /// `frags`, or into the trace's shared fragment table for a domain whose
    /// spec says so.
    pub fields: Vec<u32>,
    /// Interned custom-field fragments (`"k":v,"k2":v2`).
    pub frags: Vec<String>,
    /// The domain's own field catalog, built as fragments are interned.
    pub catalog: Vec<FieldInfo>,
    /// Parallel to `frags`: the catalog indexes each fragment carries.
    pub frag_fields: Vec<Vec<u32>>,
    pub labels: Vec<String>,
    pub label_count: Vec<u32>,
    /// `ge[i][c]` = rows in `[0, i)` with category ≥ `c`. Length rows + 1.
    pub ge: Vec<[u32; N]>,
}

impl<const N: usize> Default for PointStore<N> {
    fn default() -> Self {
        PointStore {
            seq: Vec::new(),
            cat: Vec::new(),
            label: Vec::new(),
            text_off: Vec::new(),
            text: Vec::new(),
            fields: Vec::new(),
            frags: Vec::new(),
            catalog: Vec::new(),
            frag_fields: Vec::new(),
            labels: Vec::new(),
            label_count: Vec::new(),
            ge: Vec::new(),
        }
    }
}

impl<const N: usize> PointStore<N> {
    pub fn len(&self) -> u32 {
        self.seq.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.seq.is_empty()
    }

    /// Append one row. `label` and `fields` are already interned.
    pub fn push(&mut self, seq: u32, cat: u8, label: u32, text: &str, fields: u32) {
        if self.ge.is_empty() {
            self.ge.push([0; N]);
            self.text_off.push(0);
        }
        self.seq.push(seq);
        self.cat.push(cat);
        self.label.push(label);
        if label != NONE_U32 {
            self.label_count[label as usize] += 1;
        }
        self.text.extend_from_slice(text.as_bytes());
        self.text_off.push(u32::try_from(self.text.len()).unwrap_or(u32::MAX));
        self.fields.push(fields);
        let mut next = *self.ge.last().unwrap();
        for slot in next.iter_mut().take(cat as usize + 1) {
            *slot += 1;
        }
        self.ge.push(next);
    }

    #[inline]
    pub fn text(&self, row: u32) -> &str {
        let (a, b) = (self.text_off[row as usize] as usize, self.text_off[row as usize + 1] as usize);
        // the arena only ever receives whole `&str`s
        core::str::from_utf8(&self.text[a..b]).unwrap_or("")
    }

    #[inline]
    pub fn label_name(&self, row: u32) -> Option<&str> {
        match self.label[row as usize] {
            NONE_U32 => None,
            id => Some(&self.labels[id as usize]),
        }
    }

    /// First row whose spine index is ≥ `seq`.
    #[inline]
    pub fn row_at_or_after(&self, seq: u32) -> u32 {
        self.seq.partition_point(|&s| s < seq) as u32
    }

    /// Row range covering the spine range `[a, b)`.
    #[inline]
    pub fn rows_in(&self, a: u32, b: u32) -> (u32, u32) {
        (self.row_at_or_after(a), self.row_at_or_after(b))
    }

    #[inline]
    pub fn ge_at(&self, row: u32) -> [u32; N] {
        self.ge.get(row as usize).copied().unwrap_or([0; N])
    }

    /// Exact per-category counts of rows in spine range `[a, b)`.
    pub fn counts(&self, a: u32, b: u32) -> [u32; N] {
        let (r0, r1) = self.rows_in(a, b);
        let (lo, hi) = (self.ge_at(r0), self.ge_at(r1));
        let mut out = [0; N];
        for c in 0..N {
            let ge_c = hi[c] - lo[c];
            let ge_next = if c + 1 < N { hi[c + 1] - lo[c + 1] } else { 0 };
            out[c] = ge_c - ge_next;
        }
        out
    }

    /// Highest category among rows in spine range `[a, b)`, from the prefix
    /// sums: two binary searches, no scan.
    pub fn max_cat(&self, a: u32, b: u32) -> Option<u8> {
        let (r0, r1) = self.rows_in(a, b);
        if r0 >= r1 {
            return None;
        }
        let (lo, hi) = (self.ge_at(r0), self.ge_at(r1));
        (0..N).rev().find(|&c| hi[c] > lo[c]).map(|c| c as u8)
    }

    /// Rows per category over the whole trace.
    pub fn by_cat(&self) -> [u32; N] {
        self.counts(0, u32::MAX)
    }
}

/// A point query (LOG-004). `seq_hi` is inclusive.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PointQuery {
    pub min_cat: u8,
    pub text: String,
    pub seq_lo: Option<u32>,
    pub seq_hi: Option<u32>,
}

impl PointQuery {
    /// The row range the seq bounds select.
    fn rows<const N: usize>(&self, p: &PointStore<N>) -> (u32, u32) {
        let r0 = self.seq_lo.map_or(0, |lo| p.row_at_or_after(lo));
        let r1 = match self.seq_hi {
            Some(hi) => p.row_at_or_after(hi.saturating_add(1)).max(r0),
            None => p.len(),
        };
        (r0, r1)
    }
}

/// The rows a query matches, in seq order.
pub enum Matches {
    /// No text: every row in `[r0, r1)` with category ≥ `min`, answered from
    /// the prefix sums without materializing anything.
    Level { r0: u32, r1: u32, min: u8 },
    /// A text query's matching rows, found by one scan.
    List(Vec<u32>),
}

impl Matches {
    pub fn new<const N: usize>(p: &PointStore<N>, q: &PointQuery) -> Matches {
        let (r0, r1) = q.rows(p);
        let min = q.min_cat.min(N as u8 - 1);
        if q.text.is_empty() {
            return Matches::Level { r0, r1, min };
        }
        let needle: Vec<u8> = q.text.bytes().map(|c| c.to_ascii_lowercase()).collect();
        // labels are decided once over the dictionary, not once per row
        let label_hit: Vec<bool> = p
            .labels
            .iter()
            .map(|name| contains_ci(name.as_bytes(), &needle))
            .collect();
        let mut out = Vec::new();
        for row in r0..r1 {
            let r = row as usize;
            if p.cat[r] < min {
                continue;
            }
            let label = p.label[r];
            let hit = (label != NONE_U32 && label_hit[label as usize]) || {
                let (a, b) = (p.text_off[r] as usize, p.text_off[r + 1] as usize);
                contains_ci(&p.text[a..b], &needle)
            };
            if hit {
                out.push(row);
            }
        }
        Matches::List(out)
    }

    pub fn total<const N: usize>(&self, p: &PointStore<N>) -> u32 {
        match self {
            Matches::Level { r0, r1, min } => p.ge_at(*r1)[*min as usize] - p.ge_at(*r0)[*min as usize],
            Matches::List(rows) => rows.len() as u32,
        }
    }

    /// Row of the `k`th match (0-based); `k < total`.
    pub fn row<const N: usize>(&self, p: &PointStore<N>, k: u32) -> u32 {
        match self {
            Matches::Level { r0, r1, min } => {
                if *min == 0 {
                    return r0 + k;
                }
                let m = *min as usize;
                let base = p.ge_at(*r0)[m];
                // smallest row r with (matches in [r0, r + 1)) > k
                let span = RowRange { lo: *r0, hi: *r1 };
                r0 + span.partition_point(|r| p.ge[r as usize + 1][m] - base <= k)
            }
            Matches::List(rows) => rows[k as usize],
        }
    }

    /// Index within the match list of the last match whose seq ≤ `seq`, or
    /// -1 when none is (LOG-004 "locate").
    pub fn locate<const N: usize>(&self, p: &PointStore<N>, seq: u32) -> i64 {
        let end = p.row_at_or_after(seq.saturating_add(1));
        match self {
            Matches::Level { r0, r1, min } => {
                let end = end.clamp(*r0, *r1);
                let m = *min as usize;
                (p.ge_at(end)[m] - p.ge_at(*r0)[m]) as i64 - 1
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

// ------------------------------------------------------------ the domain

/// Everything that makes one point store a particular domain: names, the
/// JSON keys its rows show, its lane, its limits.
pub struct PointSpec {
    pub id: DomainId,
    pub title: &'static str,
    pub kind: &'static str,
    /// Category names (`trace`..`fatal` for logs); one entry for a domain
    /// without categories.
    pub categories: &'static [&'static str],
    /// Key the category shows under (`level`), when there is more than one.
    pub category_key: Option<&'static str>,
    /// Key the label shows under (`logger`, `title`).
    pub label_key: &'static str,
    /// Key the text shows under (`msg`), for a domain that has text.
    pub text_key: Option<&'static str>,
    /// Lanes on the timelines, bottom first.
    pub lanes: &'static [Lane],
    /// Fragments index the trace-wide table (`Store::extras`) rather than
    /// the store's own `frags`.
    pub shared_frags: bool,
    /// Rows per browser page.
    pub page_max: u32,
    /// Longest agent `text` operand, in bytes.
    pub text_max: usize,
}

/// A point store as a [`Domain`].
pub struct PointView<'a, const N: usize> {
    pub s: &'a Store,
    pub p: &'a PointStore<N>,
    pub spec: &'static PointSpec,
}

impl<'a, const N: usize> PointView<'a, N> {
    pub fn fragment(&self, row: u32) -> Option<&'a str> {
        match self.p.fields[row as usize] {
            NONE_U32 => None,
            f if self.spec.shared_frags => Some(self.s.extras[f as usize].as_str()),
            f => Some(self.p.frags[f as usize].as_str()),
        }
    }

    /// The minimum category a request names: a number or a category name.
    fn min_cat(&self, v: &Value) -> u8 {
        match v {
            Value::Number(n) => n.as_u64().map_or(0, |n| n.min(N as u64 - 1) as u8),
            Value::String(name) => self.cat_from_name(name).unwrap_or(0),
            _ => 0,
        }
    }

    fn cat_from_name(&self, name: &str) -> Option<u8> {
        if self.spec.id == LOGS {
            return crate::logs::level_from_name(name);
        }
        self.spec.categories.iter().position(|c| c.eq_ignore_ascii_case(name)).map(|c| c as u8)
    }

    fn query(&self, req: &Request) -> PointQuery {
        PointQuery {
            min_cat: self.min_cat(&req.min_level),
            text: req.text.clone().unwrap_or_default(),
            seq_lo: req.seq_lo(),
            seq_hi: req.seq_hi(),
        }
    }

    /// The cached matches of `q`, scanning only when the query changed.
    fn matches<'c>(&self, cache: &'c mut QueryCache, q: PointQuery) -> &'c Matches {
        let id = self.spec.id;
        if !matches!(&cache.0, Some((d, k, _)) if *d == id && *k == q) {
            let m = Matches::new(self.p, &q);
            cache.0 = Some((id, q, m));
        }
        &cache.0.as_ref().unwrap().2
    }

    /// One query row in the domain's own keys (LOG-009 for logs):
    /// `{row, seq, t, thr, [level], <label>, [<text>], fields}`.
    fn push_query_row(&self, o: &mut String, k: u32, row: u32) {
        let (s, p, spec) = (self.s, self.p, self.spec);
        let seq = p.seq[row as usize];
        o.push_str(&format!("{{\"row\":{},\"seq\":{},\"t\":{},\"thr\":", k, seq, s.t[seq as usize] as f64));
        push_thr(o, s, seq);
        if let Some(key) = spec.category_key {
            o.push_str(&format!(",\"{key}\":{}", p.cat[row as usize]));
        }
        o.push_str(&format!(",\"{}\":", spec.label_key));
        match p.label_name(row) {
            Some(name) => push_json_str(o, name),
            None => o.push_str("null"),
        }
        if let Some(key) = spec.text_key {
            o.push_str(&format!(",\"{key}\":"));
            push_json_str(o, p.text(row));
        }
        o.push_str(",\"fields\":");
        push_fields(o, self.fragment(row));
        o.push('}');
    }
}

impl<const N: usize> Domain for PointView<'_, N> {
    fn id(&self) -> DomainId {
        self.spec.id
    }

    fn descriptor(&self) -> Value {
        let spec = self.spec;
        let mut params = Vec::new();
        if spec.category_key.is_some() {
            params.push(json!({ "name": "minLevel", "type": "category" }));
        }
        params.push(json!({ "name": "text", "type": "text" }));
        params.push(json!({ "name": "seqLo", "type": "seq" }));
        params.push(json!({ "name": "seqHi", "type": "seq" }));
        let fields = if spec.shared_frags {
            // the domain's share of the trace-wide catalog: the keys its own
            // fragments carry, read once per distinct fragment
            let mut used: Vec<u32> = self.p.fields.iter().copied().filter(|&f| f != NONE_U32).collect();
            used.sort_unstable();
            used.dedup();
            let mut keys: Vec<u32> = used.iter().flat_map(|&f| self.s.extra_fields[f as usize].iter().copied()).collect();
            keys.sort_unstable();
            keys.dedup();
            catalog_value(keys.iter().map(|&k| &self.s.fields[k as usize]))
        } else {
            catalog_value(self.p.catalog.iter())
        };
        json!({
            "id": self.name(),
            "name": spec.title,
            "kinds": kinds_value(spec.id),
            "shape": "point",
            "count": self.count(),
            "categories": spec.categories,
            "keys": { "category": spec.category_key, "label": spec.label_key, "text": spec.text_key },
            "lanes": lanes_value(self.name(), spec.lanes),
            "fields": fields,
            "query": { "params": params },
            "limits": { "page": spec.page_max, "agentPage": RECORDS_COUNT_MAX, "agentDefault": RECORDS_COUNT_DEFAULT, "textBytes": spec.text_max },
        })
    }

    fn count(&self) -> u32 {
        self.p.len()
    }

    fn seq_of(&self, row: u32) -> u32 {
        self.p.seq[row as usize]
    }

    fn row_of(&self, seq: u32) -> Option<u32> {
        let row = self.p.row_at_or_after(seq);
        (self.p.seq.get(row as usize) == Some(&seq)).then_some(row)
    }

    fn summary(&self, row: u32) -> Summary<'_> {
        let (p, spec) = (self.p, self.spec);
        let cat = p.cat[row as usize];
        // a domain with text titles its records by it and keeps the label as
        // their source; one without is titled by its label
        let (title, source) = match spec.text_key {
            Some(_) => (Some(p.text(row).to_string()), p.label_name(row)),
            None => (p.label_name(row).map(str::to_string), None),
        };
        Summary {
            seq: p.seq[row as usize],
            domain: spec.id,
            kind: spec.kind,
            title,
            level: spec.category_key.map(|_| (cat, spec.categories[cat as usize])),
            source,
            fields: self.fragment(row),
        }
    }

    fn record_json(&self, row: u32, out: &mut String) {
        self.summary(row).push_json(self.s, out);
    }

    fn query_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String) {
        let m = self.matches(cache, self.query(req));
        let max = self.spec.page_max;
        write_page(out, m.total(self.p), req.from(), req.count(max), max, |k, o| {
            self.push_query_row(o, k, m.row(self.p, k))
        });
    }

    fn locate_json(&self, req: &Request, cache: &mut QueryCache, out: &mut String) {
        let m = self.matches(cache, self.query(req));
        *out = format!("{{\"row\":{},\"total\":{}}}", m.locate(self.p, req.seq()), m.total(self.p));
    }

    fn lanes(&self) -> &'static [Lane] {
        if self.p.is_empty() {
            &[]
        } else {
            self.spec.lanes
        }
    }

    fn lane_cell(&self, lane: usize, a: u32, b: u32) -> Option<[u8; 3]> {
        let colors = self.spec.lanes.get(lane)?.colors;
        self.p.max_cat(a, b).map(|c| colors[c as usize])
    }

    fn lane_hover(&self, a: u32, b: u32, out: &mut String) {
        if self.p.is_empty() {
            return;
        }
        let counts = self.p.counts(a, b);
        out.push_str(&format!(
            ",\"{}\":{{\"count\":{},\"byLevel\":",
            self.name(),
            counts.iter().sum::<u32>()
        ));
        push_counts(out, &counts);
        out.push('}');
    }

    /// The last record at or before the playhead — for landmarks, the phase
    /// the program is in.
    fn state_at(&self, seq: u32) -> Option<Value> {
        let row = self.p.row_at_or_after(seq).checked_sub(1)?;
        Some(json!({ "last": self.agent_item(row) }))
    }

    /// The domain's own agent item (LOG-008 for logs): the query row's keys,
    /// with `t` an exact string and the category by name.
    fn agent_item(&self, row: u32) -> Value {
        let (s, p, spec) = (self.s, self.p, self.spec);
        let seq = p.seq[row as usize];
        let mut v = json!({
            "seq": seq,
            "t": s.t[seq as usize].to_string(),
            "thr": thr_value(s, seq),
            "fields": fields_value(self.fragment(row)),
        });
        if let Some(key) = spec.category_key {
            v[key] = json!(spec.categories[p.cat[row as usize] as usize]);
        }
        v[spec.label_key] = json!(p.label_name(row));
        if let Some(key) = spec.text_key {
            v[key] = json!(p.text(row));
        }
        v
    }

    fn agent_records(&self, params: &RecordParams) -> Result<Value, Error> {
        let spec = self.spec;
        let min_cat = if spec.category_key.is_some() {
            params.only(&["minLevel", "text"])?;
            match params.params.get("minLevel").map(String::as_str) {
                None | Some("") => 0,
                Some(name) => match name.parse::<u8>() {
                    Ok(n) if (n as usize) < N => n,
                    Ok(_) => return Err(param_error(&format!("minLevel must be 0 through {} or a level name", N - 1))),
                    Err(_) => self.cat_from_name(name).ok_or_else(|| {
                        param_error(&format!("minLevel must be {}", or_list(spec.categories)))
                    })?,
                },
            }
        } else {
            params.only(&["text"])?;
            0
        };
        let count = params.page_count()?;
        let text = params.params.get("text").cloned().unwrap_or_default();
        if text.len() > spec.text_max {
            return Err(param_error(&format!("text is limited to {} bytes", spec.text_max)));
        }
        let q = PointQuery { min_cat, text, seq_lo: params.seq_lo, seq_hi: params.seq_hi };
        let m = Matches::new(self.p, &q);
        Ok(agent_page(m.total(self.p) as usize, params.from, count, |k| {
            self.agent_item(m.row(self.p, k as u32))
        }))
    }
}

/// `a, b, or c`.
fn or_list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => one.to_string(),
        [init @ .., last] => format!("{}, or {}", init.join(", "), last),
    }
}

/// `[n0,n1,…]`.
pub fn push_counts(o: &mut String, counts: &[u32]) {
    o.push('[');
    for (i, n) in counts.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&n.to_string());
    }
    o.push(']');
}
