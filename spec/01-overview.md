# 01 — Overview & Goals

heap-visualizer visualizes the life of a program's heap. It consumes a **stream
of allocation and free events** (a `.heapl` file, see
[02-trace-format](02-trace-format.md)) and renders them on an **address-line**:
a 2D map of the address space where currently-allocated memory is drawn as
filled cells. A time control lets the user **time-travel** to any point in the
trace and see exactly what was live then. On top of viewing, the app is an
**analysis workbench**: allocations can be named, tagged, colored, and
bookmarked, and the whole analysis saved to a portable `.heapa.json` file
([07-analysis](07-analysis.md)).

## Design goals, in priority order

1. **Fast** — smooth interaction on traces with millions of events. All heavy
   work (parsing, seeking, rasterization) runs in a Rust → WebAssembly core
   inside a Web Worker; the DOM layer only handles chrome and input.
2. **Portable** — fully client-side static site. A trace file is dropped onto
   the page and rendered; nothing is uploaded anywhere.
3. **Faithful** — the picture at time *T* is exactly the set of live
   allocations at *T*, reconstructed deterministically from the stream.
   Malformed input is rendered anyway and *flagged* (warnings), never silently
   repaired or dropped.
4. **Legible** — spatial layout (where in the address space) and temporal
   layout (when, and in what order) are both first-class and shown
   simultaneously.

## The three coordinated views

```
┌───────────────────────────────────────────────────────────────┐
│  TEMPORAL TIMELINE     x = wall-clock time (t)                │  ← top strip
├───────────────────────────────────────────────────────────────┤
│  SEQUENTIAL TIMELINE   x = event index (seq)                  │  ← 2nd strip
├───────────────────────────────────────────────────────────────┤
│  ADDRESS-LINE          rows of row_bytes each; empty rows     │  ← main view
│                        collapse into thin gap markers         │
└───────────────────────────────────────────────────────────────┘
                        ▲ one playhead shared by all three
```

The two strips are two projections of the same events — temporal uses `t`,
sequential uses `seq`; nothing else differs. They diverge exactly when event
density is uneven in time: 100 allocations packed into 1 ms collapse into a
thin sliver on the temporal strip (you *see* the burst) while staying evenly
spaced on the sequential strip (you *see* the order and count). Seeking on
either strip seeks all three views. See [05-timelines](05-timelines.md).

## Terminology

| Term | Meaning |
|------|---------|
| **Event** | One record in the stream: a malloc, a free, or a realloc. |
| **Creator event** | An `M` or `R` event — one that brings an allocation to life. Allocations are identified internally by their creator's event index. |
| **Allocation** | A live region `[addr, addr + size)` produced by a creator event. |
| **id** | A stream-unique integer naming one allocation, so frees can reference it. Wire-format concept; internally resolved to event indices at load. |
| **seq** | Monotonic 0-based index of an event = its position in the stream. The canonical internal coordinate. |
| **t** | Timestamp of an event, in the stream's time unit (default nanoseconds). |
| **Live set** | The set of allocations created and not yet freed at a given point. |
| **row_bytes** | How many bytes one address-line row spans. Viewer setting, default `0x1000`. |
| **Playhead** | The current point in the trace, expressed as a `seq` (or a `t` mapped to one). "Playhead at seq *n*" means *n* events have been applied. |
| **Tag / name / mark** | User-authored analysis state layered on top of the trace; never part of the wire format. |

## System shape

Three layers, one direction of authority (details in
[08-architecture](08-architecture.md)):

- **`src/core/` — Rust WASM engine.** Owns the parsed trace, the playhead, layout,
  and all pixel generation. Plain C ABI, no wasm-bindgen, no JS framework.
- **`src/web/worker.js` — Web Worker.** Owns the WASM instance and the three
  `OffscreenCanvas`es; runs the frame loop and playback clock. The single
  writer of canvas pixels.
- **`src/web/main.js` + `index.html` — main thread.** DOM chrome, input, overlays,
  panels, persistence. Talks to the worker only via messages.

Supporting tools: `gen.py` (deterministic synthetic trace generator) and the
build scripts (see [10-tooling](10-tooling.md)).
