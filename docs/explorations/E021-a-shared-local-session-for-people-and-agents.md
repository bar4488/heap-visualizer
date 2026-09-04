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
files. The protocol is versioned JSON over HTTP, including a held changes
request for live updates. MCP is a later adapter over that API, not a second
implementation of session semantics.

The UI remains on the hosted site, including its feature-request route; the
local binary serves only the session API. The existing standalone browser
remains supported. Server-backed versus standalone is selected at startup and
is always visible; losing a connected server must not silently turn the tab
into a divergent standalone editor.

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
hosted browser UI -- HTTP mutations --> local server    |
     ^             |                     |              |
     |             +-- held changes GET -+              |
     |                                   |              |
     +-- local worker + WASM ------------+ trace bytes  |
           rendering projection            and snapshot |
                                                        |
                         authoritative native Rust core +
```

### The local server

A new native Rust binary should depend on `heap-visualizer-core` without adding
server dependencies to the WASM crate. It is one distributable executable, but
it does not contain or serve the web app. It should:

- bind to loopback only and serve `/api/v1/`;
- own one parsed trace and one canonical analysis document;
- serialize mutations, assign a monotonically increasing revision, persist
  analysis atomically in a server data directory, and publish committed
  changes;
- answer trace-sized queries in the native core; and
- provide the trace bytes and current snapshot to a newly connected browser.

The core's current private global `App` and pointer-oriented C ABI are a WASM
boundary, not a native library API. The server requires a safe `Engine` API
behind that ABI; the WASM exports should become a thin singleton adapter over
the same type. This keeps parsing, filtering and allocation identity in one
implementation.

One command should start the server and print both its API URL and a launch URL
for the hosted app. The launch URL carries an ephemeral connection capability
in its fragment, which is not sent to the hosted server; the app removes it
from browser history after reading it. The same capability is printed for an
agent to use as a bearer token. A trace may be named on the command or opened
by the web UI. Agent trace loading is outside the first tool surface even
though the browser needs a load route.

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

Opening the hosted site normally selects the existing standalone path. A local
server launch URL, or an explicit Connect action, selects connected mode. Once
connected, a disconnect leaves trace exploration available from the local
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

GET  /api/v1/changes?after=&wait=       held request for ordered committed changes
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
rejects non-local Host values, and accepts browser origins only from an exact
allowlist containing the hosted app and configured development origins. Every
API request requires the ephemeral bearer capability. The hosted page must
explicitly allow the loopback endpoint in `connect-src`; the local server must
answer CORS preflights for only that origin and token-bearing request shape.

Current Chromium releases gate public-site-to-loopback requests behind the
Local Network Access permission, and the API is exposed as
`http://127.0.0.1`. The connection UI must explain that prompt and distinguish
permission denied from server absent. Loopback HTTP is treated as potentially
trustworthy by the mixed-content specification, but browser behavior —
especially WebKit — has differed. This topology therefore starts with a manual
Chrome/Firefox/Safari compatibility spike. A held HTTP request is proposed
instead of `ws://`: it uses the same authenticated fetch/CORS/LNA path as every
other operation and avoids a separate mixed-content and WebSocket permission
surface.

Local processes are trusted in the first version. The capability protects the
service from arbitrary websites, not from another process running as the same
user.

The existing feature-request service stays at the hosted deployment. The local
session binary has no request store, admin panel, static files, or proxy route,
and the hosted feature-request deployment acquires no trace access.

## Delivery slices

1. **Prove the hosted-to-loopback path.** A minimal authenticated endpoint must
   be reached from the HTTPS deployment in current Chrome, Firefox and Safari,
   with connection, permission denial and absence distinguishable. This retires
   transport risk before the engine moves.
2. **Native engine and read API.** Extract a safe `Engine`, keep the C ABI and
   native/WASM tests passing, then serve one trace with metadata, events,
   allocation lookup and bounded filter queries.
3. **Canonical analysis and live changes.** Add the domain-only persisted
   document, revisions, mutation routes and held changes endpoint. Prove with two
   HTTP clients that stale writes conflict and committed edits survive restart.
4. **Connected web client.** Add a transport boundary beside the current
   worker transport, synchronize the rendering replica, route browser analysis
   edits through the server, and retain an explicit standalone startup path.
5. **Local product path.** Produce one server-only binary, provide one
   documented start command and hosted launch URL, add connection
   status in the UI, API examples for agents, and an end-to-end check in which
   an HTTP tag mutation appears in an already-open browser.

These are candidate tickets only after this proposal is accepted. The spec
changes must replace the current claim that the worker is the sole trace
authority while preserving the rendering and scaling invariants that motivated
it.

## Done when

- One local command starts a loopback API server and gives the user a URL that
  opens the hosted web app connected to it.
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
- The local API is unreachable off-machine by default and rejects a browser
  without the expected hosted origin and ephemeral capability.

## Non-goals

- MCP in the first implementation.
- Multiple active traces or remote collaboration.
- Agent control of playhead, selection, zoom, layout or other per-tab state.
- Agent trace loading or `.heapa` import/export.
- Serving or embedding the web UI in the local binary.
- Moving or proxying the hosted feature-request service into the local binary.
- Server-side canvas rendering or streaming pixels.
- Replacing the browser worker: it remains the low-latency rendering engine.

## Decisions made while planning

- Connected analysis persists in a server data directory keyed by trace
  identity; the server never writes beside a trace implicitly.
- The distributable is one native binary containing only the local session
  server. The UI remains the hosted site.
- Feature requests remain entirely at the hosted deployment.
