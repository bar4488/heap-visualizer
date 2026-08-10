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

Needs the wasm target: `rustup target add wasm32-unknown-unknown`.

**`./build.sh` emits two wasm modules.** `heap_visualizer_core.wasm` is the
engine, loaded by the worker. `filter_lexer.wasm` is `src/filter-dsl/` on its
own, loaded by the main thread so the filter editor can highlight
synchronously as you type — the grammar has one owner and the editor does not
wait on a message port ([T043](tickets/T043-filter-syntax-highlighting.md)).

## Run

```sh
./serve.py                                  # static server over dist/
# http://localhost:8630?trace=demo.heapl    # autoloads a trace
```

To serve the same tree **with the feature-request service** beside it
([spec/11](../spec/11-feature-requests.md),
[D010](decisions/D010-feature-requests-are-server-side.md)):

```sh
./build.sh                                       # the image builds nothing
docker compose up                                # token defaults to `admin`
HEAP_ADMIN_TOKEN=… docker compose up             # HEAP_PORT=8641 to move it
# http://localhost:8630        the app
# http://localhost:8630/admin  the requests, behind that token
```

`dist/` is bind-mounted read-only, so `./build.sh web` is still the edit loop —
no image rebuild. Requests land on the `requests` volume, so **`docker compose
down -v` deletes every request that came in** — plain `down` does not.

The token defaults to `admin` in `docker-compose.yml` alone (T048), and the
service warns on every start that it is running on it. The service itself has
no default: `python3 src/server/app.py` with nothing set serves the review
routes 503 rather than open, which is the rule a hand-run process keeps.

`build.sh` generates `dist/demo.heapl` when it is missing. For a different
trace:

```sh
python3 gen.py --seed 2 --ops 200000 --threads 8 --out dist/big.heapl
```

`window.__heap_visualizer` exposes `UI` in the console for poking at state.

## Test

```sh
cargo test --manifest-path src/core/Cargo.toml        # the engine and filter evaluation, native, no wasm
cargo test --manifest-path src/filter-dsl/Cargo.toml  # the DSL parser, completion contexts, and highlighting, native
node --test 'src/web/**/*.test.ts'                    # the web suite, no npm, no browser
node_modules/.bin/tsc -p tsconfig.test.json           # type-check everything, emit nothing
python3 -m unittest discover -s src/server            # the request service, over a real socket
```

**Counts are not written down anywhere here.** Each command prints its own, and
a number in prose is a number that goes stale between the commit that changes
it and the commit that notices — which is what
[T022](tickets/T022-docs-cite-commands-not-counts.md) was filed for.

**Invoke the compiler as `node_modules/.bin/tsc`, not `npx tsc`.** `typescript`
is a devDependency, so with `node_modules/` absent npx fetches an unrelated
package from the registry whose entire content is a message saying it is not
the compiler — and a piped `| grep -c 'error TS'` reads that as zero errors.
`./build.sh` resolves the same binary and fails with a message naming
`npm install`, so it is the safer habit. See
[T018](tickets/T018-build-resolves-local-tsc.md) and
[T021](tickets/T021-live-docs-drop-npx-tsc.md).

The three test suites run from a clean checkout with no install step — Node
strips the types itself, which is why sources import each other as `./x.ts` and
`tsc` rewrites those specifiers on the way out. The web suite runs against the
sources in `src/web/`, not against `dist/`. Type-checking is the one thing that
needs `npm install`.
`src/web/test/dom-stub.ts` is a stand-in for the DOM surface the web layer
actually touches — that is what makes the persisted round-trips testable
without a browser.

What the web suite covers is deliberately narrow: `fmt.ts` in full (`clampView`
included — it is the one function both threads run on the same input),
`normAddr`, the panel table, the filter-action source rewrites, the guide's
markdown renderer, the session round-trip, and the `.heapa` round-trip.

What it does not cover, and what no suite will: see
[Verify a web change](#verify-a-web-change).

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
node_modules/.bin/tsc -p tsconfig.test.json
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
| `src/core/` | Rust engine: parse, columnar store, state, render, timeline. Also an `rlib`, so tests run natively. |
| `src/filter-dsl/` | Dependency-free Rust crate for allocation-filter source spans, syntax trees, and parsing. |
| `src/web/protocol.ts` | The main-thread ↔ worker message contract. Types only; both sides import it. |
| `src/web/shell/` | Domain-independent: panel windows, drawers, tooltip, DOM helpers. Names no heap concept. |
| `src/web/heap/` | Heap-specific: analysis data, the panel table, events panel, address helpers. |
| `src/web/session.ts` | The boundary: serializes shell state *and* heap state into one per-trace blob. |
| `src/web/main.ts` | Trace/worker/toolbar wiring plus the three coordinated views. Owns `UIState`, the shared state every other module takes as `deps.ui`. |
| `src/web/worker.ts` | Worker side of the protocol; owns the WASM instance and OffscreenCanvas. |
| `dist/` | The served tree. Generated; not in git. |
| `src/server/` | The feature-request service: `store.py` (the JSONL), `app.py` (static tree + API), `admin.html` (the review panel). Stdlib only, and it never sees trace data. |
| `gen.py` | Synthetic `.heapl` trace generator. |

**No module imports `UI`.** Modules receive what they need via `init*(deps)`.
That is what keeps the coupling written down and the persisted shapes testable.
