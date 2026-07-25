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

if (( ! web_only )); then
  cargo build --release --target wasm32-unknown-unknown --manifest-path src/core/Cargo.toml
  cp src/core/target/wasm32-unknown-unknown/release/heap_visualizer_core.wasm dist/
fi

# The web layer has no compile step yet — T003 replaces this copy with tsc.
# A module whose source file was deleted would otherwise keep being served, so
# the copied subtrees are cleared rather than merged into.
rm -rf dist/shell dist/heap
cp src/web/index.html src/web/style.css src/web/*.js dist/
cp -R src/web/shell src/web/heap dist/

# The demo trace is generated, not stored: gen.py is deterministic, so the
# bundled demo is reproducible from a seed rather than from a file someone
# happens to have. Only when missing — it is 6.7 MB.
if [[ ! -f dist/demo.heapl ]]; then
  python3 gen.py --seed 1 --ops 50000 --threads 4 --out dist/demo.heapl
fi

ls -la dist/heap_visualizer_core.wasm

echo "serve with: ./serve.py   (http.server sends no Cache-Control, so browsers cache stale js)"
