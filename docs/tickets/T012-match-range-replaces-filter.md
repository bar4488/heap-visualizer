---
id: T012
title: Match range replaces the filter instead of inserting
status: todo
updated: 2026-07-25
---

# T012: Match Range Replaces the Filter Instead of Inserting

## Outcome

The allocation panel's **match range** action sets the filter expression to
`span overlaps <addr>..<end>` and applies it, replacing whatever was there.

## Context

Today `q('.d-range').onclick` in `src/web/main.ts` calls `insertFilterText`,
which splices the predicate in at the editor cursor with an `&&` glue and
leaves the user to press Apply.
[ANL-003](../../spec/07-analysis.md#anl-003-filter) specifies that insertion in
so many words, so the spec changes with the code.

## Done when

- [ ] Match range replaces the draft with the single `span overlaps` predicate
  and applies it.
- [ ] The status line reports the range that is now filtering, not "Apply to
  activate".
- [ ] ANL-003 says replace, and no longer says "at the editor cursor".
- [ ] `insertFilterText` is gone, or has a remaining caller.

## Non-goals

- Changing the predicate's syntax.
- The address-range list that E010 removed.
