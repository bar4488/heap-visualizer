---
id: T035
title: The allocation panel shows the custom fields of the record that freed it
status: doing
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

- [ ] `render::alloc_info` emits the death record's fragment as `deathExtra`,
      and nothing when the allocation is never freed or the record carries none.
- [ ] `customFieldsSection` merges the two, death last, and is asserted on
      override, on death-only keys, and on an allocation with neither.
- [ ] A row sourced from the death record writes a `death.field.…` predicate;
      one sourced from the creator still writes `field.…`.
- [ ] `python3 gen.py --fields` emits a key on `F` records that the creator
      record also carries, so the override case is reachable by hand.
- [ ] [ANL-006](../../spec/07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows)
      states the merge and which side wins.

## Non-goals

- Changing what `field.<key>` and `death.field.<key>` mean to the evaluator.
  The language already distinguishes them; this is the panel catching up.
