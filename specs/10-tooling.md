# 10 — Tooling: Generator, Build, Tests

## 10.1 `gen.py` — synthetic trace generator

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

## 10.2 Build

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

## 10.3 Tests

`cargo test` in `core/` runs the engine test suite **natively** (no wasm, no
browser) — the reason the crate is also an `rlib` and the C-ABI layer stays
thin. Coverage tracks the specs: parsing and chunk-boundary carry, warning
flagging, live-set seeks (including snapshot seeks verified against fresh
replays), t↔seq mapping, collapse thresholds, scroll anchoring, pins,
show-all layout, tagging (range, by-free, filter-scoped), filter semantics
(including empty-selection constraints), crop invariants, x-zoom picking,
label placement, move links, timeline tag lanes, and render smoke tests over
the raw pixel buffer.

The JS layers have no automated tests; they are kept thin enough to verify by
manual smoke test with the demo trace (`window.__heap_visualizer` exposes UI
state for console poking).
