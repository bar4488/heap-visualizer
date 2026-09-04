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

**The server does no rendering.** "Rendering projection" in this proposal
means the browser keeps the current worker, WASM instance and OffscreenCanvas
path. It does not mean pixels are rendered twice. What exists twice while a
connected browser is open is the parsed trace/model: a native copy so agents
can work with no browser open, and a WASM copy so every pan, seek, pick and
frame stays inside the browser. That memory cost is deliberate; streaming raw
frames or geometry commands would cost latency and bandwidth on every
interaction instead of once when the trace loads.

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

The connected mode is therefore not a remote replacement for the `Worker`
object. The browser has two explicit ports:

- a **render port**, always the local worker, for playhead, view, pointer
  geometry, filter display and every canvas operation; and
- a **session port**, local in standalone mode and HTTP-backed in connected
  mode, for trace acquisition and canonical analysis.

`main.ts` should not decide message by message whether one operation is local
or remote. Analysis actions call the session port; committed analysis changes
are then projected into the render port. View actions call the render port
only. This makes split-brain writes structurally difficult and leaves the
existing worker protocol browser-internal.

### What "the worker's functionality" means at the server

The local API provides the same **data capabilities**, not wire compatibility
with `protocol.ts`:

| Server data capability | Current worker operation |
|---|---|
| Load and identify a trace; return metadata, warnings and field catalog | `load`, `loaded` |
| Page raw or filtered events | `events`, `ev-pos` |
| Resolve an allocation by creator event | `alloc-info` without canvas geometry |
| Check and run an allocation filter | `filter-check`, `filter-apply` |
| Convert time and sequence positions | `convert` |
| Read and mutate names, tags and allocation colors | `names`, `tag-*`, `alloc-color` |
| Read and mutate bookmarks, address marks and saved filters | currently main-thread analysis state |

Canvas initialization and resizing, playback, scrolling, visual selection,
layout settings, hit-testing, timeline hover and frame notifications remain
browser-only. An agent gets semantic allocation/event queries rather than
pixel coordinates. The browser may answer its own interactive queries locally
even when an equivalent semantic query exists on the server.

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

## Implementation structure

### Rust core and server

The smallest safe core refactor is to turn the current private `App` into a
normal owned `Engine`. The WASM exports remain thin calls into one singleton
`Engine`; the local server owns another `Engine` directly. The server never
calls its render methods, so render buffers remain unallocated. This avoids a
premature rewrite of `Store`, `View` and `Cfg` while removing the 32-bit pointer
ABI from native callers.

The local server belongs in its own Rust crate (`src/local-server/`), separate
from the existing hosted Python feature-request service. HTTP/runtime/JSON
dependencies belong to that binary crate and must not enter the WASM core's
dependency graph.

One engine actor should own the native `Engine` and canonical analysis state.
HTTP tasks submit typed commands over a bounded channel and await typed
results. This matches the core's current single-owner assumptions, gives every
mutation one total order, and avoids a lock around dozens of mutable indexes.
Filter scans are already expected to complete in milliseconds; parallel query
execution should be added only if measurement shows the actor queue matters.

The actor publishes `(traceId, revision, change)` after durable commit. Held
change requests wait on a watch/broadcast signal outside the engine actor, so
idle browsers consume neither a thread nor a polling interval.

### Trace transfer

Connected mode must not materialize extra whole-file copies. The browser worker
currently receives one `ArrayBuffer` and only then feeds it to Rust in 8 MiB
pieces. Replace that command with `load-begin`, transferable `load-chunk`, and
`load-end`; both a browser `File.stream()` and the server's trace response can
then flow through bounded chunks.

When the browser opens a file, it streams the same file independently to the
server and its local worker. When the server starts with a trace path, the
browser streams that file once from `GET /api/v1/trace` into the worker. A
browser upload is spooled into the server data directory while the native
parser consumes it, so a later tab can retrieve it without retaining the
upload in RAM.

The server computes a content identity while parsing. The trace response is
immutable for that identity and carries an `ETag`; analysis mutations name the
identity. Switching trace atomically replaces the active engine only after the
new parse succeeds.

### Analysis synchronization

Canonical analysis is a plain domain document plus a revision. Each operation
has a stable change shape — for example, set one allocation name or add one tag
membership — and is applied only once by the server. The browser applies the
committed change it reads back; it does not optimistically invent a second
revision.

The TypeScript analysis code should first be separated into pure document
updates and DOM refreshes. Rust and TypeScript then share versioned JSON
fixtures asserting that the same starting document and change produce the same
result. They should not share the current numeric tag ids as API identity: tag
ids are an engine representation, while stable tag ids or names belong to the
session document and are translated when projecting into either engine.

### Efficiency rules

- No frame, pixel buffer, pointer move, scroll or playback tick crosses HTTP.
- Trace bytes cross once per browser and are parsed incrementally at both ends.
- Every list/query endpoint is bounded and paged; no accidental whole-trace
  JSON response exists.
- HTTP bodies use compact JSON initially. A binary protocol is not earned until
  measurement shows response encoding rather than filtering is material.
- Analysis changes are small deltas; a full snapshot is only startup or gap
  recovery.
- Server query filters are ephemeral and must not change a browser's applied
  filter or any per-tab view state.
- The native server serializes core access first. Concurrency, query caches and
  a render-free core feature are measurement-driven follow-ups, not initial
  architecture.

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

## Derived artifacts

- [T050](../tickets/T050-prove-the-hosted-to-loopback-connection.md) — the
  hosted-to-loopback transport proof, before the engine boundary moves.
- [T051](../tickets/T051-the-local-server-knows-no-hosted-url.md) — remove the
  accidental hosted-origin configuration from the local binary.
