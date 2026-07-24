# 08 — Runtime Architecture

Three layers, strict responsibilities, one direction of authority. This split
is the app's central performance decision: the DOM never touches trace data,
and the main thread never blocks on trace-sized work.

```
main thread (main.js, DOM)  ←messages→  worker (worker.js)  ←C ABI→  WASM core (Rust)
   chrome, input, overlays               canvases, frame loop,        trace, playhead,
   panels, persistence                   playback clock               layout, pixels
```

## 8.1 The WASM core

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

### Scaling rules

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

## 8.2 The worker

Owns the WASM instance and the three `OffscreenCanvas`es (transferred from
the main thread at init). Responsibilities:

- **Loading**: streams the file into the engine in 8 MiB chunks, posting
  progress; on completion posts trace metadata + warnings. Each load starts
  from a **fresh WASM instance** (the compiled module is kept and
  re-instantiated): Rust frees into its own allocator and never returns pages
  to the browser, so reusing one instance would ratchet linear memory up to
  the high-water mark of every trace opened in the session.
- **Frame loop**: a rAF loop driven by per-canvas **dirty flags** — nothing
  renders unless something changed. Timeline bitmaps are cached and re-binned
  only when view/size/tag state changes; the address map re-rasters when
  dirty. After any render it posts a consolidated `state` message
  (playhead, live stats, virtual height, overlay geometry) that the main
  thread uses to update all chrome at once.
- **Playback clock** ([06-playback-navigation §6.2](06-playback-navigation.md)).
- **Scroll authority** and scroll anchoring around layout changes
  ([06 §6.6](06-playback-navigation.md)).
- Text drawing on top of engine rasters (labels), since the engine has no
  font machinery and JS `measureText` decides what fits.

## 8.3 The main thread

DOM chrome and input only: toolbar, panels/windows, overlays (SVG move-links,
selection bands, marks, tooltips), keyboard, drag-and-drop, and persistence
(`localStorage` + file export/import). It holds *view* state (selections,
tags list, names, marks) but never trace data; anything requiring the trace
is a message round-trip.

## 8.4 Protocol conventions

- Fire-and-forget commands (seek, set-config, tag) carry no reply; the next
  `state` message reflects them.
- Query round-trips (pick, hover, events slice, address-at, convert) carry a
  `reqId`; stale replies are dropped by comparing against the latest request.
- High-frequency queries (hover picking, timeline hover, domain conversion)
  are **coalesced**: at most one in-flight request, the newest pending query
  replacing any queued one — a fast mouse drag never builds a backlog.
- Round-trip-dependent UI (selection mirroring, optimistic timeline zoom) is
  designed to tolerate one frame of lag rather than block.

## 8.5 File-type routing

One drop target for everything: a dropped/opened file whose head contains the
`"heapVisualizerAnalysis"` marker is applied as a marks file; anything else is
parsed as a trace. `?trace=URL` autoloads a trace over HTTP.
