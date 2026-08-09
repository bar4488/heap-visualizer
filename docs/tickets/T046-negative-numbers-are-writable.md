---
id: T046
title: Negative numbers are writable
status: todo
updated: 2026-08-09
---

# T046: Negative Numbers Are Writable

## Outcome

`-5` is an expression. The allocation panel's one-click predicate for a
negative custom field value compiles and applies like every other one.

## Done when

- [ ] `malloc.fields.drift == -2.5` parses, checks, and evaluates.
- [ ] A unary-minus test is in `src/filter-dsl/tests/parser.rs`, including
      that it binds tighter than `+`/`-` and looser than a field access, and
      that `- -1` is not special-cased into something else.
- [ ] `customFieldPredicate` in `src/web/filter-actions.ts` has a web test for
      a negative value, restoring the `-2.5` case
      [T042](T042-the-filter-language-is-python-shaped.md) removed.
- [ ] The plan folds a negated constant at lowering rather than negating per
      event, and the plan/oracle corpus in
      `the_plan_agrees_with_the_oracle_on_every_shape` covers a negative
      operand.

## Context

**Pre-existing, and not introduced by the Python cutover** — the grammar never
had unary minus, in E010 or after it. What makes it worth a ticket now is that
the custom-field panel generates the predicate: a trace carrying a negative
number offers a button whose filter cannot compile, and the diagnostic
("expected an expression") points at the minus without explaining it.

Verified on 2026-08-09: `malloc.fields.drift == -2.5` fails to parse, while
`alloc.size == 0 - 5` parses.

The workaround inside the language is subtraction from zero, which is not
something a person would guess.

## Non-goals

- Unary `+`. Python has it; it means nothing here and nothing generates it.
- Any other arithmetic. `*`, `/` and `%` stay out
  ([E010](../explorations/E010-filter-expression-language.md) keeps the
  language small).
