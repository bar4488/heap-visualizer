---
id: E021
title: A shared local session for people and agents
status: open
updated: 2026-09-04
---

# E021: A Shared Local Session for People and Agents

## Summary

A local server should own one active trace and its analysis state. The web app
and agents should be clients of that same session: an annotation made through
HTTP appears in the open browser, and a browser annotation is immediately
visible through HTTP.

The first agent surface is read and annotate. Agents may inspect the trace,
query allocations, and edit the analysis layer; they may not drive the
browser's playhead or layout, load another trace, or import/export analysis
files. The protocol is versioned JSON over HTTP with WebSocket notifications.
MCP is a later adapter over that API, not a second implementation of session
semantics.

The existing standalone browser remains supported. Server-backed versus
standalone is selected at startup and is always visible; losing a connected
server must not silently turn the tab into a divergent standalone editor.

## Current boundary

Today the browser worker owns the only engine instance, trace bytes, tags and
playhead. The main thread owns the rest of the analysis layer in `UIState` and
persists it to `localStorage`. `src/server/` only serves `dist/` and the feature
request API. There is no process an agent can query and no canonical state two
clients can share.

Moving the canvases to the server would make every dirty frame a large pixel
transfer and move pointer interaction onto a network round trip. Keeping the
browser as the authority would require it to stay open for an agent to work.
Neither is the intended separation.

## Proposed architecture

```text
                         HTTP commands and queries
agent / curl  <------------------------------------------+
                                                        |
browser UI  -- HTTP mutations --> local session server  |
     ^             |                     |              |
     |             +-- WebSocket events -+              |
     |                                   |              |
     +-- local worker + WASM ------------+ trace bytes  |
           rendering projection            and snapshot |
                                                        |
                         authoritative native Rust core +
```

### The local server

A new native Rust binary should depend on `heap-visualizer-core` without adding
server dependencies to the WASM crate. It should:

- bind to loopback only and serve both `dist/` and `/api/v1/`;
- own one parsed trace and one canonical analysis document;
- serialize mutations, assign a monotonically increasing revision, persist
  analysis atomically, and broadcast committed changes;
- answer trace-sized queries in the native core; and
- provide the trace bytes and current snapshot to a newly connected browser.

The core's current private global `App` and pointer-oriented C ABI are a WASM
boundary, not a native library API. The server requires a safe `Engine` API
behind that ABI; the WASM exports should become a thin singleton adapter over
the same type. This keeps parsing, filtering and allocation identity in one
implementation.

One command should start the server and print its URL. A trace may be named on
that command or opened by the web UI. Agent trace loading is outside the first
tool surface even though the browser needs a load route.

### The browser client

The server remains authoritative, but the existing worker keeps a local WASM
replica for rendering and pointer-speed queries. On connection the browser:

1. fetches session metadata, trace identity, analysis snapshot and revision;
2. loads the server's trace bytes into its worker;
3. applies the canonical analysis snapshot; and
4. applies each later committed mutation in revision order.

Browser analysis edits go to the server first and are applied from the
committed event. Navigation, canvas dimensions, panel positions and other
per-tab view state stay local. Names and tag membership are mirrored into both
engines because filters depend on them. A revision gap triggers a fresh
snapshot rather than an attempted merge.

At startup, an absent `/api/v1/session` selects the existing standalone path.
Once connected, a disconnect leaves trace exploration available from the local
worker but makes canonical annotation writes unavailable until resync. It must
not start writing a second analysis history to `localStorage`.

### Canonical state

The server owns domain analysis only:

- tag definitions, colors and allocation membership;
- allocation names and colors;
- time bookmarks and address marks; and
- saved filter names and sources.

The browser continues to own applied filter, playhead, selections, crop,
timeline views, windows, drawers and other workspace state. The current
`.heapa` shape mixes both classes, so connected persistence needs an explicit
domain-only shape. Import/export compatibility is a later operation, not a
reason for the server to own browser layout.

Allocation references carry both the creator event index and the active trace
identity. A mutation for a stale trace must fail rather than annotate the same
event index in a newly loaded trace.

## HTTP surface

Exact payloads belong in the spec, but the first surface should have these
semantics:

```text
GET  /api/v1/session                    connection mode, trace id, metadata, revision
GET  /api/v1/analysis                   canonical analysis snapshot
GET  /api/v1/events?from=&count=        paged event records
GET  /api/v1/allocations/{creator}      one allocation
POST /api/v1/query                      compile a filter and return paged matches

PUT    /api/v1/allocations/{creator}/name
PUT    /api/v1/allocations/{creator}/color
PUT    /api/v1/allocations/{creator}/tags/{tag}
DELETE /api/v1/allocations/{creator}/tags/{tag}
PUT    /api/v1/tags/{tag}
PUT    /api/v1/bookmarks/{id}
DELETE /api/v1/bookmarks/{id}
PUT    /api/v1/address-marks/{id}
DELETE /api/v1/address-marks/{id}
PUT    /api/v1/saved-filters/{id}
DELETE /api/v1/saved-filters/{id}

GET  /api/v1/events                     WebSocket upgrade for snapshots and changes
POST /api/v1/traces                     browser upload; not advertised as an agent tool
```

Mutation requests carry the trace identity and expected revision. A stale
revision returns a conflict with the current revision. Names in URL paths are
encoded normally, while persistent marks and filters receive stable ids so a
rename is an update rather than delete-and-create.

Agent responses should be bounded and self-describing: pagination everywhere
a trace-sized result is possible, filter diagnostics with source spans, and no
canvas or DOM concepts. An eventual MCP server maps tools such as
`trace_summary`, `query_allocations`, `get_allocation`, `name_allocation` and
`tag_allocation` directly onto this API.

## Safety and deployment

The first server binds only `127.0.0.1` (and loopback IPv6 when supported),
rejects non-local Host values, sends no permissive CORS headers, and checks the
WebSocket Origin against the page it served. This protects the browser surface
from remote use without inventing user accounts. Local processes are trusted in
the first version.

The existing feature-request service is a different concern. The local session
API must not be hidden inside its request store, and the hosted feature-request
deployment must not acquire trace access as a side effect. Whether the new Rust
binary also serves those four routes can be decided during implementation; it
does not change the session protocol.

## Delivery slices

1. **Native engine and read API.** Extract a safe `Engine`, keep the C ABI and
   native/WASM tests passing, then serve one trace with metadata, events,
   allocation lookup and bounded filter queries.
2. **Canonical analysis and live changes.** Add the domain-only persisted
   document, revisions, mutation routes and WebSocket stream. Prove with two
   HTTP clients that stale writes conflict and committed edits survive restart.
3. **Connected web client.** Add a transport boundary beside the current
   worker transport, synchronize the rendering replica, route browser analysis
   edits through the server, and retain an explicit standalone startup path.
4. **Local product path.** Provide one documented start command, connection
   status in the UI, API examples for agents, and an end-to-end check in which
   an HTTP tag mutation appears in an already-open browser.

These are candidate tickets only after this proposal is accepted. The spec
changes must replace the current claim that the worker is the sole trace
authority while preserving the rendering and scaling invariants that motivated
it.

## Done when

- One local command starts a loopback server and the web app connects to it.
- The browser and two independent HTTP clients observe one trace id and one
  monotonically revised analysis state.
- An agent can inspect metadata, events and allocations, run a bounded filter
  query, and add or remove every existing kind of domain annotation.
- An agent annotation appears in an open browser without reload, and a browser
  annotation is immediately readable through HTTP.
- Analysis survives server restart; a stale or wrong-trace mutation cannot be
  committed.
- Starting the existing static client without the session server still opens a
  working, visibly standalone viewer.
- Connected-server loss is visible and does not create a second writable copy
  of analysis state.
- The local API is unreachable off-machine by default.

## Non-goals

- MCP in the first implementation.
- Multiple active traces or remote collaboration.
- Agent control of playhead, selection, zoom, layout or other per-tab state.
- Agent trace loading or `.heapa` import/export.
- Server-side canvas rendering or streaming pixels.
- Replacing the browser worker: it remains the low-latency rendering engine.

## Questions before tickets

- Should connected analysis persist beside the trace, in a server data
  directory keyed by trace identity, or only at an explicitly configured path?
- Is the intended distributable a single native binary containing `dist/`, or
  a binary beside the generated directory for the first version?
- Should the local server retain the feature-request routes, proxy them to a
  hosted service, or hide the Request control in local mode?
