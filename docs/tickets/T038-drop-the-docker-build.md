---
id: T038
title: Drop the Docker build path
status: done
updated: 2026-08-07
---

# T038: Drop the Docker Build Path

## Outcome

The repository builds one way: `./build.sh`, against a local Rust toolchain.
`Dockerfile`, `build-docker.sh`, and `build-wasm-docker.sh` are gone, and
nothing live cites them.

Asked for by the user on 2026-08-07.

## Done when

- [x] `Dockerfile`, `build-docker.sh`, `build-wasm-docker.sh` are deleted.
- [x] `rg -i docker` outside `docs/tickets/` returns nothing.
- [x] TOOL-002 no longer offers a Docker path.
- [x] `./build.sh` still builds from a clean `dist/`.

## Non-goals

- Editing the closed [T007](T007-src-dist-layout.md), which mentions
  `build-wasm-docker.sh` as plain text.
