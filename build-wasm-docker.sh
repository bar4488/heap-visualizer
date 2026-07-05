#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

image=heap-visualizer-wasm-builder:latest

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work" \
  "$image" \
  cargo build --release --target wasm32-unknown-unknown \
    --manifest-path core/Cargo.toml

cp core/target/wasm32-unknown-unknown/release/heap_visualizer_core.wasm \
  web/heap_visualizer_core.wasm

ls -lh web/heap_visualizer_core.wasm
