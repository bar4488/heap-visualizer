---
id: T059
title: Canonical analysis and revisions
status: done
updated: 2026-09-05
---

# T059: Canonical Analysis and Revisions

## Outcome

The server owns a persistent, trace-keyed analysis document whose allocation
names, colors, tags, bookmarks, address marks, and saved filters can be read and
changed through optimistic revisioned operations.

## Done when

- [x] A versioned core-owned analysis document uses stable persistent ids
      rather than worker tag indexes or array positions, validates references
      against the active trace, and has pure apply-change semantics covered by
      fixtures.
- [x] Standalone and connected UI paths call one analysis-port contract: its
      worker and HTTP adapters execute the same Rust core change implementation,
      with no TypeScript or server-side duplicate evaluator.
- [x] The binary accepts a server data directory, loads analysis by trace
      identity before listening, and durably replaces it before acknowledging a
      committed revision.
- [x] `GET /api/v1/analysis` returns the trace identity, revision, and complete
      startup snapshot; bounded authenticated mutation routes cover every
      analysis feature and require expected trace identity and revision.
- [x] Successful mutations return one small committed delta and new revision;
      stale revisions return conflict without partial application.
- [x] The native query engine receives canonical names and tags, so `named()`
      and tag predicates have the same meaning as the analysis snapshot.
- [x] Rust/web fixture tests, server tests, clippy, type-check, and full build
      pass.

## Non-goals

- Held change requests and browser live synchronization; those consume the
  committed deltas in the following slice.
- View state, `.heapa` management, trace replacement, or multiple traces.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

The Rust core now owns the document, validation, normalization, revisions, and
engine projection for both native and WASM callers. The server persists one
document per trace digest before acknowledging its bounded generic change
route, and the browser's worker and HTTP adapters install the same committed
changes through that core. A shared fixture covers the wire shapes, while the
transport suite verifies persistence, conflicts, and analysis-aware queries.
