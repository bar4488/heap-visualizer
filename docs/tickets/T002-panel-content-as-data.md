---
id: T002
title: Declare panel content as data instead of a hand-maintained id list
status: todo
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

- [ ] A single exported table — one record per panel, with at least `id`,
      `title`, and a build function — is the only place a panel id is written.
- [ ] `PANEL_IDS` no longer exists in `web/main.js`; `web/session.js` derives
      the panel list from the table it is handed.
- [ ] The test fixtures derive their panel list from the same table rather than
      re-declaring it.
- [ ] `node --test 'web/**/*.test.js'` passes, and `grep -ric heap web/shell/`
      reports 0 for every file.
- [ ] `spec/09-ui-shell.md` describes panels as declared records.
- [ ] Every panel opens, docks, floats, and restores per the smoke checklist.

## Non-goals

- Panel lifecycle, activation, discovery, manifests, or versioning.
- Renaming any heap concept to a generic term.
