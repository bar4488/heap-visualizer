# heap-visualizer — Program-Trace Analyzer Specification (v2)

> v2 supersedes v1 (merged from `docs/spec-v2-draft.md` after the followup
> notes). The project is in beta: v2 breaks the v1 format freely and carries
> no compatibility machinery. Old traces are regenerated or converted.
> Deferred: rendering invalid frees at their address ("ghost flash"), and
> renaming the repo/tool from *visualizer* to *analyzer* (after the views
> work lands).

---

## 1. Overview & Goals

heap-visualizer consumes a **program trace** — a stream of events in which
heap events (malloc/free/realloc) are one kind among several (spans, logs) —
and lets the user analyze it through coordinated **views**. The address-line
(a 2D map of the address space where live memory is drawn as filled cells)
is one view among peers. A time control lets the user **time-travel** to any
point in the trace and see exactly what was live then.

Design goals, in priority order:

1. **Fast** — smooth interaction on traces with millions of events. Rendering
   happens in WebAssembly + canvas; the JS/DOM layer only handles chrome and
   input.
2. **Portable** — runs fully client-side in a browser. Projects live in a
   local directory (File System Access API, or the local bridge for browsers
   without it).
3. **Faithful** — the picture at time *T* is exactly the set of live
   allocations at *T*, reconstructed deterministically from the stream.
4. **Legible** — spatial layout (where in the address space) and temporal
   layout (when, and in what order) are both first-class and shown
   simultaneously.

### 1.1 Principles that drive the format

1. The stream is a general **program trace** — heap events are one record
   kind among several; the address-line is one *view* among several.
2. The format sheds everything a consumer can derive (`seq`, `id`) — records
   carry only what the producer uniquely knows.
3. The tool is a **project editor**, not a drop-target for single files
   (drop stays as the quick-look path).

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Event** | One record in the stream: heap event (`M`/`F`/`R`), span begin/end (`B`/`E`), or log (`L`). |
| **Allocation** | A live region `[addr, addr + size)` produced by a malloc/realloc event. |
| **Event index** | 0-based position of an event in the (merged) stream. Assigned by the consumer at parse; deterministic on every reparse of the same file set. |
| **Birth index** | An allocation's internal handle: the event index of its creating `M`/`R`. Unique, stable, deterministic — `.heapa` names/tags/colors key allocations by it. |
| **t** | Timestamp of an event, in the stream's time unit (default nanoseconds). |
| **Live set** | The set of allocations that are allocated-and-not-yet-ended at a given point. |
| **Lane** | One strip of the timeline stack; lane = axis × content (§6). |
| **Playhead** | The current position (event index; `t` maps onto it). |
| **Run** | One execution of the traced program: one or more `.heapl` streams merged by `t` (§5). |

---

## 3. Event Stream Format (JSONL, v2)

The stream is **JSON Lines**: UTF-8 text, one JSON object per line,
`\n`-separated. Conventional file extension: **`.heapl`**.

### 3.1 General rules

- Each line is a complete, self-contained JSON object.
- Field order within an object is not significant.
- Objects **may** carry fields not defined here; consumers ignore unknown
  fields and surface them as extra detail where sensible.
- Unknown `op` values are skipped (robustness, not a compatibility promise).
- Numbers (`t`, `size`, `thr`) are JSON integers.
- **Addresses are strings** (`"0x555555550000"`) — a 64-bit address does not
  fit safely in a JSON double. Hex, `0x`-prefixed, lowercase.
- Empty lines and lines beginning with `#` (after optional whitespace) are
  ignored.
- **There is no `seq` and no `id`.** Stream order is authoritative; the
  consumer assigns event indices at parse. Frees name allocations by
  address (§3.4).

### 3.2 Record types (`op`)

| `op` | Meaning |
|------|---------|
| `H`  | Header — stream metadata. |
| `M`  | Malloc — a new allocation becomes live. |
| `F`  | Free — the live allocation based at `addr` ends. |
| `R`  | Realloc — the live allocation based at `old_addr` ends; a new one begins. |
| `B`  | Span begin (§3.5). |
| `E`  | Span end. |
| `L`  | Log record (§3.6). |

### 3.3 Header record `H`

Should be the first line; at most one per stream.

```json
{"op":"H","v":2,"unit":"ns","arena_base":"0x555555550000","row_bytes":4096,"title":"seed=1"}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `v` | ✓ | Format version; this spec is `2`. The viewer rejects other versions with a clear message (a plain sanity field, not compat machinery). |
| `unit` | — | Time unit of every `t`: `"ns"` (default), `"us"`, `"ms"`, `"s"`, `"tick"`. Display only. |
| `arena_base` | — | Layout hint; the viewer still auto-fits. |
| `row_bytes` | — | Suggested default row width. |
| `title` | — | Human label shown in the chrome. |
| `meta` | — | Free-form producer metadata. |

No header ⇒ `v:2`, `unit:"ns"`, auto-fit.

### 3.4 Heap records `M` / `F` / `R`

```json
{"op":"M","t":10500,"addr":"0x555555551240","size":128,"thr":0,"site":"json_node"}
{"op":"F","t":11020,"addr":"0x555555551240","thr":0}
{"op":"R","t":12030,"old_addr":"0x555555551240","addr":"0x555555560000","size":512,"thr":0}
```

| `op` | Required | Optional |
|------|----------|----------|
| `M` | `addr`, `size` | `t`, `thr`, `site`, `stack`, `usable` |
| `F` | `addr` | `t`, `thr` |
| `R` | `old_addr`, `addr`, `size` | `t`, `thr`, `site`, `stack`, `usable` |

- `t` is "required in practice": absent means *same as the previous event of
  this stream*.
- The live set guarantees **at most one live allocation per base address**,
  so the address is the key — exactly what `free(ptr)` receives. `F` names
  the allocation by `addr`; `R` names the old one by `old_addr`. `F` carries
  no redundant `size` — geometry comes from the live set.
- The consumer assigns each allocation its **birth index** at parse.
- `size` is the requested size and must be `> 0` (zero/missing is flagged
  and rendered as 1 byte). A producer that knows the real usable size may
  add `usable` (rendered as a slack band).

**Anomalies instead of errors.** Producer bugs are *detectable and
showable*, not unparseable:

- `F`/`R` naming an address with no live allocation → **invalid free**
  anomaly; the live set is untouched.
- `M`/`R` overlapping live allocations → **overlap** anomaly; the new
  allocation wins and every overlapped allocation is **implicitly ended** at
  that event.

Anomalies are collected and surfaced (click-to-seek list; an anomaly view is
part of the views model, §6).

### 3.5 Span records `B` / `E` — one concept, three uses

```json
{"op":"B","t":12100,"name":"parse_json","thr":0}
{"op":"E","t":15800,"thr":0}
{"op":"B","t":20000,"name":"frame"}
{"op":"E","t":29000}
```

| Field | `B` | `E` | Meaning |
|-------|-----|-----|---------|
| `name` | ✓ | opt | Span label. On `E`: cross-check against the span being closed (mismatch → warn, close anyway). |
| `thr` | opt | opt | **Present** → the span belongs to that thread's lane and nests within it. **Absent** → the span is *global* (whole-program lane). There is no separate "phase" concept — a global span *is* the program-phase / frame / request marker. |
| `t` | rec | rec | As for heap events. |
| `args` | opt | — | Free-form payload shown on hover/detail. |

Matching rules — any producer sloppiness still renders sensibly:

- `E` closes the **innermost open span on its lane** (lane = its `thr`, or
  the global lane).
- `E` with an empty lane stack: the span is treated as having begun **before
  the trace started** — it renders from the first event to this `E`, named
  by the `E`'s `name`. An `E` with no open span and no `name` is ignored.
- Spans still open at end-of-stream extend to the last event.
- Nesting is required only within a lane; lanes are independent.

The three uses:

1. **Profiling** (`thr` present): function enter/exit. A heap event on
   thread `thr` is attributed to the span stack open on that lane at its
   index — color-by-caller, filter-by-caller, top-allocators-by-path,
   without per-event `stack` arrays.
2. **Program phases** (`thr` absent): frames, requests, GC cycles. Repeating
   names form a series the viewer steps/zooms through; filters can scope to
   ("during `frame`").
3. **Analysis annotation** (not in the stream): the user creates spans in
   the analysis layer (`.heapa`) — same shape (name, lane, start/end index),
   rendered in the same lanes (including thread lanes), visually
   distinguished (dashed border). Time marks remain the degenerate point
   case.

### 3.6 Log record `L`

```json
{"op":"L","t":12110,"lvl":"error","msg":"connection timeout fd=7","thr":2,"fields":{"fd":7}}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `msg` | ✓ | The log line. |
| `lvl` | — | `trace`/`debug`/`info`/`warn`/`error`/`fatal`; default `info`; unknown → `info`. |
| `thr` | — | Emitting thread. |
| `src` | — | Origin hint (`"server.c:412"`, logger name). |
| `fields` | — | Structured key→scalar payload; searchable/filterable. |

Logs never mutate state: ticks on timeline lanes, rows in the events view,
searchable, click-to-seek. Existing program logs enter via the **log
importer**: a timestamp pattern turns a plain log file into an `L`-only
sidecar (per-file import settings live in `project.json`).

### 3.7 Ordering and timestamps

- **Stream order is authoritative.**
- `t` is monotonic non-decreasing; a decreasing `t` is clamped to the
  previous value (warn). Ties are expected — they are what the sequential
  axis is for.

---

## 4. Data & Semantic Model

### 4.1 The live set

Applying events left-to-right:

- `M{addr,size}` → add the allocation; implicitly end any live allocation it
  overlaps (anomaly).
- `F{addr}` → end the live allocation based at `addr` (none → anomaly,
  no-op).
- `R{old_addr,addr,size}` → end the one at `old_addr`, add the new one
  (overlap rule applies).
- `B`/`E`/`L` → never touch the live set.

The picture at a playhead position is the live set at that position —
rendering is a pure function of (stream, playhead).

### 4.2 Time travel

Seeking reconstructs the live set at the target event index. The viewer
keeps periodic snapshots so backward/far seeks cost *O(snapshot interval)*;
implicit ends (overlap victims) replay correctly in both directions. Seeking
by `t` maps to the last event with `t' <= t` first; the event index is the
canonical internal coordinate.

### 4.3 Requested size vs. real footprint

`size` is the requested size; `usable` (optional) may be larger and renders
as a lighter slack band after the requested region.

---

## 5. Project model

Dropping a file stays as the quick-look path; the primary experience is a
**project** — the tool opens like an editor.

- A project is a **directory** the user picks once. The landing screen lists
  recent projects. Two directory transports, one interface:
  - **File System Access API** (Chromium): fully client-side.
  - **Local bridge** (`bridge/heapviz-bridge.py`) for browsers without it:
    a stdlib-only localhost server exposing the same read/write operations,
    token-protected, bound to 127.0.0.1.
- Files group into **runs**. A run is one execution of the traced program:
  one or more `.heapl` streams (interposer output, app-emitted spans/logs)
  plus imported plain logs. **Opening a run merges its files by `t`**
  (stable; per-file order preserved on ties; earlier file wins ties). Event
  indices are assigned over the merged stream — this is why `seq` had to
  leave the wire format: producer-side indices can't survive a merge.
- **`project.json`** at the root is the explicit, hand-editable manifest:
  runs and their member files, per-file import settings (log timestamp
  pattern), viewer defaults. If absent on first open, it is generated by a
  scan (top-level `.heapl` files → one run each; a subdirectory with
  `.heapl` files → one run merging them) and written.
- **Analysis is auto-persisted.** Each run owns a `.heapa` in the project
  (auto-paired, auto-saved on change). The `.heapa` also stores the run's
  window layout, so reopening a run restores the whole workspace.
- **Quick-look** (bare `.heapl`, no project) is fully ephemeral; on request
  ("Save as project…") the trace is copied into a chosen directory together
  with `project.json` and the current analysis.
- Producers of one run must share a clock and `unit`. Allocation addresses
  live only in the interposer stream, so the common split (heap file + log
  file + span file) merges without cross-file identity concerns.

`.heapa` references events by event index and allocations by birth index —
both deterministic over the merged stream.

## 6. Analyzer architecture: views and lanes

**One document, many views.** A run parses into a single document: the
event stream, derived state (live set, span table, anomalies), and the
analysis layer (tags, names, marks, analysis spans, filters). Every open
window is a **view** — a projection of that document. Views coordinate
through exactly three shared objects:

| Shared state | Meaning |
|--------------|---------|
| **Playhead** | Current position (event index; `t` maps onto it). |
| **Filter** | The active predicate; every view shows/dims by it. |
| **Selection** | The allocation/event/span currently in focus. |

A view never talks to another view — only to the document and the shared
state. That contract is what makes new views cheap.

**Views (initial set, extensible):**

| View | Projection |
|------|-----------|
| **Address-line** | The live set at the playhead, spatially. *(one view among peers)* |
| **Events** | The stream as a virtualized list. |
| **Flame** | Span stacks over an axis, per lane. |
| **Anomalies** | Invalid frees / overlaps, click-to-seek. |
| *(future)* **Lifetime** | Allocations as bars from birth to death (gantt). |
| *(future)* **Stats** | Derived series: live bytes, alloc rate, by tag/site. |

**Lanes.** The timeline strip is a stack of **lanes**; a lane =
**axis × content**:

- **Axis:** `temporal` (x = t) or `sequential` (x = event index) — an
  attribute of a lane, not a pair of hardcoded strips.
- **Content:** event density, spans (flame ribbon: global lane, per-thread
  lanes), log ticks (level-colored), tag lane.

The default lane set is density×temporal + density×sequential. Users
add/remove/reorder lanes; a run with no spans never shows a span lane; the
lane set persists in the run's `.heapa`. All lanes share the playhead and
drag-to-seek. Analysis spans may be created on the global lane *and* on
thread lanes.

### 6.1 The address-line view

Unchanged from v1 in substance: rows of `row_bytes` each, address order like
a hex dump, empty-row collapsing (with pinned rows for marks), live
`row_bytes` re-bucketing, horizontal zoom.

### 6.2 Coloring

- **Green** = allocation events / live regions; **red** = frees. Beyond
  that, fills may be tinted by `site`, `thr`, size bucket, age, or tag
  (categorical palette for site/thr/tag, sequential ramp for size/age).
- Log ticks color by level.

### 6.3 Interaction summary

| Action | Result |
|--------|--------|
| Drag playhead on any lane | Seek every view (by `t` or event index per the lane's axis). |
| Play / pause | Advance the playhead in real time or step-by-step. |
| Hover an allocation | Tooltip: birth index, addr range, size, site, thread, age, birth t. |
| Filter | Dim or hide non-matching allocations everywhere. |
| Jump to event | Center the address-line on the allocation an event touches. |
| Shift-drag a range | Create an analysis span / tag / crop from the range. |

---

## 7. Viewer Architecture (informative)

- **Load:** parse JSONL → columnar typed arrays in WASM (Rust); addresses
  parse from hex strings to u64 once at load. Runs feed multiple files;
  records stage per file and merge by `t` before indices are assigned.
- **Index:** the event-index→t array for time↔index mapping; periodic
  live-set snapshots for seeking; span table; kill list for implicit ends.
- **Render:** live set → row interval-set → raster in WASM; timelines are
  pre-binned density strips.
- **Threading:** heavy work (parse, seek-replay, raster) in a Web Worker.
- **Why JSONL still:** debuggability and zero-tooling authoring dominate; a
  fixed-width binary encoding remains a pure encoding change if load time on
  huge traces starts to matter.
