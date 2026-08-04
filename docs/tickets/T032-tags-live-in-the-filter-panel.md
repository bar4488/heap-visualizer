---
id: T032
title: Tags live in the Filter panel, and the field catalog collapses above them
status: done
updated: 2026-08-05
---

# T032: Tags Live in the Filter Panel, and the Field Catalog Collapses Above Them

## Context

Reported 2026-08-05: the tag list is in the Marks panel, but tags are used as a
filtering surface — legend chips, `tags contains "x"`, **Tag matches** — so it
is read next to the filter editor and edited in another panel. The trace-field
catalog is a long always-open block wedged below the tag-matches row.

## Outcome

The tag list — recolor, rename, delete, counts — is a section of the Filter
panel and appears nowhere in the Marks panel, which keeps time marks, address
marks and named allocations. The trace-field catalog sits above the
tag-matches row and is collapsed by default, expandable in place.

## Done when

- [x] `#tags-list` is inside `#filter-panel`; `#analysis-panel` has no tags
      section.
- [x] Recolor, rename, delete and the count still work from their new home —
      the delegated handlers in `heap/analysis.ts` bind by element id, so they
      must not need rewiring.
- [x] The tag rows are styled in their new panel: `.an-row` rules in
      `style.css` are scoped to `#analysis-panel` today.
- [x] Creating a tag no longer reveals the Marks panel button
      (`analysis.ts:60`); the trace load path already unhides it.
- [x] The field catalog renders above `.filter-action-row` and starts
      collapsed; `buildFieldCatalog`'s `section.hidden` still hides it whole
      for a trace with no custom fields.
- [x] `node --test 'src/web/**/*.test.ts'` and `node_modules/.bin/tsc` pass,
      and `./build.sh web` emits.

## Non-goals

- The Appearance color-mode complaint from the same report. Separate cause,
  separate ticket once its reproduction is known.
- Any change to what a tag *is*, to `.heapa` persistence, or to the filter
  language.
