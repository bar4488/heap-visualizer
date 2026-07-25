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

- `build.sh` — the whole build: `cargo build --release --target
  wasm32-unknown-unknown` and copy the `.wasm` into `web/`. There is no JS
  build step at all — `web/` is served as-is (an intentional
  zero-toolchain stance: no bundler, no npm).
- The release profile is tuned for the shipped artifact: fat LTO, one
  codegen unit, `panic = "abort"`, stripped.
- `build-docker.sh` / `build-wasm-docker.sh` — build (and export) a Rust
  image with the wasm target preinstalled, then build the wasm inside it: a
  reproducible path that needs no local Rust toolchain.
- Serve: `python3 -m http.server -d web` (any static server works;
  `?trace=demo.heapl` autoloads).

## TOOL-003: Tests

`cargo test` in `core/` runs the engine test suite **natively** (no wasm, no
browser) — the reason the crate is also an `rlib` and the C-ABI layer stays
thin. Coverage tracks the specs: parsing and chunk-boundary carry, warning
flagging, live-set seeks (including snapshot seeks verified against fresh
replays), t↔seq mapping, collapse thresholds, scroll anchoring, pins,
show-all layout, tagging (range, by-free, filter-scoped), filter semantics
(including empty-selection constraints), crop invariants, x-zoom picking,
label placement, move links, timeline tag lanes, and render smoke tests over
the raw pixel buffer.

`node --test 'web/**/*.test.js'` runs the JS suite. It needs no npm packages
and no browser: `web/test/dom-stub.js` is a ~200-line stand-in implementing
only the DOM surface `web/` actually touches. Coverage is deliberately narrow
and aimed at what a refactor breaks silently:

- `web/fmt.js` in full, `clampView` included — it is the one function both
  threads run on the same input, so the main thread's optimistic local zoom
  agreeing with the worker's authoritative clamp rests on it;
- `normAddr` (`web/heap/addr.js`);
- the **session round-trip** — `buildSession → applySession → buildSession`
  must be a fixed point, plus drawer docking, address-range validation and
  playhead restore;
- the **`.heapa` round-trip** — `buildMarks → applyMarks → buildMarks`, plus
  the validation `applyMarks` does on a file off disk (tag color fallback,
  address-mark and per-allocation-color rejection, trace-count mismatch).

This replaces an earlier stance that the JS layers would carry no automated
tests at all. That held while `main.js` was one flat scope with nothing
importable; it stopped holding once the shell/domain split made the persisted
shapes testable in isolation, and the split itself needed something to lean on.

Rendering, pointer interaction and the real worker round trip are still
verified by hand against the demo trace; there is no fixed script.
`window.__heap_visualizer` exposes UI state for console poking.
