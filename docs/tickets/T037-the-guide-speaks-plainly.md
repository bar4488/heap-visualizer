---
id: T037
title: The guide speaks plainly
status: done
updated: 2026-08-07
---

# T037: The Guide Speaks Plainly

## Outcome

The six pages under `src/web/guide/` read as direct instruction. Every fact,
action link, and scenario-trace link they carry today survives the rewrite.

Asked for by the user on 2026-08-07: the guide reads like an AI wrote it —
"this is X, nothing else", "not X, not Y, not Z", and the rest of the
constructions that circle a point instead of stating it.

## Done when

- [x] `rg -c 'g-act|#(show|do|set):' ` over the rewritten pages accounts for
      every action link that was there before; no id or value changed.
- [x] `node --test 'src/web/**/*.test.ts'` passes.
- [x] `./build.sh web` succeeds and `dist/guide/` matches `src/web/guide/`.

## Non-goals

- Changing what the guide claims. This is a rewrite of the prose, not a
  re-grounding of the facts.
- `guide.ts`, the renderer, the scenario traces, or the section list.
- The same pass over `docs/`, the spec, or code comments.
