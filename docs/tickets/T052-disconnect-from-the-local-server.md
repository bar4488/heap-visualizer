---
id: T052
title: Disconnect from the local server
status: done
updated: 2026-09-05
---

# T052: Disconnect from the Local Server

## Outcome

A connected or failed-connected tab can discard its local-server capability and
return immediately to explicit standalone mode.

## Done when

- [x] The connection control reads **Disconnect** whenever the tab retains a
      capability and **Connect…** otherwise.
- [x] Disconnect removes the tab-scoped capability and reports standalone
      without a reload.
- [x] A late response from a disconnected request cannot restore connected
      status.
- [x] The web suite, type-check and emitted web build pass.

## Non-goals

- Stopping the local binary.
- Disconnecting another browser tab or an agent.

## Result

The one control now connects or disconnects according to tab state. The web
suite, type-check and emitted build pass, including a deferred-response test
that disconnects before the connection completes.
