---
id: T050
title: Prove the hosted-to-loopback connection
status: done
updated: 2026-09-04
---

# T050: Prove the Hosted-to-Loopback Connection

## Outcome

A server-only Rust binary binds to loopback, prints a capability-bearing launch
URL for the hosted app, and the app visibly enters connected mode through its
authenticated HTTP endpoint while an ordinary visit remains standalone.

## Done when

- [x] The binary binds only to loopback, generates a fresh capability each run,
      and accepts `GET /api/v1/session` only with that bearer capability.
- [x] Browser requests are accepted only from the configured hosted origin;
      the precise CORS and legacy private-network preflight behavior has server
      integration coverage.
- [x] The capability stays in the URL fragment, is removed from browser history
      after being read, and is retained only for that tab's session.
- [x] The UI distinguishes standalone, connecting, connected, authentication
      failure, permission denial when the browser exposes it, and an otherwise
      unreachable or blocked server.
- [x] The existing web suite and type-check pass, the local-server suite passes,
      and the emitted web tree builds.
- [x] The remaining manual Chrome, Firefox and Safari connection checks are
      named precisely; under D001 they are not delegated as automated work and
      do not silently become a browser-harness project.

## Non-goals

- Loading or querying a trace through the server.
- Synchronizing analysis state.
- Serving web assets or feature requests from the local binary.
- Moving any rendering operation out of the browser worker.

See [E021](../explorations/E021-a-shared-local-session-for-people-and-agents.md).

## Result

All automated suites, clippy, type-check and the full build pass; a live binary
returned authenticated 200, exact-origin CORS and wrong-token 401. A person
still needs to open its URL from the actual HTTPS deployment in current Chrome
(grant and deny Apps on device), Firefox and Safari; D001 keeps that out of the
automated gate.

_Correction, 2026-09-05:_ T051 removed the configured hosted origin and launch
URL. The binary now prints one deployment-agnostic connection string; the
capability is the authority and any compatible UI may present it.
