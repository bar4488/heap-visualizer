//! The heap domain's cold surface. Its hot paths — replay, the filter plan,
//! the density bars, the address map — read `Domains::heap` directly; this
//! view is what the generic exports and the agent see.

use serde_json::{json, Value};

use super::*;

pub struct HeapView<'a>(pub &'a Store);

impl HeapView<'_> {
    /// Heap rows whose records lie in the inclusive spine range.
    fn rows(&self, seq_lo: Option<u32>, seq_hi: Option<u32>) -> std::ops::Range<usize> {
        let s = self.0;
        s.heap_rows(seq_lo.unwrap_or(0), seq_hi.map_or(u32::MAX, |hi| hi.saturating_add(1)))
    }

    fn title(&self, e: u32) -> String {
        let s = self.0;
        match s.op[e as usize] {
            OP_F => match s.target(e) {
                NONE_U32 => format!("free id {}", s.id(e)),
                t => format!("free {} B at 0x{:x}", s.size(t), s.addr(t)),
            },
            op => format!("{} {} B at 0x{:x}", op_kind(op), s.size(e), s.addr(e)),
        }
    }
}

impl Domain for HeapView<'_> {
    fn id(&self) -> DomainId {
        HEAP
    }

    fn descriptor(&self) -> Value {
        let s = self.0;
        json!({
            "id": self.name(),
            "name": "Heap",
            "kinds": kinds_value(HEAP),
            "shape": "allocation",
            "count": self.count(),
            "lanes": [],
            "fields": catalog_value(s.fields.iter()),
            "query": {
                "language": "filter",
                "params": [
                    { "name": "seqLo", "type": "seq" },
                    { "name": "seqHi", "type": "seq" },
                ],
            },
            "limits": { "page": PAGE_MAX, "agentPage": RECORDS_COUNT_MAX, "agentDefault": RECORDS_COUNT_DEFAULT },
        })
    }

    fn count(&self) -> u32 {
        self.0.heap_len()
    }

    fn seq_of(&self, row: u32) -> u32 {
        self.0.heap_seq(row as usize)
    }

    fn row_of(&self, seq: u32) -> Option<u32> {
        self.0.heap_row(seq).map(|h| h as u32)
    }

    fn summary(&self, row: u32) -> Summary<'_> {
        let s = self.0;
        let e = s.heap_seq(row as usize);
        let op = s.op[e as usize];
        // an F carries no site of its own: report the allocation it frees
        let site = match (s.site(e), op) {
            (NONE_U32, OP_F) if s.target(e) != NONE_U32 => s.site(s.target(e)),
            (site, _) => site,
        };
        Summary {
            seq: e,
            domain: HEAP,
            kind: op_kind(op),
            title: Some(self.title(e)),
            level: None,
            source: (site != NONE_U32).then(|| s.sites[site as usize].as_str()),
            fields: match s.extra_at(e) {
                NONE_U32 => None,
                f => Some(s.extras[f as usize].as_str()),
            },
        }
    }

    fn record_json(&self, row: u32, out: &mut String) {
        self.summary(row).push_json(self.0, out);
    }

    fn query_json(&self, req: &Request, _cache: &mut QueryCache, out: &mut String) {
        let rows = self.rows(req.seq_lo(), req.seq_hi());
        let total = rows.len() as u32;
        write_page(out, total, req.from(), req.count(PAGE_MAX), PAGE_MAX, |k, o| {
            push_row(o, k, |o| self.record_json(rows.start as u32 + k, o));
        });
    }

    fn locate_json(&self, req: &Request, _cache: &mut QueryCache, out: &mut String) {
        let rows = self.rows(req.seq_lo(), req.seq_hi());
        let upto = self.0.heap_rank(req.seq().saturating_add(1).min(self.0.len())) as usize;
        let row = upto.clamp(rows.start, rows.end) as i64 - rows.start as i64 - 1;
        *out = format!("{{\"row\":{},\"total\":{}}}", row, rows.len());
    }

    fn agent_item(&self, row: u32) -> Value {
        self.summary(row).agent_value(self.0)
    }

    fn agent_records(&self, p: &RecordParams) -> Result<Value, Error> {
        p.only(&[])?;
        let count = p.page_count()?;
        let rows = self.rows(p.seq_lo, p.seq_hi);
        Ok(agent_page(rows.len(), p.from, count, |k| self.agent_item((rows.start + k) as u32)))
    }
}

/// Rows per page of a generic browser query.
pub const PAGE_MAX: u32 = 500;

/// A page row: the record's JSON object with its match index `row` first.
pub fn push_row(o: &mut String, k: u32, record: impl FnOnce(&mut String)) {
    let mut one = String::with_capacity(128);
    record(&mut one);
    // `record` wrote `{…}`; open it with the row index
    o.push_str(&format!("{{\"row\":{k},"));
    o.push_str(&one[1..]);
}
