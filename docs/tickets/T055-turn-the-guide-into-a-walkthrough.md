---
id: T055
title: Turn the guide into a walkthrough
status: done
updated: 2026-09-05
---

# T055: Turn the Guide into a Walkthrough

## Outcome

The in-app guide leads a technical reader through one coherent investigation,
with each short explanation followed by an action and an observable result.

## Done when

- [x] The sections form a sequential path rather than an API-style reference.
- [x] A reader can follow the primary path with one trace and working guide
      actions.
- [x] Technical details explain observations at the point they become useful.
- [x] `node --test 'src/web/**/*.test.ts'` passes and `./build.sh web` succeeds.

## Non-goals

- Exhaustively documenting every control or changing application behavior.

## Result

The six sections now lead one investigation over `sites.heapl`: load, alter the
map, seek, inspect an allocation, refine a query, and snapshot it as a tag.
Actions state the expected visual result before introducing the model behind it.
The shipped guide-page checks, full web suite, type-check, and emitted build pass.
