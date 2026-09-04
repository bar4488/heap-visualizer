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

- [ ] A versioned analysis document uses stable persistent ids rather than
      worker tag indexes or array positions, validates references against the
      active trace, and has pure apply-change semantics covered by fixtures.
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

First extract the analysis value validation and pure change application from
`src/web/heap/analysis.ts` into a DOM-free module with versioned JSON fixtures.
Define the stable-id wire document in `ARCH-008` before adding Rust persistence
or routes; the current `.heapa` numeric tag ids are explicitly not API identity.
