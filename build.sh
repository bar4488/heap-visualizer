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

mkdir -p dist
rm -rf dist/shell dist/heap

if (( ! web_only )); then
  cargo build --release --target wasm32-unknown-unknown --manifest-path src/core/Cargo.toml
  cp src/core/target/wasm32-unknown-unknown/release/heap_visualizer_core.wasm dist/
fi

# TypeScript -> browser ES modules. tsc is configured with noEmitOnError, so a
# type error leaves dist/ as it was rather than half-updated. The emitted tree
# is cleared first: a module whose source file was deleted would otherwise keep
# being served.
#
# The two configs check the same code; only tsconfig.test.json also covers the
# tests, which are never emitted (node runs the .ts sources directly).
npx tsc -p tsconfig.json
npx tsc -p tsconfig.test.json

# index.html and style.css compile to nothing, so they are copied. This is the
# one part of the loop the build step costs you: a CSS tweak needs ./build.sh web.
cp src/web/index.html src/web/style.css dist/

# The demo trace is generated, not stored: gen.py is deterministic, so the
# bundled demo is reproducible from a seed rather than from a file someone
# happens to have. Only when missing — it is 6.7 MB.
if [[ ! -f dist/demo.heapl ]]; then
  python3 gen.py --seed 1 --ops 50000 --threads 4 --out dist/demo.heapl
fi

ls -la dist/heap_visualizer_core.wasm

echo "serve with: ./serve.py   (http.server sends no Cache-Control, so browsers cache stale js)"
