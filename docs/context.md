# Context: how to run, test, and verify

Everything an agent or a new contributor needs to make the thing go. Behavior
belongs in [spec/](../spec/README.md); this file is operational.

## Build

```sh
./build.sh          # everything into dist/: the wasm, the web layer, and a
                    # generated demo trace
./build.sh web      # skip the cargo build; refresh only the web layer
```

**`dist/` is the served tree and is entirely generated.** Hand-written files
live under `src/`, build products under `dist/`, and nothing crosses. The web
layer has no compile step yet — `build.sh` copies it — which is what
[T003](tickets/T003-typescript-at-the-contracts.md) changes.

Needs the wasm target: `rustup target add wasm32-unknown-unknown`. No local
Rust toolchain? `./build-docker.sh` builds and exports a builder image with the
target preinstalled; `./build-wasm-docker.sh` then builds the wasm inside it.

## Run

```sh
./serve.py                                  # static server over dist/
# http://localhost:8630?trace=demo.heapl    # autoloads a trace
```

`build.sh` generates `dist/demo.heapl` when it is missing. For a different
trace:

```sh
python3 gen.py --seed 2 --ops 200000 --threads 8 --out dist/big.heapl
```

`window.__heap_visualizer` exposes `UI` in the console for poking at state.

## Test

```sh
cargo test --manifest-path src/core/Cargo.toml   # 33 engine tests, native, no wasm
node --test 'src/web/**/*.test.js'               # 44 JS tests, no npm, no browser
```

Both run from a clean checkout with no install step, and the JS suite runs
against the sources in `src/web/`, not against `dist/`.
`src/web/test/dom-stub.js` is a ~200-line stand-in for the DOM surface the web
layer actually touches — that is what makes the persisted round-trips testable
without a browser.

What the JS suite covers is deliberately narrow: `fmt.js` in full (`clampView`
included — it is the one function both threads run on the same input),
`normAddr`, the panel table, the session round-trip, and the `.heapa`
round-trip.

## Verify a web change

Rendering, pointer interaction, and the real worker round trip are **not**
covered by either suite. They are hand-verified by a person, per
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md). An agent runs the
two suites and `./build.sh`, then hands back a plain-language list of what the
change touches for a person to check against the demo trace. Check it against
`dist/`, after a build — the served tree is a build product now, and a stale
one is the new way to be confused.

## Layout

| Where | What |
|---|---|
| `src/core/` | Rust engine, ~4.9k lines: parse, columnar store, state, render, timeline. Also an `rlib`, so tests run natively. |
| `src/web/shell/` | Domain-independent: panel windows, drawers, tooltip, DOM helpers. Names no heap concept. |
| `src/web/heap/` | Heap-specific: analysis data, the panel table, events panel, address helpers. |
| `src/web/session.js` | The boundary: serializes shell state *and* heap state into one per-trace blob. |
| `src/web/main.js` | Trace/worker/toolbar wiring plus the three coordinated views. |
| `src/web/worker.js` | Worker side of the protocol; owns the WASM instance and OffscreenCanvas. |
| `dist/` | The served tree. Generated; not in git. |
| `gen.py` | Synthetic `.heapl` trace generator. |

**No module imports `UI`.** Modules receive what they need via `init*(deps)`.
That is what keeps the coupling written down and the persisted shapes testable.
