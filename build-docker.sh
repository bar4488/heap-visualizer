#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

image=heap-visualizer-wasm-builder:latest
archive=images/heap-visualizer-wasm-builder.tar

mkdir -p images
docker build --tag "$image" .
docker save --output "$archive" "$image"

ls -lh "$archive"
