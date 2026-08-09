#!/usr/bin/env bash
# Build everything the browser needs into dist/: the WASM core, the web layer,
# and the demo trace. dist/ is the served tree; nothing hand-written lives
# there, and nothing generated lives in src/.
#
#   ./build.sh        everything
#   ./build.sh web    skip the cargo build (the wasm rarely changes; this is
#                     the loop you use while editing the web layer)
set -euo pipefail
cd "$(dirname "$0")"

web_only=0
[[ "${1:-}" == "web" ]] && web_only=1

tsc=node_modules/.bin/tsc
if [[ ! -x "$tsc" ]]; then
  echo "error: TypeScript compiler not found; run npm install" >&2
  exit 1
fi

mkdir -p dist
rm -rf dist/shell dist/heap

if (( ! web_only )); then
  cargo build --release --target wasm32-unknown-unknown --manifest-path src/core/Cargo.toml
  cp src/core/target/wasm32-unknown-unknown/release/heap_visualizer_core.wasm dist/
  # The filter lexer ships a second time, standalone, for the main thread: the
  # editor highlights on every keystroke and the engine is behind a message
  # port. It is small because the crate has no dependencies (T043).
  cargo build --release --target wasm32-unknown-unknown --manifest-path src/filter-dsl/Cargo.toml
  cp src/filter-dsl/target/wasm32-unknown-unknown/release/heap_visualizer_filter_dsl.wasm \
    dist/filter_lexer.wasm
fi

# TypeScript -> browser ES modules. tsc is configured with noEmitOnError, so a
# type error leaves dist/ as it was rather than half-updated. The emitted tree
# is cleared first: a module whose source file was deleted would otherwise keep
# being served.
#
# The two configs check the same code; only tsconfig.test.json also covers the
# tests, which are never emitted (node runs the .ts sources directly).
"$tsc" -p tsconfig.json
"$tsc" -p tsconfig.test.json

# index.html and style.css compile to nothing, so they are copied. This is the
# one part of the loop the build step costs you: a CSS tweak needs ./build.sh web.
cp src/web/index.html src/web/style.css dist/

# Guide content is plain markdown, fetched at runtime and rendered client-side,
# so it is copied like the other non-compiling sources. Cleared first for the
# same reason the emitted tree is: a deleted section must stop being served.
rm -rf dist/guide
cp -r src/web/guide dist/guide

# The demo trace is generated, not stored: gen.py is deterministic, so the
# bundled demo is reproducible from a seed rather than from a file someone
# happens to have. Only when missing — it is 6.7 MB.
if [[ ! -f dist/demo.heapl ]]; then
  python3 gen.py --seed 1 --ops 50000 --threads 4 --out dist/demo.heapl
fi

ls -la dist/heap_visualizer_core.wasm dist/filter_lexer.wasm

echo "serve with: ./serve.py   (http.server sends no Cache-Control, so browsers cache stale js)"
