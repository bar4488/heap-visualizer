---
id: T013
title: Named filters saved in the marks file
status: todo
updated: 2026-07-25
---

# T013: Named Filters Saved in the Marks File

## Outcome

A filter expression can be saved under a name, set again from a list in the
Filter panel, renamed and deleted, and it rides in the `.heapa` file and the
marks autosave alongside tags and bookmarks.

## Context

`buildMarks`/`applyMarks` (`src/web/heap/analysis.ts`) own the
`heapVisualizerAnalysis: 1` object; `src/web/test/analysis.test.ts` already
asserts a marks round trip.
[ANL-007](../../spec/07-analysis.md#anl-007-persistence--heapa-files-and-autosave)
lists what marks carry, and
[ANL-001](../../spec/07-analysis.md#anl-001-the-analysis-objects) lists the
analysis objects; both gain saved filters.
[E013](../explorations/E013-filter-actions.md) records why marks and not the
session blob.

## Done when

- [ ] Saving names the current expression; an existing name is overwritten
  rather than duplicated.
- [ ] The Filter panel lists saved filters, and setting one puts its source in
  the editor and applies it.
- [ ] A saved filter can be renamed and deleted, and either marks the analysis
  dirty for autosave.
- [ ] `buildMarks` writes them and `applyMarks` restores them, with a
  `node --test` round trip covering a saved filter.
- [ ] A marks file without the field loads unchanged, and a malformed entry is
  dropped rather than throwing.
- [ ] ANL-001, ANL-003 and ANL-007 describe saved filters.

## Non-goals

- Saved filters that follow the user across traces.
- Sharing a filter without the rest of the analysis.
- Any evaluation at save time — a saved filter is source text.
