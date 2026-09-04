---
id: T054
title: The server starts with one trace
status: done
updated: 2026-09-05
---

# T054: The Server Starts With One Trace

## Outcome

Starting the local binary with a `.heapl` establishes its one active trace, and
a connected browser automatically loads that trace into its local renderer
without asking the user to open a file.

## Done when

- [x] The binary requires one trace path, reads it before listening, computes a
      stable content identity, and fails clearly when it cannot be read.
- [x] The authenticated session response identifies the trace, and an
      authenticated bounded-memory endpoint streams its original bytes with an
      immutable ETag.
- [x] Connected mode incrementally streams those bytes into the existing worker;
      standalone mode retains Open… and Demo unchanged.
- [x] Disconnect returns the tab to standalone controls, while reconnecting to
      the same trace does not reload it unnecessarily.
- [x] Server/web suites, type-check, clippy and the full build pass; no rendering
      operation crosses HTTP.

## Non-goals

- Native parsing and semantic trace queries; those are the next API slice.
- More than one trace per server process.
- Removing the browser's unavoidable transfer and WASM parse time.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

The server snapshots and hashes one required trace before listening, publishes
its identity in the authenticated session, and streams it from an authenticated
immutable endpoint. Connected tabs feed that response to a fresh WASM engine in
bounded chunks, cancel it on disconnect, and retain the rendered identity to
avoid unnecessary reloads. The server and web suites, type-check, clippy, full
build, missing-path behavior, and a live authenticated byte-for-byte retrieval
all pass.
