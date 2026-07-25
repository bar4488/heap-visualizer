---
id: T001
title: Namespace and version the heap-owned fields in the persisted session
status: doing
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

- [x] `buildSession()` in `web/session.js` writes heap-owned fields under a
      single `heap` key that carries a version field.
- [x] `applySession()` accepts both the new shape and a blob written in the
      current flat shape, and `node --test 'web/**/*.test.js'` asserts the old
      shape restores identically.
- [x] `web/shell/drawers.js` and `web/shell/panels.js` still name no heap
      concept: `grep -ric heap web/shell/` reports 0 for every file.
- [x] `spec/07-analysis.md` §7.7 describes the persisted shape as written.
- [ ] A person checks save-session / reload / restore by hand, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md). **This is
      the only item outstanding** — see Handoff.

## Non-goals

- Changing the `.heapa` analysis-file format. It is user-authored data with its
  own compatibility story.
- A general migration framework. One read path for one old shape.

## Work log

The last done-when item said "the smoke checklist's save-session / reload /
restore steps pass by hand". [T006](T006-drop-fixed-smoke-checklist.md) deleted
that checklist; the item was re-grounded to name D001 and
[context.md](../context.md#verify-a-web-change) instead. Hand verification did
not change, only what it points at.

Two things the ticket did not anticipate:

- **`pinned` is heap state, not shell state.** A pinned window's geometry looks
  like workspace state, but the record is keyed by creator event index and
  cannot be restored without asking the engine what that event was. It went
  under `heap`. The panel windows in `windows` are the opposite case — the
  shell places them and the ids arrive through `deps`.
- **Apply order had to be preserved exactly.** The flat shape was applied as
  settings → windows → crop/playhead → drawers → pinned, and docking a drawer
  resizes the canvas, so the shell block cannot simply move ahead of the heap
  block. `applySession` interleaves the two rather than running one after the
  other, and says why.

The `.heapa` file embeds `buildSession()` output, so exported files now carry
the new shape. This is not a change to the analysis format: the session blob is
opaque to `web/heap/analysis.js`, which passes it straight to `applySession`,
and an older file's flat session still reads through the same path.

## Result

`web/session.js` writes `{ heapVisualizerSession, windows, drawers, heap }`,
with `heap.version = 1` (`HEAP_SESSION_VERSION`). `applySession` reads three
cases: the new shape, the old flat shape (no `heap` key — the envelope itself
is the section), and a `heap` section at an unknown version, which restores the
workspace and leaves heap state at defaults rather than half-applying it.

`node --test 'web/**/*.test.js'` is 42 tests, up from 39: the old flat shape
restores identically, an unknown heap version is skipped while the shell layout
still restores, and the top level holds exactly the four expected keys.
`cargo test` is unchanged at 33.

## Handoff

The code is done and both suites pass. The ticket stays `doing` because D001
says an agent does not report a web change as verified on unit tests alone, and
the one remaining done-when item is a person's.

What a person needs to check, against `demo.heapl` (`./serve.py`, then
`http://localhost:8630?trace=demo.heapl`):

1. Move and dock a panel, set a filter and a crop, pin an allocation window,
   scrub the playhead. Reload. All of it should come back.
2. An old-shape session still in `localStorage` under
   `heapviz:session:demo.heapl` — from a build before this change — should
   restore the same way. `localStorage.setItem` with a hand-written flat blob
   works too; the read path is the same one the new test covers.

Then check the last box and set `status: done`.
