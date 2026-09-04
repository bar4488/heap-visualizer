---
id: T058
title: Allocation detail and ephemeral filter query
status: doing
updated: 2026-09-05
---

# T058: Allocation Detail and Ephemeral Filter Query

## Outcome

Agents can inspect one allocation and run the product's filter language against
the authoritative trace through bounded semantic endpoints that do not alter a
browser's filter or any server view state.

## Done when

- [ ] The native engine emits allocation detail without rectangles or other
      render geometry and returns not-found for a non-creator event.
- [ ] `GET /api/v1/allocations/{creator}` is authenticated and trace-identified.
- [ ] `POST /api/v1/query` accepts a bounded source and page request, returns
      filter diagnostics or a capped page of creator allocations, and leaves
      engine state unchanged.
- [ ] Query and allocation payloads contain no browser view state; tests prove
      pagination, diagnostics, authentication, and repeated-query isolation.
- [ ] Core/server tests, local-server clippy, type-check, and full build pass.

## Non-goals

- Analysis-aware `tag()` and `named()` queries; canonical analysis lands next
  and will supply those catalogs.
- Canonical analysis mutations or live change synchronization.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Handoff

Add render-free allocation serialization and an ephemeral query method to
`heap_visualizer_core::Engine`, then route them from
`src/local-server/src/lib.rs`. The existing `push_event_json` and lowered filter
path in `src/core/src/lib.rs` are the grounded implementation sources.
