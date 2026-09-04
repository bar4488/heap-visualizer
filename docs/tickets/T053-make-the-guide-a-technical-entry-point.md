---
id: T053
title: Make the guide a technical entry point
status: done
updated: 2026-09-05
---

# T053: Make the Guide a Technical Entry Point

## Outcome

The in-app guide gives an experienced engineer a compact path through the trace
model, views, query language, and saved analysis without visual separators that
compete with its heading structure.

## Done when

- [x] The six guide sections follow the product's data flow and omit tutorial
      detail that is not needed for technical orientation.
- [x] Section headings, rather than horizontal lines, organize the drawer.
- [x] The sample trace download, scenario links, and representative control
      actions still work.
- [x] `node --test 'src/web/**/*.test.ts'` passes and `./build.sh web` succeeds.

## Non-goals

- Changing application behavior or the trace format.

## Result

The guide now runs from trace format through address and time models, selection,
queries, and persisted analysis in 181 source lines rather than 353. Markdown
soft wraps render as paragraphs and list continuations instead of separate
blocks, and section boundaries use whitespace rather than rules. The web suite
and emitted web build pass.
