---
id: T042
title: The filter language is Python-shaped over alloc, malloc and free
status: todo
updated: 2026-08-07
---

# T042: The Filter Language Is Python-Shaped Over `alloc`, `malloc`, `free`

## Outcome

A person who knows Python writes a correct filter without reading a grammar.
Every field is reached through `alloc`, `malloc`, or `free`; the operators are
Python's; and no old spelling resolves.

One cutover, one persisted break. There is no compatibility mode and no
translator.

## Done when

- [ ] `and` `or` `not` are the boolean operators and `&&` `||` `!` are syntax
      errors naming their replacement.
- [ ] `in` is the only membership operator, over sets, strings, stacks, and
      `range()`. The `contains` operator and `str.contains` are gone.
- [ ] `startswith` / `endswith` replace `starts_with` / `ends_with`.
- [ ] `range(lo, hi)` replaces `lo..hi`, half-open as before, and
      `.overlaps(range(...))` replaces the `overlaps` operator.
- [ ] `is None` / `is not None` replace `is missing` / `is not missing`. The
      false-propagation semantics are unchanged, and a missing test on a
      required field is still a diagnostic.
- [ ] Chained comparison (`0 <= alloc.size < 4096`) parses and means the
      conjunction.
- [ ] `len()` returns the size of a set.
- [ ] Every field resolves only under its namespace, per the mapping table in
      [E019](../explorations/E019-a-python-shaped-filter-language.md#the-object-model).
      Bare `size`, `site`, `field.x`, and `death.*` are errors that name the
      new spelling.
- [ ] Completion offers the namespaces, advances through them, and never
      advertises a removed spelling. The completion-context tests in
      `src/filter-dsl/tests/` cover `alloc.`, `malloc.`, `free.`,
      `malloc.fields.`, and `range(`.
- [ ] `src/web/filter-actions.ts` generates and recognizes the new source for
      legend chips, match range, and filter-to-tag; its web tests are updated
      and pass.
- [ ] The heap-session version is bumped, and a session or `.heapa` mark
      carrying old-surface source reports its diagnostic rather than being
      rewritten or silently dropped.
- [ ] ANL-003, ANL-010, ANL-011, ANL-012 and every other spec citation of the
      old surface are updated in this same change. `rg 'is missing|overlaps |
      starts_with|death\.field|&&' spec docs/*.md src` finds no live use.
- [ ] The guide's filter content teaches the new surface.
- [ ] All four checks in [context](../context.md#test) pass.

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
