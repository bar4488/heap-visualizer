---
id: T059
title: Canonical analysis and revisions
status: doing
updated: 2026-09-05
---

# T059: Canonical Analysis and Revisions

## Outcome

The server owns a persistent, trace-keyed analysis document whose allocation
names, colors, tags, bookmarks, address marks, and saved filters can be read and
changed through optimistic revisioned operations.

## Done when

- [ ] A versioned core-owned analysis document uses stable persistent ids
      rather than worker tag indexes or array positions, validates references
      against the active trace, and has pure apply-change semantics covered by
      fixtures.
- [ ] Standalone and connected UI paths call one analysis-port contract: its
      worker and HTTP adapters execute the same Rust core change implementation,
      with no TypeScript or server-side duplicate evaluator.
- [ ] The binary accepts a server data directory, loads analysis by trace
      identity before listening, and durably replaces it before acknowledging a
      committed revision.
- [ ] `GET /api/v1/analysis` returns the trace identity, revision, and complete
      startup snapshot; bounded authenticated mutation routes cover every
      analysis feature and require expected trace identity and revision.
- [ ] Successful mutations return one small committed delta and new revision;
      stale revisions return conflict without partial application.
- [ ] The native query engine receives canonical names and tags, so `named()`
      and tag predicates have the same meaning as the analysis snapshot.
- [ ] Rust/web fixture tests, server tests, clippy, type-check, and full build
      pass.

## Non-goals

- Held change requests and browser live synchronization; those consume the
  committed deltas in the following slice.
- View state, `.heapa` management, trace replacement, or multiple traces.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Handoff

Add the canonical document and change evaluator to `src/core/` first, exposing
it through both owned `Engine` methods and WASM exports. Then introduce one
TypeScript analysis-port interface with worker and HTTP adapters and migrate the
existing handlers in `src/web/heap/analysis.ts`; do not retain a TypeScript
change evaluator. The current `.heapa` numeric tag ids are not API identity.
