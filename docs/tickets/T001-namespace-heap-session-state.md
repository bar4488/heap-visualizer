---
id: T001
title: Namespace and version the heap-owned fields in the persisted session
status: todo
updated: 2026-07-25
---

# T001: Namespace and Version the Heap-Owned Fields in the Persisted Session

## Outcome

The per-trace session blob written to `localStorage` separates shell-owned
state (window geometry, drawer layout) from heap-owned state (view, crop,
filters, playhead, address ranges) by putting the heap-owned fields under a
`heap` key carrying its own version number — and still reads sessions written
in the old flat shape.

## Context

`web/session.js` is the boundary module: it serializes both categories into one
blob. Its header comment records that the persisted shape was deliberately left
unchanged during the shell/domain split, because namespacing is a behavior
change and the split was a pure lift-and-shift.

This is the cheapest it will ever be to do. There is exactly one writer, and
`web/test/session.test.js` already
asserts `buildSession → applySession → buildSession` is a fixed point, so
old-shape-in / new-shape-out has a place to be checked.

Constraint and reasoning: [E007 §3](../explorations/E007-web-architecture-direction.md).

## Done when

- [ ] `buildSession()` in `web/session.js` writes heap-owned fields under a
      single `heap` key that carries a version field.
- [ ] `applySession()` accepts both the new shape and a blob written in the
      current flat shape, and `node --test 'web/**/*.test.js'` asserts the old
      shape restores identically.
- [ ] `web/shell/drawers.js` and `web/shell/panels.js` still name no heap
      concept: `grep -ric heap web/shell/` reports 0 for every file.
- [ ] `spec/07-analysis.md` §7.7 describes the persisted shape as written.
- [ ] The smoke checklist's save-session / reload / restore steps pass by hand.

## Non-goals

- Changing the `.heapa` analysis-file format. It is user-authored data with its
  own compatibility story.
- A general migration framework. One read path for one old shape.
