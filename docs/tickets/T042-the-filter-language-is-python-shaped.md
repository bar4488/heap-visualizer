---
id: T042
title: The filter language is Python-shaped over alloc, malloc and free
status: done
updated: 2026-08-09
---

# T042: The Filter Language Is Python-Shaped Over `alloc`, `malloc`, `free`

## Outcome

A person who knows Python writes a correct filter without reading a grammar.
Every field is reached through `alloc`, `malloc`, or `free`; the operators are
Python's; and no old spelling resolves.

One cutover, one persisted break. There is no compatibility mode and no
translator.

## Done when

- [x] `and` `or` `not` are the boolean operators and `&&` `||` `!` are syntax
      errors naming their replacement.
- [x] `in` is the only membership operator, over sets, strings, stacks, and
      `range()`. The `contains` operator and `str.contains` are gone.
- [x] `startswith` / `endswith` replace `starts_with` / `ends_with`.
- [x] `range(lo, hi)` replaces `lo..hi`, half-open as before, and
      `.overlaps(range(...))` replaces the `overlaps` operator.
- [x] `is None` / `is not None` replace `is missing` / `is not missing`. The
      false-propagation semantics are unchanged, and a missing test on a
      required field is still a diagnostic.
- [x] Chained comparison (`0 <= alloc.size < 4096`) parses and means the
      conjunction.
- [x] `len()` returns the size of a set.
- [x] Every field resolves only under its namespace, per the mapping table in
      [E019](../explorations/E019-a-python-shaped-filter-language.md#the-object-model).
      Bare `size`, `site`, `field.x`, and `death.*` are errors that name the
      new spelling.
- [x] Completion offers the namespaces, advances through them, and never
      advertises a removed spelling. The completion-context tests in
      `src/filter-dsl/tests/` cover `alloc.`, `malloc.`, `free.`,
      `malloc.fields.`, and `range(`.
- [x] `src/web/filter-actions.ts` generates and recognizes the new source for
      legend chips, match range, and filter-to-tag; its web tests are updated
      and pass.
- [x] The heap-session version is bumped, and a session or `.heapa` mark
      carrying old-surface source reports its diagnostic rather than being
      rewritten or silently dropped.
- [x] ANL-003, ANL-010, ANL-011, ANL-012 and every other spec citation of the
      old surface are updated in this same change. `rg 'is missing|overlaps |
      starts_with|death\.field|&&' spec docs/*.md src` finds no live use.
- [x] The guide's filter content teaches the new surface.
- [x] All four checks in [context](../context.md#test) pass.

## Context

[E019](../explorations/E019-a-python-shaped-filter-language.md) is the design
and records which conflicts were decided by the user, and how, on 2026-08-07.
It supersedes parts of [E010](../explorations/E010-filter-expression-language.md),
which is left unedited.

Depends on [T041](T041-lower-the-filter-to-a-typed-plan.md): the extra
namespace node per field access is a per-event cost on the tree walk and free
on a plan.

The migration surface is wider than the session blob — saved filters in
`.heapa` marks and the generated predicates in `filter-actions.ts` both carry
source text. E019 §Migration is the list.

## Non-goals

- Syntax highlighting ([T043](T043-filter-syntax-highlighting.md)).
- A translator for stored old-surface sources. E019 §Migration argues it is
  cheap to add later and impossible to undo, and flags it as the one open
  question.
- Any new capability. Python shape is the spelling of what exists; `len()` is
  the single addition, and it exists because `alloc.tags` had no size.
- `realloc` as a fourth namespace.

## Result

One cutover across four layers. `src/filter-dsl/` owns the grammar,
`filter_eval::resolve_path` owns what a path names, `filter_plan` lowers it,
and the web layer generates and reads back the new source.

**`named()` is regular, not short** — `named("x").alloc.address`, not
`named("x").address`. E019 showed the flat form, carried from E010 without
being reconsidered; a named allocation is the same kind of thing as the
subject, so it exposes the same three objects. E019 carries the correction.

**One deliberate loss.** `"suspect" in alloc.tags` puts the value before the
set, so there is no left operand to complete tag names from at the point of
typing one. `alloc.tags == {"` still completes them and the legend chips write
the predicate directly. It is a real cost of Python's operand order.

**Two bugs the cutover exposed rather than caused.** `receiver_before_dot` in
the DSL only ever walked back one token, which was enough while a receiver was
`site` or `stack` and is not enough for `malloc.fields`; and
`call_argument_context` never split its callee on `in`, which did not matter
until `in range(lo, hi)` became the ordinary form. Both had drifted between two
delimiter lists in the same file that now agree.

**And one defect it surfaced without causing**: the language has no unary
minus, so the custom-field panel offers a one-click predicate for a negative
value that cannot compile. Pre-existing in every version of the grammar;
[T046](T046-negative-numbers-are-writable.md) has the reproduction, and the
`-2.5` case removed from `filter-actions.test.ts` comes back with it.

The plan/oracle equivalence corpus was translated rather than shrunk: all 78
expressions still run through both implementations and agree bit for bit.
