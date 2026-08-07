# heap-visualizer

Heap allocation visualizer: renders a `.heapl` (JSONL) stream of
malloc/free/realloc events on an address-line map with two coordinated
timelines (temporal and sequential) and full time-travel.

Parsing, seeking, and rasterization happen in a Rust → WebAssembly core running
in a Web Worker with OffscreenCanvas; the page stays fully client-side.

Tag and name allocations, mark timestamps and addresses, filter the heap with
an expression language, and save the whole analysis to a `.heapa` file for
later.

![Heap visualizer showing coordinated time and event timelines above the address map](docs/images/heap-visualizer-overview.png)

![Heap visualizer analysis - address / time marks, tags, timelaps](docs/images/heap-visualizer-analysis.png)

## Build

Needs a Rust toolchain with `rustup target add wasm32-unknown-unknown`, Python
3, and Node.

```sh
npm install
./build.sh
./build.sh web
```

`./build.sh web` skips cargo. `dist/` is generated and gitignored; nothing
ships from npm.

## Run

```sh
./serve.py
```

Open http://localhost:8630, or `?trace=demo.heapl` to autoload the generated
demo. Drop any `.heapl` or `.heapa.json` file onto the page to load it.

The **Guide** button in the toolbar opens the built-in guide, with scenario
traces to try each feature on.

## Test

```sh
cargo test --manifest-path src/core/Cargo.toml
cargo test --manifest-path src/filter-dsl/Cargo.toml
node --test 'src/web/**/*.test.ts'
node_modules/.bin/tsc -p tsconfig.test.json
```

None of it needs a browser. Rendering and pointer interaction have no automated
coverage and are not going to get any; what is checked instead, and how, is
[docs/decisions/D001](docs/decisions/D001-web-changes-are-hand-smoke-tested.md).

## Where things are

The specification is [spec/](spec/README.md). How work is done here is
[docs/now.md](docs/now.md).
