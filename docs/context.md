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
cargo test --manifest-path src/filter-dsl/Cargo.toml # filter DSL parser, native
node --test 'src/web/**/*.test.ts'               # 44 web tests, no npm, no browser
npx tsc -p tsconfig.test.json                    # type-check everything, emit nothing
```

The three test suites run from a clean checkout with no install step — Node
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
covered by either suite, and no harness is going to cover them
([D001](decisions/D001-web-changes-are-hand-smoke-tested.md),
[E009](explorations/E009-the-hand-verification-bottleneck.md)). What that
leaves is: run everything cheap, and say precisely what it did and did not
establish.

```sh
cargo test --manifest-path src/core/Cargo.toml
cargo test --manifest-path src/filter-dsl/Cargo.toml
node --test 'src/web/**/*.test.ts'
npx tsc -p tsconfig.test.json
./build.sh web
./serve.py &     # then: curl -s -o /dev/null -w '%{http_code}\n' localhost:8630/main.js
```

For a change meant to preserve behavior — a translation, a rename, a config
change — **diff the emitted tree.** It is the strongest cheap evidence
available, and an unexpected line in the diff is the whole list of things to
look at:

```sh
cp -r dist /tmp/dist-before && ./build.sh web && diff -r --exclude='*.map' /tmp/dist-before dist
```

HTTP 200 means the file exists, not that the page works. Everything is checked
against `dist/` after a build — the served tree is a build product, and a stale
one is the new way to be confused.

**A person's pass is not a gate on closing a ticket.** If a change carries a
risk only an eye can retire, name it in the ticket and in
[now](now.md) and close.

## Layout

| Where | What |
|---|---|
| `src/core/` | Rust engine, ~4.9k lines: parse, columnar store, state, render, timeline. Also an `rlib`, so tests run natively. |
| `src/filter-dsl/` | Dependency-free Rust crate for allocation-filter source spans, syntax trees, and parsing. |
| `src/web/protocol.ts` | The main-thread ↔ worker message contract. Types only; both sides import it. |
| `src/web/shell/` | Domain-independent: panel windows, drawers, tooltip, DOM helpers. Names no heap concept. |
| `src/web/heap/` | Heap-specific: analysis data, the panel table, events panel, address helpers. |
| `src/web/session.ts` | The boundary: serializes shell state *and* heap state into one per-trace blob. |
| `src/web/main.ts` | Trace/worker/toolbar wiring plus the three coordinated views. Owns `UIState`, the shared state every other module takes as `deps.ui`. |
| `src/web/worker.ts` | Worker side of the protocol; owns the WASM instance and OffscreenCanvas. |
| `dist/` | The served tree. Generated; not in git. |
| `gen.py` | Synthetic `.heapl` trace generator. |

**No module imports `UI`.** Modules receive what they need via `init*(deps)`.
That is what keeps the coupling written down and the persisted shapes testable.
