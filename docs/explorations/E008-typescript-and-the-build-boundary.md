---
id: E008
title: "TypeScript, the build step, and where source ends and output begins"
status: settled
updated: 2026-07-25
---

# TypeScript, the build step, and the source/output boundary — 2026-07-25

A working session's thinking, recorded because the conclusion reverses a
documented stance and the argument that got there is worth more than the
conclusion alone.

## Summary

T003 was written as "types at
the contracts, and a build step". Grounding it surfaced a prior question the
ticket had already answered implicitly: **does adopting TypeScript here require
compiling, or only checking?** Two shapes were argued. The compiling one won,
for reasons that are mostly about where this codebase is going rather than what
it is now.

A second question followed from the first — if there is a build, what exactly
is a build product? — and produced a repository layout change that is
independent of TypeScript and was pulled out into its own ticket.

## Why it matters

Reversing [TOOL-002](../../spec/10-tooling.md#tool-002-build) is not a
preference. "`web/` is served as-is" is load-bearing for how a person verifies
a change (D001): edit,
refresh, look at the canvas. Anything that puts a step between the file and the
browser is taxing the only end-to-end check this project has.

## The two shapes

**A. Check in place.** Contracts as `.d.ts`; existing `.js` annotated with
`// @ts-check` and JSDoc; `tsc --noEmit` as the check. No emit, no served-output
change, `typescript` a dev dependency.

**B. Compile.** Sources become `.ts`; `tsc` emits ES modules; the emitted tree
is what is served.

The initial recommendation here was **A**, on three arguments:

1. The expressive win lives in declaration files, and `.d.ts` is full-strength
   TypeScript either way. T003's non-goals exclude typing implementations, so
   for *this ticket's scope* the two shapes are nearly identical.
2. The verification loop is the scarce resource — edit/refresh versus
   edit/watch/refresh, with a new "am I looking at stale output" failure mode.
3. Reversibility: `allowJs` lets files flip to `.ts` one at a time later.

Bar pushed back on 2 and 3, and the pushback was right:

- **`build.sh` was already required.** A fresh checkout cannot serve anything
  until the wasm is built. The "no build step" property was already half true,
  so the loop being defended was narrower than the argument implied.
- **Source maps make compiled debugging fine.** The devtools objection was
  weaker than it sounded, in a project whose hardest bugs (canvas, pointer
  gestures, drawer geometry) are debugged live.
- If the destination is TypeScript, arriving there in two moves costs more than
  arriving in one, and a halfway house tends to become permanent. Teams that
  add `@ts-check` intending to migrate frequently do not.

Recorded disagreement, since it may matter later: argument 2 is not *wrong*,
only outweighed. The watch/stale-output failure mode is real and will be paid
occasionally; the mitigation is a fast path in `build.sh`, not a promise that
it cannot happen.

Decision: **B**. Rationale in
[D004](../decisions/D004-typescript-is-the-language-for-web.md).

## Then: what is a build product?

If there is a compile step, the emitted JS has to land somewhere, which forced a
question that had been sitting unasked. Evidence from the tree:

- `web/heap_visualizer_core.wasm` — gitignored, produced by `build.sh`.
- `web/demo.heapl` — gitignored, 6.7 MB, produced by `gen.py`.
- Everything else in `web/` — hand-written and tracked.

**`web/` was already a mixed source-and-output directory**, with two gitignore
lines quarantining outputs inside the source tree. Bar proposed making the split
explicit: sources under `src/` (both the Rust core and the web layer), all
generated output under `dist/`. That is the same rule the tree was already
groping toward, stated once instead of patched twice.

The emitted layout mirrors today's `web/` exactly — `dist/main.js`,
`dist/shell/`, `dist/heap/`, wasm and demo at the root — so every relative URL
in `index.html` and `main.js` keeps working and the move is a rename plus
script-path edits, not a rewrite of how the page finds its worker.

Costs accepted, both named rather than discovered later:

- **`index.html` and `style.css` must be copied into `dist/`.** They compile to
  nothing, so the copy buys nothing except the boundary being real; the cost is
  that a CSS tweak now needs a command. A `./build.sh web` fast path (no cargo)
  keeps it under a second, and symlinking those two files stays available if it
  chafes in practice.
- **Repo-wide path churn.** `core/` and `web/` are named in the README, the
  context file, the spec's module map,
  [ARCH-005](../../spec/08-architecture.md#arch-005-module-layout), and every
  closed exploration. The closed ones are dated records and are not migrated;
  their file paths become historical rather than navigational.

`demo.heapl` also stops being a file that happens to exist in a working tree:
`gen.py --seed 1` is deterministic, so `build.sh` generates it into `dist/`.

## Sequencing

Three tickets rather than one, because the two changes fail differently and the
only end-to-end check is a person looking at the app
in a separate implementation step:

1. **T007** — the move, with the web layer
   still plain JavaScript. Pure `git mv` plus path fixes; both suites stay green;
   one thing to hand-verify: the app still loads from `dist/`.
2. **T003** — toolchain and
   contracts: `tsconfig.json`, the `typescript` dev dependency, `tsc` in
   `build.sh`, and the contract-bearing modules converted.
3. **T008** — the remaining
   modules, one slice per commit, deferred.

Folding 1 into 2 would produce a single diff in which files both moved and
changed language, and a browser-visible break in it could not be attributed to
either half.

## Open questions

- **Watch mode.** Deliberately not built yet. If the copy-and-rebuild loop
  proves annoying in daily use, the cheap answers in order are: symlink
  `index.html`/`style.css` into `dist/`, then `tsc --watch`, then a real dev
  server. None of them should arrive before the annoyance does.
- **Does `dist/` ever get committed?** Only if the repository itself becomes the
  deploy artifact (static hosting straight from the tree). Gitignored until
  then.
- **How strict, and when?** T003 raises strictness over the contracts; T008
  decides whether `strict: true` holds over all of `web/` or whether some of
  `main.js` earns an exemption. That answer belongs to the ticket that does the
  conversion, not to this document.

## Outcome

TypeScript with a real compile step, and a `src/` — `dist/` split that makes
"hand-written" and "generated" a property of the directory rather than of the
gitignore.

## Derived artifacts

- [D004](../decisions/D004-typescript-is-the-language-for-web.md) — the language
  and build-step decision, and what would reverse it.
- T007 — the layout move.
- T003 — re-grounded against
  the new layout.
- T008 — the rest of the
  conversion, deferred.
