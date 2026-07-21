# heap-analyzer — v2 draft 2 (changes only)

**Status: DRAFT 2 for review.** Supersedes draft 1 after the followup notes
(`spec-v2-followup.md`). Contains only *changes* against `SPECIFICATION.md`;
merged in on acceptance.

**Stance:** the project is in beta — this draft breaks the v1 format freely and
does not carry compatibility machinery. Old traces are regenerated or converted
with a one-off script; the spec describes the product we want, not a migration.

**Theme:** the project moves from heap *visualizer* to program-trace
**analyzer**. Three consequences drive everything below:

1. The stream is a general **program trace** — heap events are one kind among
   several; the address-line is one *view* among several.
2. The format sheds everything a consumer can derive (`seq`, `id`) — records
   carry only what the producer uniquely knows.
3. The tool becomes a **project editor**, not a drop-target for single files.

---

## Part I — Format changes

### I.1 Removed: `seq`

`seq` was always required to equal the line position — pure redundancy. It is
**removed from the wire format**. Stream order is the authoritative order; the
consumer assigns event indices at parse. The sequential axis, `seq`-based
seeking, the jump box, and `.heapa` references all keep working — event index
is now purely an internal, deterministic coordinate (identical on every reparse
of the same file set).

Ordering rules that remain (all of §3.7 collapses to this):

- Stream order is authoritative.
- `t` is monotonic non-decreasing; a decreasing `t` is clamped to the previous
  value (warn). Ties are expected and are what the sequential axis is for.

### I.2 Removed: allocation `id` (frees reference by address)

`id` forced producers to maintain a global counter and a pointer→id map —
state a malloc interposer doesn't naturally have. But the live set already
guarantees that **at most one live allocation has a given base address**, so
the address *is* the key — exactly the information `free(ptr)` receives.

- `F` names the allocation by `addr`.
- `R` names the old allocation by `old_addr`.
- The consumer assigns each allocation an internal handle at parse (its birth
  event index — unique, stable, deterministic). `.heapa` names/tags/colors key
  allocations by birth index instead of `id`.

Revised heap records (everything not listed is dropped):

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

(`t` stays "required in practice": absent means same as previous event. `F`
no longer carries redundant `size` — geometry comes from the live set.)

**Anomalies instead of errors.** With address-keying, producer bugs become
*detectable and showable* rather than unparseable:

- `F` with no live allocation at `addr` → **invalid free** anomaly.
- `M`/`R` overlapping a live allocation → **overlap** anomaly (the new
  allocation wins; the overlapped one is marked implicitly-ended).

Anomalies are collected and surfaced (an anomaly list is itself a view — see
Part III); this replaces the v1 §3.8 stub.

### I.3 New: span records `B` / `E` — one concept, three uses

```json
{"op":"B","t":12100,"name":"parse_json","thr":0}
{"op":"E","t":15800,"thr":0}
{"op":"B","t":20000,"name":"frame 152"}
{"op":"E","t":29000}
```

| Field | `B` | `E` | Meaning |
|-------|-----|-----|---------|
| `name` | ✓ | — | Span label. On `E`: optional cross-check against the span being closed (mismatch → warn, close anyway). |
| `thr` | — | — | **Present** → the span belongs to that thread's lane and nests within it. **Absent** → the span is *global* (whole-program lane). No separate "phase" concept — a global span *is* the program-phase / frame / request marker. |
| `t` | rec | rec | As for heap events. |
| `args` | — | — | Free-form payload shown on hover/detail. |

Matching rules — designed so any producer sloppiness still renders sensibly:

- `E` closes the **innermost open span on its lane** (lane = its `thr`, or the
  global lane).
- `E` with an **empty lane stack**: the span is treated as having begun **before
  the trace started** — it renders from the first event to this `E`, named by
  the `E`'s `name` (an `E` with no open span and no `name` is ignored).
- Spans still open at end-of-stream extend to the last event.
- Nesting is required only *within a lane*; lanes are independent.

The three uses of the same concept:

1. **Profiling** (`thr` present): function enter/exit. A heap event on thread
   `thr` is attributed to the span stack open on that lane at its index —
   giving color-by-caller, filter-by-caller, and top-allocators-by-path without
   per-event `stack` arrays.
2. **Program phases** (`thr` absent): frames, requests, GC cycles. Repeating
   names form a series the viewer steps/zooms through, and filters can scope
   to ("during `frame`").
3. **Analysis annotation** (not in the stream at all): the user shift-drags a
   range and creates a span *in the analysis layer* (`.heapa`). Analysis spans
   have the same shape (name, lane, start/end index) and render in the same
   lanes, visually distinguished (e.g. dashed border). Time marks remain the
   degenerate point case.

### I.4 New: log record `L`

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
searchable, click-to-seek. Existing program logs enter via the **log importer**
(Part II): a timestamp pattern turns a plain log file into an `L`-only sidecar.

### I.5 Dropped from draft 1

- **`P` phase records** — subsumed by global spans (I.3).
- **`C` counter records** — no current problem needs them; derived series
  (live bytes, alloc rate) come from the data we already have, as views.
- **Version/compat machinery** — beta stance. The header keeps `v` as a plain
  sanity field (`v:2`); the viewer rejects other versions with a clear message
  and (temporarily) a v1→v2 conversion offer. The "unknown `op` must be
  skipped" rule survives, but as robustness, not a compatibility promise.

---

## Part II — Project model (replaces drag-and-drop as the primary flow)

Dropping a file stays as the quick-look path, but the primary experience is a
**project** — the tool opens like an editor, not like a converter.

- A project is a **directory** the user picks once (File System Access API —
  still fully client-side). The landing screen lists recent projects.
- Inside a project, files group into **runs**. A run is one execution of the
  traced program: one or more `.heapl` streams (interposer output, app-emitted
  spans/logs) plus imported plain logs. **Opening a run merges its files** by
  `t` (stable; per-file order preserved on ties) into one stream. Event index
  is assigned over the merged stream — this is why removing `seq` from the
  wire (I.1) is required, not just nice: producer-side indices can't survive a
  merge.
- `project.json` at the root records: runs and their member files, per-file
  import settings (log timestamp pattern), and viewer defaults. Hand-editable.
- **Analysis is auto-persisted.** Each run owns a `.heapa` in the project
  (auto-paired, auto-saved). No more manual export/import round-trips. The
  `.heapa` also stores the run's window layout, so reopening a run restores
  the whole workspace.
- Producers of one run must share a clock and `unit`. Allocation addresses
  live only in the interposer stream, so the common split (heap file + log
  file + span file) merges without any cross-file identity concerns.

## Part III — Analyzer architecture: views and lanes

This section replaces v1 §5's fixed three-view layout with the model the
docking/window work has been converging on. It is the product's core shape,
so it is spec'd, not left informative.

**One document, many views.** A run parses into a single document: the event
stream, derived state (live set, span stacks, anomalies), and the analysis
layer (tags, names, marks, analysis spans, filters). Every open window is a
**view** = a projection of that document. Views coordinate through exactly
three shared objects:

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
| **Address-line** | The live set at the playhead, spatially. *(demoted: one view among peers)* |
| **Events** | The stream as a virtualized list (exists today). |
| **Flame** | Span stacks over an axis, per lane. |
| **Anomalies** | Invalid frees / overlaps (I.2), click-to-seek. |
| *(future)* **Lifetime** | Allocations as bars from birth to death (gantt). |
| *(future)* **Stats** | Derived series: live bytes, alloc rate, by tag/site. |

**Lanes.** The timeline strip is a stack of **lanes**; a lane =
**axis × content**:

- **Axis:** `temporal` (x = t) or `sequential` (x = event index). An attribute
  of a lane, not a pair of hardcoded strips.
- **Content:** event density (today's strips), spans (flame ribbon: global
  lane, per-thread lanes), log ticks (level-colored), tag lane (exists today).

The v1 layout is just the default lane set: density×temporal, density×seq.
Users add/remove/reorder lanes; a run with no spans never shows a span lane;
the lane set persists in the run's `.heapa`. All lanes share the playhead and
drag-to-seek.

---

## Open questions

1. **`F` without `addr` match** (invalid free): draft says "anomaly, ignore for
   the live set." Should the anomaly also render at that address (ghost flash)
   when stepped onto, so it's findable spatially?
2. **Analysis spans on thread lanes** — useful, or is global + address-mark
   composition enough for hand annotation?
3. **`project.json` vs. convention** — is an explicit manifest worth it, or
   should runs be inferred (subdirectory = run, all files in it merge) with
   the manifest only appearing when the user customizes?
4. **Quick-look path** — when a bare `.heapl` is dropped with no project, do we
   offer "save as project" on first analysis edit, or keep a fully ephemeral
   mode?
5. **Rename** — the repo/tool is `heap-visualizer`; this draft says analyzer.
   Worth renaming now (beta) or after the views work lands?
