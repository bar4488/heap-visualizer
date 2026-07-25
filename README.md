# heap-visualizer

Heap allocation visualizer: renders a `.heapl` (JSONL) stream of
malloc/free/realloc events on an address-line map with two coordinated
timelines (temporal and sequential) and full time-travel.

Parsing, seeking, and rasterization happen in a Rust - WebAssembly core
running in a Web Worker with OffscreenCanvas; the page stays fully
client-side.

Supports analyzing heap-traces, tagging, and naming allocations, marking timestamps and addresses - and saving analysis into a `.heapa` file for later work.

![Heap visualizer showing coordinated time and event timelines above the address map](docs/images/heap-visualizer-overview.png)

![Heap visualizer analysis - address / time marks, tags, timelaps](docs/images/heap-visualizer-analysis.png)

## Build & run

```sh
npm install                    # typescript, dev-only (nothing ships from npm)
./build.sh                     # everything the browser needs, into dist/: the wasm
                               # (needs the wasm32-unknown-unknown target: rustup
                               # target add wasm32-unknown-unknown), the compiled
                               # web layer, and a generated demo trace
./build.sh web                 # skip cargo; recompile only the web layer
./serve.py                     # static server over dist/
# open http://localhost:8630  (or ...?trace=demo.heapl to autoload)
```

`dist/` is a build product and is gitignored: everything hand-written lives
under `src/`, everything generated under `dist/`. The web layer is TypeScript
compiled to plain browser ES modules — no bundler, no framework, no npm
packages at runtime.

To build and export a reusable Rust image with the WASM target preinstalled:

```sh
./build-docker.sh             # images/heap-visualizer-wasm-builder.tar
docker run --rm -v "$PWD:/work" heap-visualizer-wasm-builder \
  cargo build --release --target wasm32-unknown-unknown \
  --manifest-path src/core/Cargo.toml
```

Once the builder image is available, build and stage the project WASM with:

```sh
./build-wasm-docker.sh         # dist/heap_visualizer_core.wasm
```

Drop any `.heapl` file onto the page to load it.

## Analysis workflow

- **Shift-drag** a range on either timeline to select it, then **Zoom** into it
  or **Tag** every allocation created in it. With a filter active, only
  allocations the filter matches get tagged — the filter defines the working
  set.
- Click an allocation to open its panel: give it a **name**, a **tag**, or a
  **highlight color** (shown in every color mode), or replace the active filter
  with that allocation's address range.
- In site, thread, and tag color modes, click a legend chip to toggle its
  visible filter predicate (Shift-click uses OR). The Filter panel can save
  named expressions with the analysis and snapshot all current matches into a
  tag without removing their existing tags.
- **＋ mark** (or `m`) bookmarks the current playhead position; time marks show
  as flags on both timelines. Clicking one jumps in time while the address
  view stays put; the ⌖ button (or shift+click on the flag) also centers
  where the event happened.
- **Shift-click** the address map to drop an **address mark** — a named
  horizontal flag line; click it (or its Analysis-panel entry) to center that
  address at any playhead. `g` focuses the jump box, which accepts a seq,
  `t:` time, or `0x…` address.
- Allocations can belong to several tags; their allocation panel edits the
  comma-separated membership set.
- The **Analysis** panel lists bookmarks, tags (recolor, rename, delete) and
  named allocations, and **saves/loads** the whole thing
  as a `.heapa.json` file — dropping one onto the page restores the analysis.
- The **collapse ≥** box controls empty-row collapsing: a plain number is a
  run length in rows (e.g. `5`), a byte size (`64k`, `0x10000`) is empty
  address space — byte thresholds adapt when the row width changes.
- Color modes: live, site, thread, size (log ramp), age (log-normalized vs
  the oldest live allocation), tag. Tagged allocations keep a colored stripe
  in every mode; overlapping tags split it into color segments, and both
  timelines carry a tag lane along the bottom.

## Tests

```sh
cargo test --manifest-path src/core/Cargo.toml   # engine, native, no wasm
cargo test --manifest-path src/filter-dsl/Cargo.toml # DSL parser, native
node --test 'src/web/**/*.test.ts'               # web layer, no npm, no browser
```

```sh
npx tsc -p tsconfig.test.json                    # type-check everything, emit nothing
```

Rendering and pointer interaction have no automated coverage and are not going
to get any; what is checked instead, and how, is
[docs/decisions/D001](docs/decisions/D001-web-changes-are-hand-smoke-tested.md).

## Layout

- `src/core/` — Rust WASM engine (JSONL parser, columnar store, snapshot seeks,
  address-line raster, timeline binning). Plain C ABI, no wasm-bindgen.
- `src/filter-dsl/` — dependency-free Rust crate for the allocation filter
  language. It owns source spans, syntax trees, and parsing independently of
  the engine.
- `src/web/` — the viewer's sources (TypeScript): `worker.ts` owns the WASM +
  canvases, `main.ts` is DOM chrome and input, `protocol.ts` is the message
  contract between them, `shell/` is the domain-independent window/drawer layer
  and `heap/` is everything that knows what an allocation is.
- `dist/` — what is actually served. Generated by `./build.sh`; not in git.
- `gen.py` — deterministic synthetic trace generator.
- `spec/` — the specification, split into modules (start at
  [spec/README.md](spec/README.md)).
- `docs/` — how work is done here. Start at [docs/now.md](docs/now.md).
