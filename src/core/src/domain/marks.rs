//! The marks domain: the producer's own `E` landmarks (TRACE-010), as a
//! point store. A mark is a title (interned) plus custom fields, and touches
//! no allocation — so it holds no heap row, and heap rows are `M`/`F`/`R`
//! only.
//!
//! A mark's custom fields stay in the trace-wide fragment table and field
//! catalog (`Store::extras`/`Store::fields`) that predate domains, so the
//! allocation filter's catalog, completion and diagnostics read exactly as
//! they did when marks were heap rows.

use super::point::{PointSpec, PointStore, PointView};
use super::*;

pub type MarkStore = PointStore<1>;

pub static SPEC: PointSpec = PointSpec {
    id: MARKS,
    title: "Marks",
    kind: "event",
    categories: &["mark"],
    category_key: None,
    label_key: "title",
    text_key: None,
    lanes: &[],
    shared_frags: true,
    page_max: heap::PAGE_MAX,
    text_max: crate::logs::TEXT_MAX,
};

/// The marks domain over store `s`.
pub fn view(s: &Store) -> PointView<'_, 1> {
    PointView { s, p: &s.dom.marks, spec: &SPEC }
}

/// Row of mark record `e`, when `e` is one.
#[inline]
pub fn row(s: &Store, e: u32) -> Option<u32> {
    if s.op.get(e as usize) != Some(&OP_E) {
        return None;
    }
    Some(s.dom.marks.row_at_or_after(e))
}

/// The title of mark record `e`, if it is a mark and has one.
pub fn title(s: &Store, e: u32) -> Option<&str> {
    row(s, e).and_then(|r| s.dom.marks.label_name(r))
}

/// The custom-field fragment of mark record `e`, if any.
pub fn fields(s: &Store, e: u32) -> Option<&str> {
    row(s, e).and_then(|r| view(s).fragment(r))
}
