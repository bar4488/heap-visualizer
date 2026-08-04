---
id: T031
title: gen.py --fields covers every custom-field case the UI distinguishes
status: done
updated: 2026-08-05
---

# T031: gen.py --fields Covers Every Custom-Field Case the UI Distinguishes

## Outcome

`python3 gen.py --fields` emits a trace whose custom fields exercise each case
the allocation panel and the field catalog treat differently — every value
shape `customFieldsSection` styles (`src/web/heap/custom-fields.ts`), every
catalog outcome in [ANL-010](../../spec/07-analysis.md#anl-010-filtering-on-custom-trace-fields)
(typed, optional, multi-type, non-scalar), and records of all three ops.

## Done when

- [x] The generated trace carries a boolean, an integer, a float, a string, a
      null, an object and an array custom value.
- [x] It carries a key that is absent from some records (not merely null), and
      a key seen holding two different types.
- [x] It carries a string whose rendering tests escaping — markup characters,
      quotes, non-ASCII — and one long enough to test the panel's key/value
      column layout.
- [x] `R` records carry custom fields; today only `M` and `F` do.
- [x] Output stays deterministic for a given `--seed` and args.

## Non-goals

- Any change to the viewer, the core catalog, or the spec. This ticket makes
  the cases visible; whatever the viewer then does with a float or a
  multi-type key is a finding for its own ticket.
