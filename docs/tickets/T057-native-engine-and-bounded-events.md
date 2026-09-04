---
id: T057
title: Native engine and bounded event reads
status: done
updated: 2026-09-05
---

# T057: Native Engine and Bounded Event Reads

## Outcome

The one-trace server owns a parsed native engine before it listens, and browsers
or agents can read trace metadata, warnings, and bounded pages of semantic event
records without invoking rendering behavior.

## Done when

- [x] The core exposes an owned, safe native `Engine`; existing WASM exports
      remain compatible and use the same implementation paths.
- [x] Server startup incrementally parses the immutable trace snapshot and the
      session response includes engine metadata.
- [x] Authenticated metadata, warning, and event endpoints return the active
      trace identity and reject unbounded or out-of-range pagination.
- [x] Event pages have an explicit maximum and next-page cursor; no view,
      canvas, pixel, playback, or layout concept enters their contract.
- [x] Core/server tests, local-server clippy without dependency linting, web
      type-check and the full build pass.

## Non-goals

- Filter queries, allocation detail, or analysis mutations; each is a later API
  slice.
- Concurrent core access or more than one active trace.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

The core now offers an owned incremental `Engine` alongside its unchanged WASM
ABI. The server parses that engine before binding, publishes its metadata, and
serves authenticated metadata, custom fields, warning pages, and event pages.
List requests require an explicit count capped at 200 and responses carry the
trace identity, total, and next cursor. Core/server tests, local-server clippy
with `--no-deps`, web tests and type-check, and the full build pass.
