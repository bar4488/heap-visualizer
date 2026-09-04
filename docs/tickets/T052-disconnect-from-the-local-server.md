---
id: T052
title: Disconnect from the local server
status: doing
updated: 2026-09-05
---

# T052: Disconnect from the Local Server

## Outcome

A connected or failed-connected tab can discard its local-server capability and
return immediately to explicit standalone mode.

## Done when

- [ ] The connection control reads **Disconnect** whenever the tab retains a
      capability and **Connect…** otherwise.
- [ ] Disconnect removes the tab-scoped capability and reports standalone
      without a reload.
- [ ] A late response from a disconnected request cannot restore connected
      status.
- [ ] The web suite, type-check and emitted web build pass.

## Non-goals

- Stopping the local binary.
- Disconnecting another browser tab or an agent.
