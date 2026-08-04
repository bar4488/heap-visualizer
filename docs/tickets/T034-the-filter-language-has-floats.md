---
id: T034
title: The filter language has floats
status: done
updated: 2026-08-05
---

# T034: The Filter Language Has Floats

## Context

Reported 2026-08-05: filtering on a fractional custom field does not work.
Three separate causes, each silent:

- `resolve_fragment` (`src/core/src/filter_eval.rs`) parses a number with
  `parse::<i128>()`, so `0.986` fails and the value becomes `Missing`. Every
  comparison against it is then false, with no diagnostic.
- The catalog (`catalog_fragment` in `src/core/src/parse.rs`) types any
  non-string/bool/null/object value as `FIELD_INT`, so the field advertises
  itself as an integer.
- `customFieldPredicate` (`src/web/filter-actions.ts:74`) declines a
  non-integer number, so the allocation panel offers no ⊙ action for it.

The language has no float literal at all: `ExprKind` has `Integer` and no
`Float`, and E010 says "All numeric values are integral."

## Outcome

`field["fill-ratio"] > 0.5` works, and so does every other numeric surface:
ordering, equality, `in` a range, `in` a set, `abs`, arithmetic, the missing
tests, completion, the panel's one-click predicate, and the catalog listing.
Integer and float operands mix freely and compare **exactly** — no operand is
converted through a lossy `as f64`.

## Done when

- [x] `0.5`, `1.25`, `1e-3`, `2.5e6` and `1.5MiB` lex and parse as float
      literals; `0.2..0.8` still parses as a range, and `0..10` is unchanged.
- [x] A key the trace carries as a float types as float, and a key seen
      holding both integers and floats types as float rather than failing as
      multi-type.
- [x] An integer operand and a float operand compare exactly, including where
      the integer exceeds 2^53 — asserted by a test that would fail under
      `as f64` conversion.
- [x] `field["fill-ratio"] > 0.5` selects the right allocations in
      `src/web/guide/traces/format.heapl`, and `is missing` still works on it.
- [x] The catalog listing shows the field as `float`, completion offers it and
      its observed values, and the allocation panel offers its ⊙ predicate.
- [x] The spec states the numeric rules, including what `==` on a float means.
- [x] `cargo test` (both crates), `node --test 'src/web/**/*.test.ts'` and
      `node_modules/.bin/tsc` pass; `./build.sh` emits.

## Non-goals

- Floats anywhere in the trace format's own fields. `size`, `address`, `time`
  and the rest stay integers.
- Hexadecimal float literals, and `NaN` / `inf` literals.
