---
id: T035
title: The allocation panel shows the custom fields of the record that freed it
status: done
updated: 2026-08-05
---

# T035: The Allocation Panel Shows the Custom Fields of the Record That Freed It

## Outcome

An allocation's custom-field section covers both records that describe it: the
creator's fields and the fields of the `F`/`R` that killed it, as one list. A
key carried by both appears once, holding the death record's value, and its
one-click predicate is `death.field.<key>`, matching what the row shows.

The trace format already allows custom fields on every record type and the
filter language already reads them with `death.field.<key>`
([ANL-010](../../spec/07-analysis.md#anl-010-filtering-on-custom-trace-fields));
only the panel was creator-only.

## Done when

- [x] `render::alloc_info` emits the death record's fragment as `deathExtra`,
      and nothing when the allocation is never freed or the record carries none.
- [x] `customFieldsSection` merges the two, death last, and is asserted on
      override, on death-only keys, and on an allocation with neither.
- [x] A row sourced from the death record writes a `death.field.…` predicate;
      one sourced from the creator still writes `field.…`.
- [x] `python3 gen.py --fields` emits a key on `F` records that the creator
      record also carries, so the override case is reachable by hand.
- [x] [ANL-006](../../spec/07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows)
      states the merge and which side wins.

## Non-goals

- Changing what `field.<key>` and `death.field.<key>` mean to the evaluator.
  The language already distinguishes them; this is the panel catching up.

## Result

The core emits the freeing record's fragment alongside the creator's; the panel
merges them and marks the rows that came from the free. `cargo test`,
`node --test`, `tsc` and a full `./build.sh` pass.

What no cheap check covers: how the merged section *looks* — the badge, and the
key column sizing to a wider key ([D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)).
`src/web/guide/traces/format.heapl` was regenerated so the case is one click
away: open it, select any freed allocation, and the `refcount` row reads 0 with
an "on free" badge.
