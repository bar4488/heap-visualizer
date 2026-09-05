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
wait on a message port.

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

### Release the local companion

Pushing a `vX.Y.Z` tag builds `heapviz` for Windows and Linux and publishes
`heapviz-self-hosted.tar.gz` and `.zip`. Each archive is a complete static
deployment: the web app, installers, both binaries, checksums, and
`downloads/heapviz-channel.json`. GitHub performs the build but is not in the
end-user install or update path after that archive is deployed elsewhere.

A local full build creates the same layout with the current Linux binary:

```sh
./build.sh
./serve.py
# use the Linux install command shown by http://localhost:8630
```

The installer records that deployment's
`downloads/heapviz-channel.json` endpoint. `heapviz update` uses only that
self-hosted endpoint and same-origin relative downloads. The channel contains
no web-application URL or web compatibility policy.

`heapviz setup opencode` installs the bundled skill under
`~/.config/opencode/skills/`; `heapviz setup claude` installs it under
`~/.claude/skills/`. Both are personal, cross-project installations. `doctor`
reports each assistant and skill independently.

Each deployment sets its compatibility floor through the
`heapviz-minimum-version` meta value in `src/web/index.html` (or by replacing
that value in its generated `dist/index.html`). Raise it only when that hosted
web build intentionally requires a newer companion.

### Prove the local-companion connection

The local companion serves only its API; the web app and feature-request service
remain hosted independently. With the development site on its usual port:

```sh
cargo run --manifest-path src/local-server/Cargo.toml --bin heapviz -- \
  open trace.heapl
# paste the connection it prints into Connect… on the hosted workspace
```

Canonical analysis is stored by trace digest under
`$XDG_DATA_HOME/heap-visualizer` (or `~/.local/share/heap-visualizer`). Override
that location with `--data-dir PATH`.

The connection badge is in the status bar. Chromium asks for its Apps on
device / Local Network Access permission on first contact. `heapviz` prints a
deployment-neutral loopback address and temporary capability; it does not know
which hosted site consumes them. The app retains those in that tab's session
storage; an ordinary visit makes no local request. The same control
reads **Disconnect** while configured and discards only that tab's capability.
The server snapshots and identifies the trace before listening; once connected,
the web app streams it in bounded chunks into the same local WASM renderer used
for directly opened traces.

Agents use the same bearer capability. Semantic list endpoints are explicitly
bounded, for example:

```sh
curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/session'

curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/overview?top=10'

curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/events?from=0&count=100'

curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/allocations/42'

curl -H "Authorization: Bearer $CAPABILITY" \
  -H 'Content-Type: application/json' \
  --data '{"traceId":"sha256:…","source":"alloc.size >= 4096","from":0,"count":100}' \
  'http://127.0.0.1:8631/api/v1/query'

# Compact, cursor-paged matches. Use nextCursor from the response for the next page.
curl -H "Authorization: Bearer $CAPABILITY" \
  -H 'Content-Type: application/json' \
  --data '{"traceId":"sha256:…","filter":{"source":"alloc.size >= 4096"},"orderBy":"size-desc","limit":20}' \
  'http://127.0.0.1:8631/api/v1/allocations/query'

curl -H "Authorization: Bearer $CAPABILITY" \
  -H 'Content-Type: application/json' \
  --data '{"traceId":"sha256:…","filter":{"source":"not alloc.freed"},"groupBy":"site","limit":20}' \
  'http://127.0.0.1:8631/api/v1/allocations/summarize'

curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/analysis'

curl -H "Authorization: Bearer $CAPABILITY" \
  'http://127.0.0.1:8631/api/v1/changes?after=0&wait=25'

curl -H "Authorization: Bearer $CAPABILITY" \
  -H 'Content-Type: application/json' \
  --data '{"traceId":"sha256:…","expectedRevision":0,"requestId":"name-request-root-1","change":{"type":"setAllocationName","creator":42,"name":"request root"}}' \
  'http://127.0.0.1:8631/api/v1/analysis/changes'
```

The discoverable endpoint/limit catalog is in `/api/v1/session`; the complete
wire contract and recommended workflow are in
[spec/12-agent-api](../spec/12-agent-api.md).

## Test

```sh
cargo test --manifest-path src/core/Cargo.toml        # the engine and filter evaluation, native, no wasm
cargo test --manifest-path src/filter-dsl/Cargo.toml  # the DSL parser, completion contexts, and highlighting, native
node --test 'src/web/**/*.test.ts'                    # the web suite, no npm, no browser
node_modules/.bin/tsc -p tsconfig.test.json           # type-check everything, emit nothing
python3 -m unittest discover -s src/server            # the request service, over a real socket
cargo test --manifest-path src/local-server/Cargo.toml # the local data-server transport
```

Each command prints its own test count; do not maintain duplicate counts here.

**Invoke the compiler as `node_modules/.bin/tsc`, not `npx tsc`.** `typescript`
is a devDependency, so with `node_modules/` absent npx fetches an unrelated
package from the registry whose entire content is a message saying it is not
the compiler — and a piped `| grep -c 'error TS'` reads that as zero errors.
`./build.sh` resolves the same binary and fails with a message naming
`npm install`, so it is the safer habit.

The Rust, Node and Python suites run from a clean checkout with no project
install step — Node
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
covered by either suite. Run the available checks and say precisely what they
did and did not establish.

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

If a change carries a risk only a person's eye can retire, state that limitation
in the final result rather than blocking otherwise verified work.

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
