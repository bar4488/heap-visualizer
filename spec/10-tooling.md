# 10 — Tooling: Generator, Build, Tests

## TOOL-001: `gen.py` — synthetic trace generator

A stdlib-only Python script that emits a spec-conformant `.heapl` stream, used
for the bundled demo and for exercising the viewer at any scale.

Design decisions that matter:

- **Deterministic**: identical `--seed` and args produce byte-identical
  output — demo traces are reproducible and diffs are meaningful.
- **It simulates an allocator, not just events**: a best-fit free-list over
  coalesced blocks with a bump-pointer arena, so addresses show realistic
  reuse, holes, and growth — the address map looks like a real heap rather
  than a monotonic ramp.
- **Workload = weighted allocation sites**, each with a characteristic
  log-uniform size range, lifetime range, and leak bias (e.g. short-lived
  `temp_string`, leak-prone `cache_entry`, immortal `global_singleton`). This
  produces the site/size/age structure the color modes are built to reveal.
- **Same-timestamp bursts** are injected on purpose so the temporal and
  sequential timelines visibly diverge.
- Frees are scheduled by lifetime and drained in time order; reallocs pick a
  live allocation and grow/shrink it; a configurable fraction of allocations
  leak. Remaining live allocations at the end are the intended "leaked at
  exit" picture.

Knobs: `--seed --ops --threads --mean-gap --burst-prob --leak-rate
--realloc-rate --arena-base --row-bytes --unit --out`. A summary (event
counts, leaks, peak live, address span) prints to stderr.

## TOOL-002: Build

- `build.sh` — the whole build. It produces `dist/`, the served tree: the wasm
  from `cargo build --release --target wasm32-unknown-unknown`, the compiled
  web layer, `index.html`/`style.css`, and a generated demo trace.
  `./build.sh web` skips the cargo build.
- **Hand-written files live under `src/`, generated files under `dist/`, and
  nothing crosses.** `dist/` is not in version control; a clean checkout is not
  servable until `build.sh` has run.
- The release profile is tuned for the shipped artifact: fat LTO, one codegen
  unit, `panic = "abort"`, stripped.
- **The web layer is TypeScript, compiled by `tsc` into browser ES modules with
  source maps.** A type error must not produce output: `noEmitOnError` keeps a
  failed build from leaving a half-updated `dist/` that still loads.
- What must *not* appear: a bundler, a framework, or any npm package in what
  ships. `typescript` and `@types/node` are dev dependencies, and are the only
  ones. The runtime stays native HTML, CSS, ES modules, Web Workers,
  `OffscreenCanvas`, and WASM.
- This replaces an earlier zero-toolchain stance ("no bundler, no npm",
  "`web/` is served as-is"), traded for checked contracts across the
  main-thread/worker boundary. The reasoning, and what would reverse it, is
  [D004](../docs/decisions/D004-typescript-is-the-language-for-web.md).
- `build-docker.sh` / `build-wasm-docker.sh` — build (and export) a Rust
  image with the wasm target preinstalled, then build the wasm inside it: a
  reproducible path that needs no local Rust toolchain.
- Serve: `./serve.py` over `dist/` (any static server works;
  `?trace=demo.heapl` autoloads).

## TOOL-003: Tests

`cargo test` in `src/core/` runs the engine test suite **natively** (no wasm, no
browser) — the reason the crate is also an `rlib` and the C-ABI layer stays
thin. Coverage tracks the specs: parsing and chunk-boundary carry, warning
flagging, live-set seeks (including snapshot seeks verified against fresh
replays), t↔seq mapping, collapse thresholds, scroll anchoring, pins,
show-all layout, tagging (range, by-free, filter-scoped), filter semantics
(including empty-selection constraints), crop invariants, x-zoom picking,
label placement, move links, timeline tag lanes, and render smoke tests over
the raw pixel buffer.

`node --test 'src/web/**/*.test.ts'` runs the JS suite, against the sources
rather than `dist/`. Node strips the types itself, so the tests run with no
build step and no npm install; that is why source files import each other as
`./x.ts` and `tsc` rewrites those specifiers on the way out. The suite needs no
browser either:
`src/web/test/dom-stub.ts` is a ~200-line stand-in implementing only the DOM
surface the web layer actually touches. Coverage is deliberately narrow
and aimed at what a refactor breaks silently:

- `fmt.js` in full, `clampView` included — it is the one function both
  threads run on the same input, so the main thread's optimistic local zoom
  agreeing with the worker's authoritative clamp rests on it;
- `normAddr` (`heap/addr.js`), and the panel table (`heap/panels.js`);
- the **session round-trip** — `buildSession → applySession → buildSession`
  must be a fixed point, plus drawer docking, address-range validation and
  playhead restore;
- the **`.heapa` round-trip** — `buildMarks → applyMarks → buildMarks`, plus
  the validation `applyMarks` does on a file off disk (tag color fallback,
  address-mark and per-allocation-color rejection, trace-count mismatch).

This replaces an earlier stance that the JS layers would carry no automated
tests at all. That held while `main.ts` was one flat scope with nothing
importable; it stopped holding once the shell/domain split made the persisted
shapes testable in isolation, and the split itself needed something to lean on.

Type-checking is part of the build, and covers what the tests do not: the
message protocol between the main thread and the worker, the two persisted
shapes, and the panel table. A message name that exists on one side and not the
other fails the build.

Rendering, pointer interaction and the real worker round trip are still
verified by hand — against `dist/`, after a build — and there is no fixed
script.
`window.__heap_visualizer` exposes UI state for console poking.
