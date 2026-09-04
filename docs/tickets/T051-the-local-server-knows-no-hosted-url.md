---
id: T051
title: The local server knows no hosted URL
status: done
updated: 2026-09-05
---

# T051: The Local Server Knows No Hosted URL

## Outcome

The local binary starts identically for every compatible deployment and prints
one connection string that a person can give to any heap-visualizer UI or agent.

## Done when

- [x] `--app-url` and `HEAP_APP_URL` do not exist; startup needs no knowledge of
      where the UI is hosted.
- [x] The connection string carries only the loopback API origin and ephemeral
      capability, with the capability in its fragment.
- [x] The web UI accepts and retains a valid connection string for its tab.
- [x] Browser origins receive CORS responses, but no session data is returned
      without the bearer capability; Host and loopback binding checks remain.
- [x] Server and web tests, type-check, clippy and the full build pass.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

The binary takes only `--port` and prints `http://127.0.0.1:PORT#CAPABILITY`.
The full build and suites pass, and a live process admitted an arbitrary web
origin with the capability while returning 401 without it.
