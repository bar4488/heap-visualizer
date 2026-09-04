---
id: T057
title: Native engine and bounded event reads
status: doing
updated: 2026-09-05
---

# T057: Native Engine and Bounded Event Reads

## Outcome

The one-trace server owns a parsed native engine before it listens, and browsers
or agents can read trace metadata, warnings, and bounded pages of semantic event
records without invoking rendering behavior.

## Done when

- [ ] The core exposes an owned, safe native `Engine`; existing WASM exports
      remain compatible and use the same implementation paths.
- [ ] Server startup incrementally parses the immutable trace snapshot and the
      session response includes engine metadata.
- [ ] Authenticated metadata, warning, and event endpoints return the active
      trace identity and reject unbounded or out-of-range pagination.
- [ ] Event pages have an explicit maximum and next-page cursor; no view,
      canvas, pixel, playback, or layout concept enters their contract.
- [ ] Core/server tests, clippy, web type-check and the full build pass.

## Non-goals

- Filter queries, allocation detail, or analysis mutations; each is a later API
  slice.
- Concurrent core access or more than one active trace.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).
