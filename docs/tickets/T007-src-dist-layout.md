---
id: T007
title: Sources under src/, build output under dist/
status: todo
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

- [ ] `src/core/` is the Rust crate and `src/web/` is the web layer's sources
      (`index.html`, `style.css`, the JS, `test/`); no `core/` or `web/` at the
      repository root.
- [ ] `./build.sh` produces a complete `dist/`: the wasm, the JS, `index.html`,
      `style.css`, and a generated `demo.heapl`. `./serve.py` serves `dist/`
      and the app loads.
- [ ] `./build.sh web` skips the cargo build and refreshes only the web layer.
- [ ] `.gitignore` names `dist/` and `src/core/target/`, and no build product
      is ignored inside `src/`.
- [ ] `cargo test --manifest-path src/core/Cargo.toml` passes (33) and
      `node --test 'src/web/**/*.test.js'` passes (44), both from a clean
      checkout with no install step.
- [ ] `README.md`, `docs/context.md`, and the spec's paths
      ([ARCH-005](../../spec/08-architecture.md#arch-005-module-layout),
      [TOOL-001](../../spec/10-tooling.md#tool-001-genpy--synthetic-trace-generator),
      [TOOL-002](../../spec/10-tooling.md#tool-002-build),
      [TOOL-003](../../spec/10-tooling.md#tool-003-tests), and the module map
      in `spec/README.md`) name the new locations.
- [ ] A person confirms the app still loads, renders, and interacts from
      `dist/`, per [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

## Non-goals

- TypeScript, `tsconfig.json`, or any change to how the JS is written. That is
  T003.
- A watch mode, a dev server, or symlinks into `dist/`. See E008's open
  questions — those arrive when the loop actually chafes.
- Updating closed explorations that name `core/` and `web/` paths. They are
  dated records.
