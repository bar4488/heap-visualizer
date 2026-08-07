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

```sh
rustup target add wasm32-unknown-unknown
npm install
./build.sh
./build.sh web   # skips cargo
```

## Run

```sh
./serve.py
```

## Test

```sh
cargo test --manifest-path src/core/Cargo.toml
cargo test --manifest-path src/filter-dsl/Cargo.toml
node --test 'src/web/**/*.test.ts'
node_modules/.bin/tsc -p tsconfig.test.json
```

## Where things are

The specification is [spec/](spec/README.md). How work is done here is
[docs/now.md](docs/now.md).
