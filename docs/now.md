# Current State

Updated 2026-09-05.

Heap Visualizer renders `.heapl` allocation traces entirely in the browser. A
Rust/WASM engine runs in a Web Worker with OffscreenCanvas; TypeScript owns the
DOM, input, panels, and browser-side session state.

## Architecture

- `src/core/` parses traces, maintains allocation state, evaluates filters,
  renders the map and timelines, and owns canonical analysis semantics.
- `src/filter-dsl/` owns the Python-shaped filter grammar and lexer.
- `src/web/` contains the browser UI, worker protocol, analysis adapters, and
  persisted view/session state.
- `src/local-server/` is an optional loopback-only data API. It snapshots and
  parses one trace, authenticates requests with an ephemeral bearer capability,
  and persists canonical analysis by trace digest. It never renders.
- `src/server/` serves the hosted app and feature-request API. It never receives
  trace or analysis data.

Standalone and connected browser modes use the same WASM renderer. Connected
analysis mutations are committed by the local server and installed into the
browser through the same Rust evaluator used in standalone mode. Native queries
therefore share `named()` and tag semantics with the browser.

The filter language is documented in `spec/07-analysis.md`. Allocation fields
hang from `alloc`, `malloc`, and `free`; custom fields use
`malloc.fields.<key>` or `free.fields.<key>`.

## Likely next work

`docs/tickets/T060-held-analysis-changes.md` describes the next local-session
slice: held committed deltas so multiple connected tabs converge without
continuous polling. Tickets are optional planning notes, not workflow gates.

Other existing backlog items remain under `docs/tickets/`; inspect them only
when choosing unrelated work.

## Known limitations

- Connected analysis does not yet synchronize changes made by another client.
- Rendering, pointer gestures, and exact canvas layout are not covered by the
  automated suites.
- The filter language does not have unary minus; write `0 - 5` for a negative
  literal.
- Actual HTTPS-to-loopback behavior still needs occasional manual checks in
  Chrome, Firefox, and Safari because browser local-network policies differ.

## Working here

Use [AGENTS.md](../AGENTS.md) for the short workflow and
[context.md](context.md) for exact commands. Product behavior is authoritative
in [spec/](../spec/README.md).
