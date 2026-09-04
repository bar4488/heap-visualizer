# 08 — Runtime Architecture

Three layers, strict responsibilities, one direction of authority. This split
is the app's central performance decision: the DOM never touches trace data,
and the main thread never blocks on trace-sized work.

```
main thread (DOM)           ←messages→  worker (worker.ts)  ←C ABI→  WASM core (Rust)
  main.ts + shell/ + heap/               canvases, frame loop,        trace, playhead,
  chrome, input, overlays, persistence   playback clock               layout, pixels
```

## ARCH-001: The WASM core

- Rust compiled to `wasm32-unknown-unknown`, **plain C ABI, no wasm-bindgen**
  — an opinionated choice: zero glue-code dependency, a fully explicit
  boundary, and the same crate runs as a native `rlib` for tests.
- Single global engine instance (the target is single-threaded; native tests
  construct their own instances instead).
- Boundary conventions, uniform across all ~60 exports:
  - **Input**: callers write bytes into one engine-owned input buffer
    (`hp_buf_ptr`), then call the function with a length/count. Used for file
    chunks, filter JSON, pin/color/event arrays.
  - **Output**: multi-value returns go through a fixed 8-slot u32 return area
    (`hp_ret`); structured results are JSON strings (ptr/len in slots 0/1);
    u64 addresses cross as lo/hi u32 pairs (JS numbers can't hold them).
  - Pixel results are ptr/len views straight into WASM memory — the worker
    wraps them in `ImageData` with no copy.
- JSON in and out is handled by a **hand-rolled single-pass scanner/writer**
  (`core/src/json.rs`) rather than serde — deliberate: tolerant scanning of
  unknown fields, raw-span capture of extras, and no dependency weight in the
  wasm binary.

### ARCH-002: Scaling rules

The target is traces of millions of events, which makes two costs the ones
worth defending. Both have been the actual bottleneck at some point:

- **Nothing per frame may be O(live set).** Rendering enters the
  address-ordered live set by binary search at the first visible row (bounded
  below by the trace's largest span, exactly like hit-testing) and stops past
  the last visible one, so a frame costs O(visible + log live) no matter how
  large the live set grows. Values that would otherwise need a full scan are
  maintained incrementally instead — the age color mode's oldest-live-birth
  comes from a birth-time multiset in `View`, updated on insert/remove.
- **Nothing per event may be paid by every trace.** Columns that most traces
  never populate (`usable`, `stack`, `extra`) are *lazy*: the column stays
  empty until the first real value appears and is read through an accessor
  that reports the default, so a trace without them allocates nothing.
  `R`-only geometry (`old_addr`/`old_size`) lives in a side table keyed by
  event index rather than two u64 columns spanning every event.

## ARCH-003: The worker

Owns the WASM instance and the three `OffscreenCanvas`es (transferred from
the main thread at init). Responsibilities:

- **Loading**: streams the file into the engine in 8 MiB chunks, posting
  progress; on completion posts trace metadata + warnings. Each load starts
  from a **fresh WASM instance** (the compiled module is kept and
  re-instantiated): Rust frees into its own allocator and never returns pages
  to the browser, so reusing one instance would ratchet linear memory up to
  the high-water mark of every trace opened in the session. Re-instantiation
  is *purely* that memory measure — it is not the reset mechanism.
  `hp_parse_begin` performs a complete state reset (store, view, and the
  whole `Cfg`: selection, filter, zoom/pan, crop, overrides, tag colors,
  modes), so an engine instance is also correct on its own when reused, as
  the native tests do.
- **Frame loop**: a rAF loop driven by per-canvas **dirty flags** — nothing
  renders unless something changed. Timeline bitmaps are cached and re-binned
  only when view/size/tag state changes; the address map re-rasters when
  dirty. After any render it posts a consolidated `state` message
  (playhead, live stats, virtual height, overlay geometry) that the main
  thread uses to update all chrome at once.
- **Playback clock** ([NAV-002](06-playback-navigation.md#nav-002-playback)).
- **Scroll authority** and scroll anchoring around layout changes
  ([NAV-006](06-playback-navigation.md#nav-006-scroll-ownership)).
- Text drawing on top of engine rasters (labels), since the engine has no
  font machinery and JS `measureText` decides what fits.

## ARCH-004: The main thread

DOM chrome and input only: toolbar, panels/windows, overlays (SVG move-links,
selection bands, marks, tooltips), keyboard, drag-and-drop, and persistence
(`localStorage` + file export/import). It holds *view* state (selections,
tags list, names, marks) but never trace data; anything requiring the trace
is a message round-trip.

### ARCH-005: Module layout

It is split on one seam: code whose meaning depends on heap traces, and code
whose meaning does not. **The directory a file sits in states who owns it**,
and "does the shell know about heaps" is a question `grep -r heap src/web/shell/`
answers.

| | |
|---|---|
| `src/web/shell/` | `dom.ts` (`$`, `$$`, `setHtml`, `delegate`, device↔CSS px), `panels.ts` (draggable windows, z-stack), `drawers.ts` (dockable left/right drawers), `tooltip.ts`. **No domain identifiers.** |
| `src/web/heap/` | `analysis.ts` (tags, names, colors, marks, `.heapa`), `panels.ts` (the panel table), `events-panel.ts`, `addr.ts` |
| `src/web/session.ts` | The boundary: serializes shell state (window/drawer geometry) *and* heap state (view, crop, filters, playhead) into the one per-trace session blob |
| `src/web/main.ts` | Trace/worker/toolbar wiring and the three coordinated views. Owns `UIState`, the shared main-thread state every other module receives as `deps.ui` |
| `src/web/fmt.ts`, `src/web/rpc.ts` | Shared with the worker; the request/response layer |
| `src/web/protocol.ts` | The message protocol, types only. Both sides import it, so a message one side does not know about is a build error |

Two rules keep the seam from eroding. **No module imports the shared `UI`
object** — each receives what it needs through an `init*(deps)` call, so the
coupling is written down instead of ambient, and there is no circular-import
initialization hazard. **`panels.js` never imports `drawers.js`**: the drag
path that can end in a dock receives the dock API as an argument.

The destination this serves is a domain-independent shell hosting several
analysis domains, heap being the first; see
[docs/explorations/E007-web-architecture-direction](../docs/explorations/E007-web-architecture-direction.md).

## ARCH-006: Protocol conventions

- **One type describes the protocol** (`src/web/protocol.ts`), imported by both
  sides: which messages exist, in which direction, carrying which fields. A
  name or field on one side that the other does not know is a build error, not
  a message that silently does nothing. Payloads that are engine JSON stay
  loose there — `src/core/` owns those shapes and must not have a second owner.
- Fire-and-forget commands (seek, set-config, tag) carry no reply; the next
  `state` message reflects them.
- Query round-trips (pick, hover, events slice, address-at, convert) carry a
  `reqId`; stale replies are dropped by comparing against the latest request.
- High-frequency queries (hover picking, timeline hover, domain conversion)
  are **coalesced**: at most one in-flight request, the newest pending query
  replacing any queued one — a fast mouse drag never builds a backlog.
- Round-trip-dependent UI (selection mirroring, optimistic timeline zoom) is
  designed to tolerate one frame of lag rather than block.

## ARCH-007: File-type routing

One drop target for everything: a dropped/opened file whose head contains the
`"heapVisualizerAnalysis"` marker is applied as a marks file; anything else is
parsed as a trace. `?trace=URL` autoloads a trace over HTTP.

## ARCH-008: Local data-server connection

The hosted web app must have two explicit startup modes:

- **standalone**, the existing in-browser engine and persistence path, selected
  by an ordinary visit; and
- **connected**, selected by a launch capability from the local data server.

The local server must be a server-only native executable: it must bind to
loopback, expose a versioned data API, and serve neither the web UI nor the
feature-request routes. It must know nothing about which compatible UI or agent
will use it. The connection string must carry only the loopback API origin and
a freshly generated capability in its URL fragment, and the UI must retain it
only for that tab. The capability must be required as a bearer value by every
data request. CORS may admit a syntactically valid browser origin so any
compatible deployment can connect; possession of the capability, not the web
origin, is the authority.

Connected mode must not move rendering onto the server. The browser worker,
WASM engine and OffscreenCanvas remain the complete rendering path; no frame,
pixel buffer, pointer movement, scroll or playback tick may cross the HTTP
boundary. The local server is a data authority, and an ordinary standalone tab
must not contact it.

The app must visibly distinguish standalone, connecting, connected,
authentication failure, browser permission denial when that state is exposed,
and a local endpoint that is otherwise unavailable or blocked. Losing a
connected endpoint must not silently select standalone mode and create a
second writable analysis history. The connection control must also let the
current tab discard its capability and return immediately to standalone; it
must not stop the server or disconnect any other client.
