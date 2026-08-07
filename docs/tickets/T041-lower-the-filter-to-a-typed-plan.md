---
id: T041
title: Lower the filter to a typed plan over the columns
status: todo
updated: 2026-08-07
---

# T041: Lower the Filter to a Typed Plan Over the Columns

## Outcome

`hp_filter_apply` compiles the checked expression to a flat typed plan and
scans that; `filter_eval::eval` no longer runs per event. The language surface
does not change — this ticket is invisible except in the numbers.

## Done when

- [ ] A filter Apply executes a lowered plan. No AST node is visited per event,
      and no field name is compared as a string per event.
- [ ] Per event the scan allocates nothing: no `String` clone for `site` or
      `stack`, no `Vec` for `tags`, no `Value` boxing, no per-node `Result`.
      Asserted natively, not by inspection — the tag and site predicates are
      the ones that allocate today.
- [ ] The bench in [E019-bench](../explorations/E019-bench/filter_cost.rs) runs
      against the new path and every predicate in it is within 2× of the
      `floor()` control.
- [ ] E010's WASM gates are measured in a Chromium worker and reported in the
      commit body: 1M creators ≤ 25 ms median / 40 ms p95, 10M ≤ 250 ms / 400
      ms p95, site/thread/tag within 1.5× of numeric, warm custom fields within
      2×.
- [ ] Every existing filter test in `src/core/src/lib.rs` passes unchanged, and
      the match bitset is identical to the tree walk's for each of them.
- [ ] `cargo test` on both crates, `node --test 'src/web/**/*.test.ts'`, and
      `node_modules/.bin/tsc -p tsconfig.test.json` pass.

## Context

[D008](../decisions/D008-the-filter-evaluator-is-a-lowered-plan.md) is the
rule and carries the measurement; [E019](../explorations/E019-a-python-shaped-filter-language.md)
is the design it belongs to. This runs first because
[T042](T042-the-filter-language-is-python-shaped.md) adds a namespace node to
every field access, which on the tree walk is a regression and on a plan is
free.

Checking, completion, and diagnostics stay where they are. This ticket
replaces the execution path below `check()`, not the surface above it.

## Non-goals

- Any change to the language surface, the editor, or the worker protocol.
- Persisting a compiled plan.
- SIMD, threading, or an incremental rescan on tag change. The floor is 45×
  away; ordinary lowering reaches it.
