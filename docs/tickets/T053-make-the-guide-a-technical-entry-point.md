---
id: T053
title: Make the guide a technical entry point
status: doing
updated: 2026-09-05
---

# T053: Make the Guide a Technical Entry Point

## Outcome

The in-app guide gives an experienced engineer a compact path through the trace
model, views, query language, and saved analysis without visual separators that
compete with its heading structure.

## Done when

- [ ] The six guide sections follow the product's data flow and omit tutorial
      detail that is not needed for technical orientation.
- [ ] Section headings, rather than horizontal lines, organize the drawer.
- [ ] The sample trace download, scenario links, and representative control
      actions still work.
- [ ] `node --test 'src/web/**/*.test.ts'` passes and `./build.sh web` succeeds.

## Non-goals

- Changing application behavior, the trace format, or the guide renderer.
