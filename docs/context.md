# Context: how to run, test, and verify

Everything an agent or a new contributor needs to make the thing go. Behavior
belongs in [spec/](../spec/README.md); this file is operational.

## Build

```sh
./build.sh          # cargo build --release --target wasm32-unknown-unknown,
                    # then copies the .wasm into web/
```

That is the whole build. There is no JS build step — `web/` is served as-is.
Needs the wasm target: `rustup target add wasm32-unknown-unknown`.

No local Rust toolchain? `./build-docker.sh` builds and exports a builder image
with the target preinstalled; `./build-wasm-docker.sh` then builds the wasm
inside it.

## Run

```sh
./serve.py                                  # static server over web/
# http://localhost:8630?trace=demo.heapl    # autoloads a trace
```

Generate a trace:

```sh
python3 gen.py --seed 1 --ops 50000 --threads 4 --out web/demo.heapl
```

`window.__heap_visualizer` exposes `UI` in the console for poking at state.

## Test

```sh
cargo test --manifest-path core/Cargo.toml   # 33 engine tests, native, no wasm
node --test 'web/**/*.test.js'               # 39 JS tests, no npm, no browser
```

Both run from a clean checkout with no install step. `web/test/dom-stub.js` is a
~200-line stand-in for the DOM surface `web/` actually touches — that is what
makes the persisted round-trips testable without a browser.

What the JS suite covers is deliberately narrow: `web/fmt.js` in full
(`clampView` included — it is the one function both threads run on the same
input), `normAddr`, the session round-trip, and the `.heapa` round-trip.

## Verify a web change

Rendering, pointer interaction, and the real worker round trip are **not**
covered by either suite. They are hand-verified by a person, per
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md). An agent runs the
two suites and `./build.sh`, then hands back a plain-language list of what the
change touches for a person to check against the demo trace.

## Layout

| Where | What |
|---|---|
| `core/` | Rust engine, ~4.9k lines: parse, columnar store, state, render, timeline. Also an `rlib`, so tests run natively. |
| `web/shell/` | Domain-independent: panel windows, drawers, tooltip, DOM helpers. Names no heap concept. |
| `web/heap/` | Heap-specific: analysis data, events panel, address helpers. |
| `web/session.js` | The boundary: serializes shell state *and* heap state into one per-trace blob. |
| `web/main.js` | Trace/worker/toolbar wiring plus the three coordinated views. |
| `web/worker.js` | Worker side of the protocol; owns the WASM instance and OffscreenCanvas. |
| `gen.py` | Synthetic `.heapl` trace generator. |

**No module imports `UI`.** Modules receive what they need via `init*(deps)`.
That is what keeps the coupling written down and the persisted shapes testable.
