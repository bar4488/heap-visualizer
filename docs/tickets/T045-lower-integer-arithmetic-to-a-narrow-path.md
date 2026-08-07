---
id: T045
title: Lower integer arithmetic to a narrow path
status: todo
updated: 2026-08-07
---

# T045: Lower Integer Arithmetic to a Narrow Path

## Outcome

An expression doing arithmetic on integer columns —
`abs(seq - named("x").seq) <= 10`, `end - address >= size` — scans within the
same order of magnitude as a plain column comparison, instead of ~30× it.

## Done when

- [ ] `abs(seq - named("anchor").seq) <= 1000` over 1M creators is within 5× of
      the `floor()` control in
      [E019-bench](../explorations/E019-bench/filter_cost.rs). It is 44× today.
- [ ] The plan and the tree-walking oracle still agree on every expression in
      `the_plan_agrees_with_the_oracle_on_every_shape`, with arithmetic cases
      added for the boundaries the narrow path introduces.
- [ ] Overflow still makes the enclosing comparison false rather than wrapping
      or trapping, including where a value does not fit the narrow
      representation.
- [ ] `the_scan_allocates_nothing_per_event` still passes.

## Context

[T041](T041-lower-the-filter-to-a-typed-plan.md) lowered everything else and
left this shape alone: `Scalar` evaluates through `i128` and `Option<Num>` per
event, which is the one leaf that never got specialized. Its Result has the
measurement.

The likely fix is a parallel narrow scalar tree chosen at lowering when every
constant fits and every column is a plain `u64`, falling back to the wide path
otherwise. **The trap is that addresses are `u64` and do not all fit `i64`** —
a narrow path that assumes they do is wrong near the top of the address space
and wrong silently, which is worse than being slow. Whatever range check makes
it safe belongs in the lowering decision, not in the per-event loop.

Not urgent: the shape clears E010's gate at half the budget. It is filed
because T041 measured it, not because anything is waiting on it.

## Non-goals

- SIMD, or threading the scan.
- Widening the language. This is representation, not semantics: the visible
  numeric type stays what
  [ANL-012](../../spec/07-analysis.md#anl-012-numbers-in-the-filter-language)
  says it is.
