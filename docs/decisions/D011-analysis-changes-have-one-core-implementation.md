---
id: D011
title: Analysis changes have one core implementation
created: 2026-09-05
---

# D011: Analysis Changes Have One Core Implementation

## Decision

Analysis document validation and change application live once in the Rust core.
The WASM worker uses that implementation in standalone mode and the native
engine uses it in connected mode.

The browser analysis UI talks to one asynchronous analysis-port contract. Its
standalone adapter sends operations to the worker; its connected adapter sends
the same operations to the local server. Both return the same canonical
document/change shapes, which the browser projects into controls and rendering
messages. Persistence and transport differ by adapter; domain behavior does
not.

The existing TypeScript mutation code is migrated to that flow rather than
copied into a second server implementation. Cross-language fixtures may assert
the wire contract, but must not become a second change evaluator.

## Why

The user explicitly rejected duplicate standalone/server logic on 2026-09-05.
Separate TypeScript and Rust evaluators would drift on normalization,
validation, tag deletion, allocation references, and later format changes. The
core already runs in both required environments, so it is the shared execution
boundary.
