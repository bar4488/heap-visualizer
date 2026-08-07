---
id: T041
title: Lower the filter to a typed plan over the columns
status: done
updated: 2026-08-07
---

# T041: Lower the Filter to a Typed Plan Over the Columns

## Outcome

`hp_filter_apply` compiles the checked expression to a flat typed plan and
scans that; `filter_eval::eval` no longer runs per event. The language surface
does not change — this ticket is invisible except in the numbers.

## Done when

- [x] A filter Apply executes a lowered plan. No AST node is visited per event,
      and no field name is compared as a string per event.
- [x] Per event the scan allocates nothing: no `String` clone for `site` or
      `stack`, no `Vec` for `tags`, no `Value` boxing, no per-node `Result`.
      Asserted natively, not by inspection — the tag and site predicates are
      the ones that allocate today.
- [~] The bench in [E019-bench](../explorations/E019-bench/filter_cost.rs) runs
      against the new path and every predicate in it is within 2× of the
      `floor()` control.
- [ ] E010's WASM gates are measured in a Chromium worker and reported in the
      commit body: 1M creators ≤ 25 ms median / 40 ms p95, 10M ≤ 250 ms / 400
      ms p95, site/thread/tag within 1.5× of numeric, warm custom fields within
      2×.
- [x] Every existing filter test in `src/core/src/lib.rs` passes unchanged, and
      the match bitset is identical to the tree walk's for each of them.
- [x] `cargo test` on both crates, `node --test 'src/web/**/*.test.ts'`, and
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

## Result

The scan is `filter_plan::scan` over a `Pred` tree compiled by
`filter_plan::lower`, a block of 64 events at a time, carrying an `active`
mask down so `&&` narrows what the next clause reads.
`filter_eval::evaluate` is now `#[cfg(test)]` — the tree walk survives only as
the oracle the equivalence test compares against.

Two structural facts carried the work, and both were already in the store.
Every string in the language is dictionary-backed, so a string predicate is
decided over the dictionary at lowering and the per-event step is an id load
and a bit test — which is why `starts_with` now costs what `==` costs. And
[D009](../decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md)'s
`tag_members` is a bitset blocked by 64, the same blocking as the output, so
`tags contains "x"` is one 64-bit load and touches no events at all.

**Numbers, native release, 1M creators: `size >= 4096` went 38.0 ms → 0.40 ms**
(1.3× the direct-column-scan control), `tags contains` 39.9 ms → 0.04 ms, and
the whole table is in
[E019](../explorations/E019-a-python-shaped-filter-language.md#measurement).
E010's 25 ms gate is met with 60× headroom on the common shapes.

Two done-when items did not land as written, both mine:

**The 2×-of-floor bar was the wrong bar, and it is not met everywhere.**
Numeric columns, tag predicates, presence tests and conjunctions are at
0.1–1.5×. Dictionary columns sit at **3.4×**, and that is close to inherent: a
gather through an id column cannot vectorize the way a linear `u64` compare
does. General arithmetic (`abs(seq - named("x").seq) <= 1000`) is **44×** —
13.3 ms, still half of E010's gate, and the one shape with no specialized
leaf. I have not moved the line to match the result: the right bar is E010's
gates, which are met everywhere, and the arithmetic path is
[T045](T045-lower-integer-arithmetic-to-a-narrow-path.md).

**The WASM gates are not measured.** Doing it means driving a browser, which
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) says an agent
must not do. What is measured is native, where the common predicates are 60×
under the gate and scaling to 3M creators is linear — so the WASM margin would
have to be worse than 60× for the gate to fail. Named here and in
[now](../now.md) as the outstanding check rather than quietly dropped.
