---
id: T056
title: Keep only the essential walkthrough
status: done
updated: 2026-09-05
---

# T056: Keep Only the Essential Walkthrough

## Outcome

The guide teaches the core workflow without doubling as feature reference.

## Done when

- [x] Every section has one purpose and a short action-to-observation path.
- [x] The trace model, map, playhead, selection, filter, and analysis layer are
      still introduced.
- [x] The format sample remains available and every shipped action resolves.
- [x] `node --test 'src/web/**/*.test.ts'` passes and `./build.sh web` succeeds.

## Non-goals

- Documenting secondary controls, shortcuts, edge cases, or every filter field.

## Result

The walkthrough is 68 source lines, down from 142. It retains one action for
each core concept and removes formulas, mode catalogs, shortcut lists, edge
cases, and secondary analysis features. The web suite and emitted build pass.
