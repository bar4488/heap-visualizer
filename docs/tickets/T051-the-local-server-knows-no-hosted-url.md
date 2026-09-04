---
id: T051
title: The local server knows no hosted URL
status: doing
updated: 2026-09-05
---

# T051: The Local Server Knows No Hosted URL

## Outcome

The local binary starts identically for every compatible deployment and prints
one connection string that a person can give to any heap-visualizer UI or agent.

## Done when

- [ ] `--app-url` and `HEAP_APP_URL` do not exist; startup needs no knowledge of
      where the UI is hosted.
- [ ] The connection string carries only the loopback API origin and ephemeral
      capability, with the capability in its fragment.
- [ ] The web UI accepts and retains a valid connection string for its tab.
- [ ] Browser origins receive CORS responses, but no session data is returned
      without the bearer capability; Host and loopback binding checks remain.
- [ ] Server and web tests, type-check, clippy and the full build pass.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).
