---
id: T002
title: Declare panel content as data instead of a hand-maintained id list
status: doing
updated: 2026-07-25
---

# T002: Declare Panel Content as Data

## Outcome

Each panel's id, title, and build function live in one record in a heap-owned
table handed to the shell at startup. The `PANEL_IDS` array is gone, and no
shell module reaches for a panel by name.

## Context

`web/main.js:951` declares `PANEL_IDS` as a flat array of seven ids. It is
consumed in `web/main.js:1045` (passed into `initSession`) and iterated twice in
`web/session.js` (lines 39 and 136), and the test suite keeps its own copy at
`web/test/session.test.js:16` and `web/test/analysis.test.js:20` — four places
that must agree by hand.

Stage 2 of [E007](../explorations/E007-web-architecture-direction.md#stage-2--declare-panel-content-as-data),
whose §4 sketches the record shape. A registry with lifecycle is additive to it
and belongs to [T004](T004-shell-host.md), not here.

The honest test of the seam: if a panel cannot be expressed as one of these
records, that is a finding about the split from [T001](T001-namespace-heap-session-state.md)'s
era, and it is cheap to act on now.

## Done when

- [x] A single exported table — one record per panel, with at least `id`,
      `title`, and a build function — is the only place a panel id is written.
- [x] `PANEL_IDS` no longer exists in `web/main.js`; `web/session.js` derives
      the panel list from the table it is handed.
- [x] The test fixtures derive their panel list from the same table rather than
      re-declaring it.
- [x] `node --test 'web/**/*.test.js'` passes, and `grep -ric heap web/shell/`
      reports 0 for every file.
- [x] [SHELL-003](../../spec/09-ui-shell.md#shell-003-panels-are-declared-as-data) describes panels as
      declared records.
- [ ] A person checks that every panel opens, docks, floats, and restores, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md). **This is
      the only item outstanding** — see Handoff.

## Non-goals

- Panel lifecycle, activation, discovery, manifests, or versioning.
- Renaming any heap concept to a generic term.

## Work log

`web/heap/panels.js` exports `heapPanels(builders)`: a module-private array of
`{ id, title, toggle }` records, returned with each panel's build function
attached by id. Builders arrive from `main.js` because that is where the build
functions are — `heapPanels` is a function rather than a constant for exactly
that reason, and it throws on an id that is not in the table so a typo cannot
become a build step that never runs.

The ticket asked whether every panel fits one record. Two did not, and both
are recorded in the table rather than worked around:

- **The events panel wires its own toolbar button.** Opening it also resets and
  refreshes the virtualized list, so it is not the generic show/hide the other
  six share. Its record carries `toggle: null` and `web/heap/events-panel.js`
  keeps its own handler. This is a real difference in behavior, not an
  accident of the split.
- **Titles had two owners.** `index.html` spelled each title in its
  `.panel-head`, and putting `title` in the record would have made that two
  places. The seven heads now carry an empty `<span class="ph-t">` — the same
  element the allocation panel already used for its dynamic title — filled from
  the table at startup.

`onLoaded` now refills panels by iterating the table instead of calling seven
build functions in a hand-written order. The order it iterates in is the
table's, and the UI state each build function reads is reset above the loop, so
no panel's build depends on another's.

## Result

Four hand-synced copies of the seven panel ids became one. `PANEL_IDS` is gone
from `web/main.js`, `web/session.js` takes `panels` in its deps and derives ids
from it, and both test fixtures import the table.

`node --test 'web/**/*.test.js'` is 44 tests, up from 42: `web/test/panels.test.js`
pins that every record is complete and that an unknown builder id throws.
`cargo test` is unchanged at 33. `grep -ric heap web/shell/` still reports 0
for every file.

## Handoff

The code is done and both suites pass; the remaining done-when item is a
person's, per D001.

What to check, against `demo.heapl` (`./serve.py`, then
`http://localhost:8630?trace=demo.heapl`):

1. Each of the seven toolbar buttons opens and closes its panel, and each panel
   head shows the right title (Play, Layout, Appearance, Filter, Marks,
   Warnings, Events) — the titles now come from the table, not the markup.
2. Panels still drag, dock left and right, and restore on reload.
3. Loading a second trace over the first refills every panel: the filter's
   site/thread lists, the legend, the marks panel, the warnings list, the
   events list, the speed select, and the row-bytes hint.

Then check the last box and set `status: done`.
