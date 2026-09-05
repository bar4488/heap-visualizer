---
id: D012
title: Connection mode has one authority
created: 2026-09-05
---

# D012: Connection Mode Has One Authority

## Decision

A configured local-server capability selects connected mode before the server
is reachable. Connecting, authentication failure, permission denial, and
transport failure are non-writable connected states—not fallbacks to
standalone. Only an explicit Disconnect selects standalone mode.

The browser installs server analysis authority only after the identified trace
is present in its worker. A different connected trace first invalidates the old
renderer; failure cannot leave an old trace paired with a new server. All trace
load entry points observe this same mode boundary.

Canonical analysis changes are distributed by authenticated, bounded held HTTP
requests. The server keeps a finite ordered delta history and directs clients
to reload a snapshot after a revision gap. Clients apply both local commits and
remote deltas through the Rust core via the analysis port. TypeScript only
coordinates transport and projection.

## Why

Treating connection status, trace ownership, and analysis routing as unrelated
booleans admitted mixed states: an unavailable configured server could write a
standalone history, and a failed server trace load could leave another trace
interactive. Making mode the authority removes those states instead of adding
guards to individual controls.

Held HTTP requests fit the server-only, deployment-agnostic API and are easy to
cancel when a tab changes mode. They avoid continuous snapshot polling without
introducing WebSockets or server-side view/session state.
