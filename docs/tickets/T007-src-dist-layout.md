---
id: T007
title: Sources under src/, build output under dist/
status: done
updated: 2026-07-25
---

# T007: Sources Under `src/`, Build Output Under `dist/`

## Outcome

Every hand-written file lives under `src/`, every generated file under `dist/`,
and `dist/` is the served tree. The web layer is still plain JavaScript — this
ticket moves files and fixes paths, and changes no language and no behavior.

## Context

`web/` is already a mixed source-and-output directory: `heap_visualizer_core.wasm`
and `demo.heapl` are both build products, both gitignored, both sitting among
tracked source files. Two gitignore lines quarantine outputs inside the source
tree instead of the tree stating which is which.

[T003](T003-typescript-at-the-contracts.md) adds a third build product — emitted
JS — which forces the question. Doing the move first, while the web layer is
still JavaScript, keeps the "files moved" diff separate from the "files changed
language" diff, so a break in the browser can be attributed to one of them
([D003](../decisions/D003-one-slice-per-commit.md)).

Reasoning and the alternatives weighed:
[E008](../explorations/E008-typescript-and-the-build-boundary.md).

Grounded against the tree on 2026-07-25:

- `build.sh` builds the wasm with `--manifest-path core/Cargo.toml` and copies
  it to `web/heap_visualizer_core.wasm`; `build-wasm-docker.sh` does the same
  through Docker.
- `serve.py` serves the directory `web/`.
- `web/index.html` references `style.css` and `main.js` relatively;
  `web/main.js` constructs `new Worker('worker.js')` and
  `new URL('heap_visualizer_core.wasm', location.href)`, and loads
  `demo.heapl` by relative URL. **All of these resolve against the served
  root**, so a `dist/` that mirrors today's `web/` layout keeps every one of
  them working unchanged.
- `web/test/` imports its subjects by relative path (`../session.js`), so the
  suite moves with the sources.

## Done when

- [x] `src/core/` is the Rust crate and `src/web/` is the web layer's sources
      (`index.html`, `style.css`, the JS, `test/`); no `core/` or `web/` at the
      repository root.
- [x] `./build.sh` produces a complete `dist/`: the wasm, the JS, `index.html`,
      `style.css`, and a generated `demo.heapl`. `./serve.py` serves `dist/`
      and the app loads.
- [x] `./build.sh web` skips the cargo build and refreshes only the web layer.
- [x] `.gitignore` names `dist/` and `src/core/target/`, and no build product
      is ignored inside `src/`.
- [x] `cargo test --manifest-path src/core/Cargo.toml` passes (33) and
      `node --test 'src/web/**/*.test.js'` passes (44), both from a clean
      checkout with no install step.
- [x] `README.md`, `docs/context.md`, and the spec's paths
      ([ARCH-005](../../spec/08-architecture.md#arch-005-module-layout),
      [TOOL-001](../../spec/10-tooling.md#tool-001-genpy--synthetic-trace-generator),
      [TOOL-002](../../spec/10-tooling.md#tool-002-build),
      [TOOL-003](../../spec/10-tooling.md#tool-003-tests), and the module map
      in `spec/README.md`) name the new locations.
- [x] A person confirmed on 2026-07-25 that the app still loads, renders, and
      interacts from `dist/`, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

## Non-goals

- TypeScript, `tsconfig.json`, or any change to how the JS is written. That is
  T003.
- A watch mode, a dev server, or symlinks into `dist/`. See E008's open
  questions — those arrive when the loop actually chafes.
- Updating closed explorations that name `core/` and `web/` paths. They are
  dated records.

## Work log

The move itself was `git mv` twice; every relative URL in `index.html` and
`main.js` survived untouched, because `dist/` mirrors what `web/` looked like
(`main.js`, `shell/`, `heap/`, wasm and demo at the root). That was the reason
for choosing a mirrored output layout over an emitted `js/` subdirectory: the
worker URL in `main.js` resolves against the *document*, not the module, so
`dist/js/main.js` would have silently looked for `dist/worker.js`.

`build.sh` clears `dist/shell` and `dist/heap` before copying rather than
merging into them. A module whose source file is deleted would otherwise keep
being served, which is the classic stale-output failure and worth spending two
lines to prevent.

`demo.heapl` is now generated into `dist/` rather than living in the tree —
`gen.py --seed 1` is deterministic, so the bundled demo is reproducible from a
seed instead of from a 6.7 MB file someone happened to have. It is regenerated
only when missing.

The JS suite still runs against `src/web/`, not against `dist/`. Testing the
sources keeps the "no install step" property and keeps a failure pointing at a
file you can edit.

Paths in the still-open [T001](T001-namespace-heap-session-state.md) and
[T002](T002-panel-content-as-data.md) were left as written, with one note in
each saying how to translate them. Closed artifacts were not touched at all.

## Result

```
src/core/   the Rust crate            dist/   the served tree, generated
src/web/    index.html, style.css,            wasm, js, index.html,
            the JS, test/                     style.css, demo.heapl
```

`./build.sh` builds all of `dist/`; `./build.sh web` skips cargo and takes
about a second. `./serve.py` serves `dist/`. `.gitignore` is `dist/` and
`src/core/target/` — no build product is ignored inside `src/` any more.

From a clean checkout: `cargo test --manifest-path src/core/Cargo.toml` is 33,
`node --test 'src/web/**/*.test.js'` is 44, neither needs an install step. A
freshly built `dist/` serves 200s for `/`, `main.js`, `worker.js`,
`shell/panels.js`, `heap/panels.js`, the wasm, `style.css`, and `demo.heapl`.

## Hand verification

The code was done, both suites pass, and the served tree answers every request
it should. The last done-when item was a person's, per D001 — an agent checking HTTP
status codes is not the same as the app rendering.

```sh
./build.sh && ./serve.py     # http://localhost:8630?trace=demo.heapl
```

What was looked at: the map renders, the two timelines render, stepping and
playback work, panels open and dock, and the demo trace loads from the toolbar
button. Nothing about the app should have changed — that is the whole claim.

Checked on 2026-07-25; nothing came back.
