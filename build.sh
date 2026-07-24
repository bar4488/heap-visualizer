#!/usr/bin/env bash
# Build the WASM core and stage it into web/.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --target wasm32-unknown-unknown --manifest-path core/Cargo.toml
cp core/target/wasm32-unknown-unknown/release/heap_visualizer_core.wasm web/heap_visualizer_core.wasm
ls -la web/heap_visualizer_core.wasm

echo "serve with: ./serve.py   (http.server sends no Cache-Control, so browsers cache stale js)"
