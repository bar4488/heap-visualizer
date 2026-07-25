---
id: T011
title: Legend chips toggle a filter conjunct
status: done
updated: 2026-07-25
---

# T011: Legend Chips Toggle a Filter Conjunct

## Outcome

Clicking a site, thread or tag chip in the legend adds that predicate to the
filter expression as a top-level conjunct and applies it; clicking an active
chip removes the predicate again. The expression stays the only filter state.

## Context

`buildLegend` (`src/web/main.ts`) paints chips for color modes 1 (site), 2
(thread) and 5 (tag, plus an *untagged* chip); modes 3 and 4 are ramps. The
predicates are `site == "…"`, `thread == <n>`, `tag == "…"` and
`tag is missing`, all executable today
([E010](../explorations/E010-filter-expression-language.md) field table,
`src/core/src/filter_eval.rs`). Design and the decisions behind it are
[E013](../explorations/E013-filter-actions.md).

## Done when

- [ ] A pure module exports the source rewrite — add, remove, and "is this
  predicate a top-level operand" — and is covered by `node --test`.
- [ ] A source whose top level is `||` is parenthesized before a conjunct is
  appended, so `a || b` + `p` is `(a || b) && p`, not `a || b && p`.
- [ ] Strings inside the source do not confuse the top-level split: a literal
  `"a && b"` is one operand.
- [ ] Site, thread and tag names are quoted with `"` and `\` escaped.
- [ ] Clicking a chip writes the draft, applies it, and opens nothing the user
  did not ask for; shift-click uses `||`.
- [ ] A chip renders as active when its predicate is a top-level operand of the
  *applied* source, and the state survives `buildLegend` being rebuilt.
- [ ] ANL-003 states the chip action and that chips carry no state of their own.

## Non-goals

- Chips for the size and age ramps.
- Any filter state that is not the expression.
- Editing a predicate nested inside parentheses or a call.

## Result

Implemented in `src/web/filter-actions.ts` and wired to the site, thread, tag,
and untagged legend chips. The pure rewrite tests cover add/remove, precedence,
quoted operators, nested expressions, connector removal, and string escaping.
`node --test src/web/test/filter-actions.test.ts` and
`npx tsc -p tsconfig.test.json` pass.
