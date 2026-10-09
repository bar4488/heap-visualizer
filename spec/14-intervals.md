# 14 — The Interval Domain

Function calls, spans, and CPU run slices, read from trace format v2
([TRACE-011](02-trace-format.md#trace-011-version-2-and-process-identity)).
The interval domain is the third evidence domain after the heap and logs
([DOM-004](13-domains-and-logs.md#dom-004-the-domain-registry)) and the
first whose records are not instants: every interval has a begin and an end
record on the spine, and the domain answers *what is open at the playhead*.

The design and its open questions are in
[E023](../docs/explorations/E023-trace-format-v2.md); this file is the part
that is implemented. User kinds (`E` with `kind`), the clock contract, and
per-process heap scoping are not.

## IVL-001: Interval records `B`, `X`, `C`

Read only in a v2 trace. In a v1 trace `B`, `X` and `C` are unknown ops and
are skipped, and their keys are never read
([TRACE-002](02-trace-format.md#trace-002-record-types-op)).

```json
{"op":"B","t":1250,"thr":1,"name":"handle_upload"}
{"op":"X","t":1850,"thr":1,"name":"handle_upload"}
{"op":"B","t":1200,"thr":1,"span":"r42","name":"request","parent":"r41"}
{"op":"X","t":1900,"thr":3,"span":"r42","status":"ok"}
{"op":"C","t":1000,"cpu":0,"pid":7,"thr":1}
{"op":"C","t":1550,"cpu":1,"state":"S"}
```

| Field | On | Meaning |
|-------|----|---------|
| `name` | `B`; optional on `X` | Function or span name: a string, interned. Longer than 1 KiB is truncated at a character boundary and raises `long_field`. |
| `span` | `B`, `X` | Span id: a string of at most 128 bytes, or an integer (read as its decimal text, so `7` and `"7"` are one id). Its presence makes the record a **span** edge rather than a **call** edge. |
| `parent` | span `B` | The parent span's id, in the same shape. |
| `cpu` | `C` | An integer 0–4095. |
| `t`, `seq`, `pid`, `thr` | all | As for every spine record ([TRACE-011](02-trace-format.md#trace-011-version-2-and-process-identity)). |

Every other key is a custom field of the edge: an interval's **begin
fields** are its begin record's, its **end fields** its end record's. A
`name`, `span`, `parent` or `cpu` of the wrong shape (or a span id over 128
bytes, or a `cpu` ≥ 4096) makes the line malformed, and a `C` without `cpu`
is malformed too; each is dropped under
[TRACE-009](02-trace-format.md#trace-009-validity).

Every `B`, `X` and `C` occupies a spine index, on its own track; a `C`'s
track is its **incoming** thread's, and a `C` without `thr` means the CPU
goes idle (its `pid` is ignored, and it has no track). `cpu` never appears
on the spine's track column.

## IVL-002: Pairing

**Calls** pair last-in, first-out per track:

- `B` pushes a frame; its **depth** is the stack size before the push, its
  **parent** the frame below it.
- `X` without `name` pops the top frame.
- `X` with `name` pops the innermost open frame of that name, and closes
  every frame above it at the same `X`, each raising `implicit_close`
  (missed exits from unwinding or `longjmp`).
- An `X` that closes nothing — an empty stack, or no open frame of that name
  — stays on the spine and raises `unmatched_end`.

**Spans** pair by id, **trace-wide**, and may begin and end on different
tracks and processes:

- A span `B` whose id is already open raises `duplicate_span` and opens
  nothing. An id may be reused once its span has closed.
- `parent` resolves at begin to the most recent span begun with that id,
  open or closed (async children may outlive their parent). An unresolved
  `parent` raises `unknown_parent` and the span is a root. A span's depth is
  its parent's plus one.
- A span `X` whose id is not open raises `unmatched_end`.
- Spans and call frames are separate trees: neither is ever the other's
  parent.

**Run slices**: each `C` ends the CPU's current slice and begins the next —
running the incoming thread, or idle. Before a CPU's first `C` its state is
*unknown*, not idle. A thread whose slice begins while it already runs on
another CPU raises `double_run` (detail: the CPU); both slices are kept. A
`C`'s custom fields (for example `state`, the outgoing thread's state) are
the end fields of the slice it closes.

Interval records never mutate the heap: the live set at every heap event is
the same with and without them
([DOM-002](13-domains-and-logs.md#dom-002-domains-own-their-payloads)).

## IVL-003: The interval store

Two layers, both rows only for interval records:

- **Edges**: one row per `B`/`X`/`C`, as a point store
  ([DOM-004](13-domains-and-logs.md#dom-004-the-domain-registry)) whose
  category is the interval's (`sched` 0, `call` 1, `span` 2) and whose label
  is the edge's `name`, with the domain's own field catalog. Each edge row
  records the interval it began and the one it ended.
- **Intervals**: one row per call frame, span, or run slice, created when
  its begin edge is read — so interval order is begin order. Columns:
  category, track (the begin record's spine track; a slice's CPU), begin
  seq, end seq (or open), depth, parent, interned name, interned span id,
  and flags (idle, implicitly closed, double run).

Load-time **begin indexes**, each a subsequence of interval order and so
sorted by begin: the call frames per track, every span, and the run slices
per CPU; plus a max-end segment tree over the span list.

## IVL-004: Limits and unclosed intervals

| Item | Limit | Past the limit |
|------|-------|----------------|
| Open call frames per track | 1024 | the `B` opens nothing, raises `depth_limit` once per track, and is counted; while the count is non-zero an `X` on that track decrements it instead of popping, which keeps pairing correct |
| Span depth | 1024 | the span becomes a root, `depth_limit` |
| Open spans, trace-wide | 65,536 | the `B` opens nothing, `too_many_open` |
| `name` | 1 KiB | truncated, `long_field` |
| `span`/`parent` id | 128 bytes | line malformed |
| `cpu` | < 4096 | line malformed |

A call or span still open at the end of the trace raises one `unclosed`,
attached to its begin record (detail: the begin seq); it extends to the
trace end and is marked open. Run slices are exempt. Unmatched, duplicate
and over-limit edges are never dropped: they stay on the spine, so their
warning can jump to them.

## IVL-005: State at the playhead

An interval with begin record *b* and end record *x* is **open with P
records applied** when *b* < P and *x* (if any) ≥ P — the live set's
position convention ([MODEL-003](03-core-model.md#model-003-the-live-set)).
The domain's state at P is:

- **threads**: every track with an open call frame, with its stack of open
  frames, outermost first;
- **spans**: every open span with its parent and parent id, in begin order;
- **cpus**: per CPU, `running` (its thread and the slice's begin seq),
  `idle` (since), or `unknown`.

No replay and no snapshots. A call stack costs O(log n + depth): the last
frame on the track begun before P is found by binary search, then parent
links are walked to the nearest frame still open, whose ancestors are all
open by proper nesting. A CPU's state is one binary search over its slices.
Open spans are read from the max-end segment tree over the span list in
O((k + 1) log n) for k open spans. Each answer is bounded by the limits of
IVL-004.

## IVL-006: Warnings

Warnings carry a domain; the canonical name is `domain.kind`, and bare kinds
are unique across domains
([MODEL-005](03-core-model.md#model-005-warnings)).

| Code | Domain | Kind | Raised by |
|------|--------|------|-----------|
| 12 | `interval` | `unmatched_end` | an `X` that closes nothing |
| 13 | `interval` | `implicit_close` | each frame above a named `X`'s match (detail: its begin seq) |
| 14 | `interval` | `unclosed` | a call or span open at trace end (detail: begin seq) |
| 15 | `interval` | `duplicate_span` | a span `B` whose id is open |
| 16 | `interval` | `unknown_parent` | a span `B` whose `parent` resolves to nothing |
| 17 | `interval` | `depth_limit` | IVL-004 |
| 18 | `interval` | `too_many_open` | IVL-004 |
| 19 | `sched` | `double_run` | a thread running on two CPUs (detail: the CPU) |
| 20 | `trace` | `long_field` | a truncated `name` (detail: its byte length) |

## IVL-007: The domain on the registry

The domain is `intervals`, with kinds `begin` (`B`), `end` (`X`) and
`switch` (`C`), and descriptor `shape` `interval`. Besides DOM-004's keys
its descriptor carries `intervals` (the interval count), `categories`
(`["sched","call","span"]`), `byCategory`, `tracks` (`{threads:[{thr, pid?,
name, calls}], cpus:[{cpu, slices}]}`), and `limits` adding `depth`,
`openSpans` and `cpus`.

- **Rows** (count, row ↔ seq, generic summary, Events-list row) are edges.
  An edge's summary `title` shows the edge: `→ name`, `← name`,
  `cpu 3 ⇐ worker-1`, `cpu 3 idle`; its `source` is its category.
- **Query and locate** are over intervals, not edges. Parameters:
  `category` (`sched`/`call`/`span`), `thr` (with optional `pid`; `pid`
  alone selects a process track) or `cpu`, `text` (ASCII case-insensitive
  over name and span id), `minDur` (trace time units; an open interval
  lasts to the trace end), and `seqLo`/`seqHi`, which select the intervals
  **overlapping** the range. A thread selects its calls, the spans begun or
  ended on it, and the slices it ran in. A track the trace does not have
  matches nothing. Each row is an interval document: `{row, ivl, category,
  name, seq (begin), end, t, endT, dur, open, depth, parent, thr, pid?,
  fields, endFields}`, plus `span`, `parentSpan` and `endThr` for a span,
  `cpu` and `idle` for a slice, and `implicitClose`/`doubleRun` when set.
  Locate answers the last matching interval begun at or before `seq`.
- **Lane**: one lane, `intervals.activity`, each column colored by the
  highest category of edge in it (span over call over sched); hover gives
  `intervals:{count, byCategory}`.
- **State**: IVL-005's document, `{applied, threads, spans, cpus}`, from
  `domain_state("intervals", seq)` and the `hp_domain_state` export.
- **Agent records** are interval documents with exact (string) times; the
  page takes `category`, `thr`, `pid`, `cpu`, `text` and `minDur`.
  `agent_item` of an edge row is its summary plus the `interval` it begins
  or ends.

## IVL-UI: The interval panels

Three panels present the domain in the browser (`src/web/intervals/`), each
a window of the shell ([SHELL-002](09-ui-shell.md#shell-002-panels-views-and-windows))
with a toolbar toggle that is shown only when the loaded trace has
intervals. They start open, for such a trace only, where SHELL-008 places
them: **Tracks** as a tab of the bottom edge (beside Logs), **Stacks** as a
tab of the right edge; **Intervals** starts closed in the left edge. Each
does work only while its tab is in front, and every request goes through
rpc.ts's coalescing `requestLatest` under its own `intervals-` key, so
playback or a fast zoom never builds a backlog.

A click on an interval anywhere seeks to one record past its begin, so the
interval is open at the playhead (IVL-005).

### IVL-UI-001: Durations

Durations are shown in the largest unit that keeps them readable (`850ns`,
`1.25µs`, `12.5ms`, `3.2s`, `2m05s`), from the trace's `unit`; a trace
without a known unit shows ticks. An open interval's duration is a lower
bound and is marked `≥`. On the seq axis a span is a count of records.

### IVL-UI-002: Stacks

The state at the playhead from `domain-state`, asked once per playhead move:

- **Calls**: per thread with an open frame, its name and `pid · thr`, then
  its stack, outermost at the top and innermost at the bottom (highlighted),
  each frame with its begin seq. Threads are in the Tracks order.
- **Spans**: the open spans as a parent tree, children under their parent in
  begin order. A span whose parent has closed is a root that names the
  parent's id.
- **CPUs**: per CPU, the running thread, `idle`, or `unknown`, and the seq
  its slice began.

### IVL-UI-003: Tracks

A flame chart on a canvas drawn on the main thread, at the device pixel
ratio, in colors read from the `--ivl-*` CSS tokens.

- **Rows**: per thread with calls or spans (by process, then thread id) a
  head with its name, one row per call depth, then one row per span depth;
  then a `CPUs` heading and one row per CPU (by number) of run slices. Calls
  and spans are colored by name, slices by thread; idle slices are muted. An
  open interval has a notch at its right end. A track's rows grow as deeper
  intervals arrive and never shrink while the trace is loaded.
- **Axis**: the strips' view range on the axis the head selects — time or
  event index — with ticks, and the playhead as a vertical line.
- **Data**: only tracks in view are fetched, each by one `interval-window`
  for the view plus half a view either side, at twice the panel's width,
  re-asked only when the view leaves that margin, the zoom changes by more
  than a quarter, or the axis or width changes. Rows hold axis units, so a
  pan or zoom redraws at once from what is held. Bars narrower than a pixel that
  start where the previous bar in their row reaches are folded into it.
- **Vertical**: groups are virtualized; only those in the viewport are drawn
  and fetched.
- **Input**: hover shows the name, kind, duration and thread; a click on a
  bar seeks to its begin and on empty space seeks to the value under the
  pointer; a drag or shift+wheel (or a horizontal wheel) pans,
  ctrl/⌘+wheel zooms about the pointer, a plain wheel scrolls the tracks,
  and a double click shows the whole trace. Zoom and pan drive the strips'
  view, so the two stay on one x-range.

### IVL-UI-004: Intervals

A virtualized table of every interval from `domain-query`, in start order
either way (the start column's head flips it): start relative to the trace
start, duration, kind (`call`, `span`, `cpu`), track, and name (calls
indented by depth, spans with their id). Filters: category, one thread or
CPU, text (name or span id), and a minimum duration typed with a unit
(`250us`, `1.5ms`) or in trace units; an unreadable one is marked and not
applied. The head shows `shown / total`: matches of the filters, of all
intervals. Rows open at the playhead are highlighted and rows not yet begun
are dimmed.
