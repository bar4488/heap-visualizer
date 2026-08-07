---
id: D008
title: The filter evaluator is a lowered plan, never a walk over the AST
created: 2026-08-07
---

# D008: The Filter Evaluator Is a Lowered Plan

## Decision

A filter Apply compiles the checked syntax tree to a **flat, typed plan over
the store's columns**, and the scan executes that plan. The scan must never
walk the AST.

Concretely, per event the scan does not: allocate, clone a `String`, hash,
parse JSON, compare a field name as a string, dispatch virtually, or return a
`Result` per node. Every name — field, tag label, site, thread, custom key —
resolves to an integer id or a column index once, while compiling.

**A new operator or field is added by extending the plan, not by adding a case
to a tree walk.** That is the specific thing this decision exists to prevent:
the cheap way to add one is always the interpreter, and it is how the current
evaluator was arrived at one case at a time.

## Why

[E010](../explorations/E010-filter-expression-language.md) specified exactly
this in its Compilation section and gated implementation on meeting stated
performance numbers. The UI shipped; the lowering did not. `filter_eval::eval`
walks the AST once per event, boxing each intermediate into a `Value` carrying
`i128`, cloning a `String` for `site` and `stack`, and heap-allocating a `Vec`
for `tags`.

Measured native release over 1M creator events
([E019-bench](../explorations/E019-bench/filter_cost.rs)):

| | median |
|---|---|
| `size >= 4096`, tree walk | 38.0 ms |
| `size >= 4096`, direct column scan | 0.8 ms |

**45× above the floor its own data layout allows**, and E010's gate is 25 ms
median over the same 1M rows *in release WASM* — already missed by native time
alone, before the browser's penalty.

The gate numbers are E010's and are not restated here; that file owns them.

## What this does not license

It does not license caching layers in the web layer to hide a slow scan. E010
already says the first response to a missed gate is to simplify or specialize
the plan, and this decision is why: the headroom is in the evaluator, so an
Apply that is slow is an evaluator that was not lowered.

It does not make the plan a persisted artifact. Compiled plans and match bits
are never saved; restore compiles the source again.
