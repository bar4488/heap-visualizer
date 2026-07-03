# heap-visualizer — Heap Allocation Visualizer Specification

---

## 1. Overview & Goals

heap-visualizer visualizes the life of a program's heap. It consumes a **stream of allocation and
free events** and renders them on an **address-line**: a 2D map of the address space where
memory that is currently allocated is drawn as filled cells. A time control lets the user
**time-travel** to any point in the trace and see exactly what was live then.

Design goals, in priority order:

1. **Fast** — smooth interaction on traces with millions of events. Rendering happens in
   WebAssembly + canvas/WebGL; the JS/DOM layer only handles chrome and input.
2. **Portable** — runs fully client-side in a browser. A trace file
   is dropped in and rendered.
3. **Faithful** — the picture at time *T* is exactly the set of live allocations at *T*,
   reconstructed deterministically from the stream.
4. **Legible** — spatial layout (where in the address space) and temporal layout (when, and
   in what order) are both first-class and shown simultaneously.

### 1.1 The three coordinated views

```
┌───────────────────────────────────────────────────────────────┐
│  TEMPORAL TIMELINE     x = wall-clock time (t)                  │  ← top strip
│  ▏ █ ▏  █▏█▏  ▏          ▏█ ▏     █▏  ▏  ▏█▏▏▏▏▏▏  ▏   █          │
├───────────────────────────────────────────────────────────────┤
│  SEQUENTIAL TIMELINE   x = event index (seq)                   │  ← 2nd strip
│  ▏█▏█▏█▏ ▏█▏ █▏█▏█▏ ▏█▏█▏█▏█▏ █▏█▏ ▏█▏█▏█▏ ▏█▏ █▏█▏ █▏█▏ █▏█▏   │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  ADDRESS-LINE          rows of row_bytes each, empty collapse  │  ← main view
│  0x...000 ████░░░░████████░░░░░░░░████                          │
│  0x...040 ░░░░████░░░░░░░░████████████                          │
│   ⋮ (collapsed empty rows)                                     │
│  0x...a00 ████████████░░░░████                                 │
│                                                                │
└───────────────────────────────────────────────────────────────┘
                       ▲ playhead (shared by all three views)
```

The **temporal timeline** and the **sequential timeline** differ precisely when event
density is uneven in time. Example: 100 allocations packed into 1ms, then 2 allocations
spread over the next 1ms.

- On the **temporal** strip (x = time) the 100 dense events pile into a thin sliver and the
  2 sparse events are far apart — you *see* the burst.
- On the **sequential** strip (x = index) all 102 events are evenly spaced — you *see* the
  order and count, not the timing.

Both strips share a single playhead. Seeking on either seeks all three views.

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Event** | One record in the stream: an allocation, a free, or a realloc. |
| **Allocation** | A live region `[addr, addr + size)` produced by a malloc/realloc event. |
| **id** | A stream-unique integer naming one allocation, so frees can reference it. |
| **seq** | Monotonic 0-based index of an event = its position in the stream. |
| **t** | Timestamp of an event, in the stream's time unit (default nanoseconds). |
| **Live set** | The set of allocations that are allocated-and-not-yet-freed at a given point. |
| **row_bytes** | How many bytes one row of the address-line spans. Viewer config, default `0x1000`. |
| **Playhead** | The current point in the trace, expressed either as a `t` or a `seq`. |

---

## 3. Event Stream Format (JSONL)

The stream is **JSON Lines**: UTF-8 text, **one JSON object per line**, `\n`-separated.
This is the v1 wire format — human-readable, greppable, hand-writable, and streamable.

Conventional file extension: **`.heapl`** (content is JSONL).

### 3.1 General rules

- Each line is a complete, self-contained JSON object. No line spans multiple physical lines.
- **Field order within an object is not significant.** Parsers must not depend on it.
- Objects **may** carry fields not defined here; consumers **must** ignore unknown fields.
  This is the forward-compatibility mechanism — new metadata never breaks old viewers.
- Numbers (`t`, `size`, `seq`, `id`, `thr`) are JSON integers.
- **Addresses are strings** (`"0x555555550000"`), because a 64-bit address does not fit
  safely in a JSON double. Hex, `0x`-prefixed, lowercase. The viewer parses them as u64.
- Empty lines and lines beginning with `#` (after optional whitespace) are ignored, to
  allow comments and blank separators in hand-authored files.

### 3.2 Record types (`op`)

Every record has an `op` field naming its type:

| `op` | Meaning |
|------|---------|
| `H`  | **Header** — stream metadata. See §3.3. |
| `M`  | **Malloc** — a new allocation becomes live. See §3.4. |
| `F`  | **Free** — an existing allocation ends. See §3.5. |
| `R`  | **Realloc** — one allocation ends and a new one begins. See §3.6. |

### 3.3 Header record `H`

The header **should** be the first line. At most one header per stream. It carries stream-wide
metadata and viewer hints.

```json
{"op":"H","v":1,"unit":"ns","arena_base":"0x555555550000","row_bytes":4096,"title":"seed=1"}
```

| Field | Req | Type | Meaning |
|-------|-----|------|---------|
| `op` | ✓ | `"H"` | Record type. |
| `v` | ✓ | int | Format version. This spec is version `1`. |
| `unit` | — | string | Time unit of every `t`: `"ns"` (default), `"us"`, `"ms"`, `"s"`, or `"tick"`. Display only; does not change ordering. |
| `arena_base` | — | string | Lowest address the viewer should expect. A layout hint; the viewer still auto-fits to observed addresses. |
| `row_bytes` | — | int | Suggested default row width. The viewer's own control overrides this; it is only a starting value. |
| `title` | — | string | Human label for the trace, shown in the viewer chrome. |
| `meta` | — | object | Free-form producer metadata (command line, hostname, allocator name, …). |

If no header is present, consumers assume `v:1`, `unit:"ns"`, and auto-fit the address range.

### 3.4 Malloc record `M`

An allocation `[addr, addr + size)` becomes live.

```json
{"seq":42,"t":10500,"op":"M","id":17,"addr":"0x555555551240","size":128,"thr":0,"site":"json_node"}
```

| Field | Req | Type | Meaning |
|-------|-----|------|---------|
| `op` | ✓ | `"M"` | Record type. |
| `id` | ✓ | int | Stream-unique allocation id. Never reused, even after the allocation is freed. |
| `addr` | ✓ | string | Base address (u64 hex string). |
| `size` | ✓ | int | Size in bytes (the *requested* size; see §4.3 on alignment/overhead). Must be `> 0`. |
| `t` | rec | int | Timestamp. Required in practice; if absent, treated as equal to the previous event's `t`. |
| `seq` | — | int | Event index. If absent, the consumer assigns it from line position. See §3.7. |
| `thr` | — | int | Originating thread id. |
| `site` | — | string | Allocation-site tag (function name, symbol, or stack-hash). Drives coloring/filtering. |
| `stack` | — | array | Optional call stack, outermost-last, as strings. |

### 3.5 Free record `F`

An allocation ends. It **must** reference the allocation by `id`.

```json
{"seq":57,"t":11020,"op":"F","id":17,"addr":"0x555555551240","size":128,"thr":0}
```

| Field | Req | Type | Meaning |
|-------|-----|------|---------|
| `op` | ✓ | `"F"` | Record type. |
| `id` | ✓ | int | The id of the allocation being freed (from its `M`/`R` record). |
| `t` | rec | int | Timestamp of the free. |
| `seq` | — | int | Event index. |
| `addr` | — | string | Redundant convenience copy of the freed base address. |
| `size` | — | int | Redundant convenience copy of the freed size. |
| `thr` | — | int | Thread performing the free. |

`addr` and `size` are **optional and redundant** — the authoritative geometry comes from the
matching `M`/`R` record. Producers should include them (cheap, and lets a viewer render a
free without a fully built id→allocation map); consumers must not require them.

**`free(NULL)` / no-op frees** carry no `id` of a live allocation and **should simply be
omitted** from the stream. If a producer must record them, it emits `id:0` (the reserved
null id) which consumers ignore for rendering.

### 3.6 Realloc record `R`

Models `realloc`: the old allocation ends and a new one begins (possibly at a new address,
possibly the same). Emitting a single `R` (rather than an `F`+`M` pair) preserves the *move*
relationship so the viewer can draw a link/animation between old and new regions.

```json
{"seq":88,"t":12030,"op":"R","id":40,"old_id":17,"addr":"0x555555560000","size":512,
 "old_addr":"0x555555551240","old_size":128,"thr":0,"site":"json_node"}
```

| Field | Req | Type | Meaning |
|-------|-----|------|---------|
| `op` | ✓ | `"R"` | Record type. |
| `id` | ✓ | int | id of the **new** allocation (fresh, never reused). |
| `old_id` | ✓ | int | id of the allocation being replaced. It becomes dead at this event. |
| `addr` | ✓ | string | New base address (may equal `old_addr` for an in-place grow/shrink). |
| `size` | ✓ | int | New size in bytes. |
| `old_addr` | — | string | Convenience copy of the old base address. |
| `old_size` | — | int | Convenience copy of the old size. |
| `t`,`seq`,`thr`,`site`,`stack` | — | | As for `M`. |

Semantics equivalent to: free `old_id`, then malloc a new region as `id`, atomically at this
`seq`/`t`. A viewer that does not care about the move relationship may treat `R` as exactly
that pair.

### 3.7 Ordering, `seq`, and timestamps

- **Stream order is authoritative.** Events are applied in the order they appear. `seq`, if
  present, must equal the 0-based line index among event (non-comment, non-header) records
  and must be strictly increasing; if absent the consumer assigns it. The **sequential
  timeline** is exactly this `seq` axis.
- **Timestamps are monotonic non-decreasing** (`t[i+1] >= t[i]`). Ties are allowed and are
  the whole point of the two-timeline design: many events sharing one `t` form a burst that
  the temporal view compresses and the sequential view spreads out. A consumer encountering
  a decreasing `t` should clamp it to the previous value and may warn.
- The two timelines are two projections of the same events: temporal uses `t`, sequential
  uses `seq`. Nothing else differs.

### 3.8 Validity rules

Should render overlapping traces / double frees and so on (flag if necessary)

---

## 4. Data & Semantic Model

### 4.1 The live set

At any point in the stream, the **live set** is the set of allocations that have been
created and not yet freed. Applying events left-to-right:

- `M{id,addr,size}` → add `id ↦ (addr,size,meta)` to the live set.
- `F{id}` → remove `id` from the live set.
- `R{id,old_id,addr,size}` → remove `old_id`, add `id ↦ (addr,size,meta)`.

The picture the viewer draws at a playhead position is **the live set at that position** —
nothing more. This makes the rendering a pure function of (stream, playhead).

### 4.2 Time travel

Seeking to a target (by `t` or by `seq`) means: reconstruct the live set as of that point.

- **Forward seek** replays events from the current position to the target.
- **Backward seek** cannot simply "undo" cheaply if we only stored forward deltas, so the
  viewer maintains **periodic snapshots** (checkpoints) of the live set — e.g. every *N*
  events or every *K* live-set mutations. To reach target *X*: jump to the nearest snapshot
  ≤ *X*, then replay forward to *X*. This bounds seek cost to *O(snapshot interval)*
  regardless of trace length. Snapshot interval is a viewer tuning parameter, not part of
  the stream.
- Seeking by `t` first maps `t` to the `seq` of the last event with `t' <= t` (binary search
  over the monotonic `t` array), then seeks by `seq`. So `seq` is the canonical internal
  coordinate; `t` is a lookup into it.

### 4.3 Requested size vs. real footprint

`size` is the **requested** size. Real allocators round up (alignment, size classes) and add
header overhead, so the true footprint is usually larger and allocations are spaced apart.
v1 renders the requested `[addr, addr+size)` only. A producer that knows the real usable size
may add an optional `usable` field (int, bytes); the viewer may render it as a lighter "slack"
band after the requested region. Consumers ignore `usable` if unsupported.

---

## 5. Visualization Model

### 5.1 The address-line

The address space is drawn as a grid:

- The viewer picks a **base** `B` (lowest address to show; from observed data or `arena_base`)
  and a **row width** `row_bytes` `W` (default `0x1000`, changeable live).
- An address `A` maps to **row** `floor((A − B) / W)` and **column offset** `(A − B) mod W`.
- Within a row, bytes run **left → right**; rows stack **top → bottom**. So reading order is
  the natural address order, like a hex dump.
- An allocation `[addr, addr+size)` fills the cells it covers, wrapping across rows if it
  spans a row boundary.

**Empty-row collapsing.** Address spaces are sparse (mmap'd arenas far apart, huge gaps). A
row containing **no live allocation** at the current playhead is **collapsed** to a thin
gap-marker (e.g. a 1–2px ellipsis rule) instead of a full-height empty row. This keeps the
picture dense and scrollable even across terabyte-wide address ranges. Collapsing is
recomputed per playhead position (a row empty now may be full later). The set of non-empty
rows is derived from the live set — an interval set over rows.

**Changing `row_bytes` live.** The control re-buckets addresses into rows on the fly. Powers
of two keep column offsets aligned to nice boundaries; the default `0x1000` matches a typical
page so page-level fragmentation reads naturally.

### 5.2 Coloring

Base semantics fixed by this spec so traces read consistently across viewers:

- **Green** = an allocation event (a region becoming live) — used on the timelines to mark
  `M`/`R` events, and as the default fill tint for live regions.
- **Red** = a free event — used on the timelines to mark `F` and the freeing half of `R`.
- **Collapsed/empty** = neutral gap marker.

Beyond that base, the address-line fill **may** be tinted by a secondary dimension the user
picks: by `site`, by `thr`, by `size` bucket, or by age (how long the region has been live at
the playhead). This is a viewer feature; use a categorical palette for `site`/`thr` and a
sequential ramp for `size`/age. (See the project's data-viz guidance when choosing palettes.)

### 5.3 The two top timelines

Both strips span the full width and share the playhead. Each event contributes a tick,
colored green (`M`/`R`) or red (`F`).

- **Temporal timeline** — x is `t`, linearly scaled from `t_min` to `t_max`. Bursts bunch up;
  idle gaps show as empty stretches. Answers *"when did this happen, and how bursty is it?"*
- **Sequential timeline** — x is `seq`, evenly spaced. Answers *"in what order, and how many?"*

The canonical illustration: 100 allocations in 1ms, then 2 in the next 1ms.

- Temporal: the 100 collapse into a narrow green band (they share almost the same `t`); the 2
  sit far to the right, widely spaced. Same-`t` events get the same x — the first two "look
  the same size" because x is time.
- Sequential: all 102 are evenly spaced; the 2 late allocations are just the last two ticks —
  they do **not** look the same, because x is index.

Density is drawn by binning into columns and summing (a histogram/heat strip) so millions of
events still render at one tick-per-pixel. Hovering a column shows count and the `t`/`seq`
range it covers. Clicking or dragging moves the playhead.

### 5.4 Interaction summary

| Action | Result |
|--------|--------|
| Drag playhead on either timeline | Seek all three views to that `t` (temporal) or `seq` (sequential). |
| Play / pause | Advance the playhead in real time (by `t`) or step-by-step (by `seq`). |
| Change `row_bytes` | Re-bucket the address-line rows live. |
| Hover an allocation | Tooltip: `id`, addr range, size, site, thread, age, birth `t`/`seq`. |
| Filter by `site`/`thr`/size | Dim or hide non-matching allocations everywhere. |
| Jump to event | Center the address-line on the allocation an event touches. |

---

## 6. Viewer Architecture (informative, non-normative)

Not implemented in this phase; recorded so the format choices above stay justified.

- **Load:** parse JSONL → columnar typed arrays (`t: BigInt64Array`, `size: Int32Array`,
  `addr: BigUint64Array`, `op`, `id`, …). Parsing/geometry live in WASM (Rust or C++);
  JSON parsing of large files may stream. Addresses parse from hex strings to u64 once, at
  load, and are never strings again internally.
- **Index:** build the `seq→t` array (already sorted) for time↔index mapping, and periodic
  live-set **snapshots** for O(1)-ish seeking (§4.2).
- **Render:** the live set at the playhead → row interval-set → GPU draw (canvas2d for v1,
  WebGL/WebGPU instanced quads for scale). The two timelines are pre-binned density textures
  regenerated only when the viewport/zoom changes.
- **Threading:** heavy work (parse, snapshot, seek-replay) in a Web Worker; the main thread
  stays responsive.
- **Why JSONL now:** debuggability and zero-tooling authoring dominate at this stage; parse
  cost is a one-time load, hidden in a worker. A fixed-width **binary** format (const-size
  little-endian records: `u64 t, u8 op, u64 id, u64 addr, u64 size, …`) is the natural next
  step once load time on huge traces matters — it is a pure encoding change, semantics
  unchanged, so nothing above needs to move.

---
