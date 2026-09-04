---
id: T058
title: Allocation detail and ephemeral filter query
status: done
updated: 2026-09-05
---

# T058: Allocation Detail and Ephemeral Filter Query

## Outcome

Agents can inspect one allocation and run the product's filter language against
the authoritative trace through bounded semantic endpoints that do not alter a
browser's filter or any server view state.

## Done when

- [x] The native engine emits allocation detail without rectangles or other
      render geometry and returns not-found for a non-creator event.
- [x] `GET /api/v1/allocations/{creator}` is authenticated and trace-identified.
- [x] `POST /api/v1/query` accepts a bounded source and page request, returns
      filter diagnostics or a capped page of creator allocations, and leaves
      engine state unchanged.
- [x] Query and allocation payloads contain no browser view state; tests prove
      pagination, diagnostics, authentication, and repeated-query isolation.
- [x] Core/server tests, local-server clippy, type-check, and full build pass.

## Non-goals

- Analysis-aware `tag()` and `named()` queries; canonical analysis lands next
  and will supply those catalogs.
- Canonical analysis mutations or live change synchronization.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

The owned engine now emits semantic allocation records and executes each query
with independent lowered-plan match bits. The server authenticates both routes,
requires query trace identity, caps source and page sizes, returns source-span
diagnostics, and supports browser JSON preflight. Core/server tests,
local-server clippy, web tests and type-check, and the full build pass.
