# Context: how to run, test, and verify

Everything an agent or a new contributor needs to make the thing go. Behavior
belongs in [spec/](../spec/README.md); this file is operational.

## Build

```sh
npm install         # typescript + @types/node, dev-only, once
./build.sh          # everything into dist/: the wasm, the compiled web layer,
                    # and a generated demo trace
./build.sh web      # skip the cargo build; recompile only the web layer
```

**`dist/` is the served tree and is entirely generated.** Hand-written files
live under `src/`, build products under `dist/`, and nothing crosses. The web
layer is TypeScript; `tsc` emits browser ES modules with source maps, and
refuses to emit at all if anything fails to type-check.

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
node --test 'src/web/**/*.test.ts'               # 44 web tests, no npm, no browser
npx tsc -p tsconfig.test.json                    # type-check everything, emit nothing
```

The two test suites run from a clean checkout with no install step — Node
strips the types itself, which is why sources import each other as `./x.ts` and
`tsc` rewrites those specifiers on the way out. The web suite runs against the
sources in `src/web/`, not against `dist/`. Type-checking is the one thing that
needs `npm install`.
`src/web/test/dom-stub.ts` is a ~200-line stand-in for the DOM surface the web
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
| `src/web/protocol.ts` | The main-thread ↔ worker message contract. Types only; both sides import it. |
| `src/web/shell/` | Domain-independent: panel windows, drawers, tooltip, DOM helpers. Names no heap concept. |
| `src/web/heap/` | Heap-specific: analysis data, the panel table, events panel, address helpers. |
| `src/web/session.ts` | The boundary: serializes shell state *and* heap state into one per-trace blob. |
| `src/web/main.js` | Trace/worker/toolbar wiring plus the three coordinated views. The last `.js` file — T008 converts it. |
| `src/web/worker.ts` | Worker side of the protocol; owns the WASM instance and OffscreenCanvas. |
| `dist/` | The served tree. Generated; not in git. |
| `gen.py` | Synthetic `.heapl` trace generator. |

**No module imports `UI`.** Modules receive what they need via `init*(deps)`.
That is what keeps the coupling written down and the persisted shapes testable.
