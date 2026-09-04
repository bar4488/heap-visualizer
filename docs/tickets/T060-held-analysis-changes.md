---
id: T060
title: Held analysis changes
status: todo
updated: 2026-09-05
---

# T060: Held Analysis Changes

## Outcome

Connected tabs converge on every committed canonical analysis revision without
polling continuously or reloading the trace.

## Done when

- [ ] An authenticated held `GET /api/v1/changes?after=&wait=` returns bounded,
      ordered committed deltas for the active trace and never carries view or
      rendering state.
- [ ] A revision gap or expired retained history tells the browser to reload
      the complete analysis snapshot.
- [ ] Connected browsers apply each delta through the existing analysis port
      and shared Rust core, while standalone mode makes no synchronization
      request.
- [ ] Disconnect and connection replacement cancel held requests and prevent
      late responses from changing the tab.
- [ ] Server and web tests, clippy, type-check, and the full build pass.

## Non-goals

- WebSockets, MCP, view control, multiple traces, or analysis undo/redo.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).
