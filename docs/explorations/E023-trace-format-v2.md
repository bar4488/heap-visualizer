---
id: E023
title: Trace format v2 — processes, clocks, kinds, and intervals
status: proposed
updated: 2026-10-09
---

# E023: Trace Format v2

> **Status:** proposed spec, not implemented. It applies
> [D013](../decisions/D013-hybrid-record-types.md) and the user's decisions of
> 2026-10-09. When it is implemented, the wire rules move to
> [spec/02](../../spec/02-trace-format.md) (`TRACE-`) and the interval domain
> to a new `spec/14-intervals.md` (`IVL-`). Identifiers are assigned at that
> point, each taking the next free number for its prefix
> ([spec/README](../../spec/README.md)). Headings here are unnumbered for that
> reason.

## Scope

v2 adds five things to v1 (TRACE-001…010, LOG-001):

- process identity (`pid`) and `(pid, thr)` tracks;
- CPU tracks;
- a clock contract;
- user kinds declared in the header and written as `E` with `kind`;
- the **interval domain**: function calls, spans, and context switches,
  modeled as one interval shape with state at the playhead.

The heap stays the first domain and logs the second. Intervals are the third.
Sampled profiles (E022's suggested first slice) are deferred; the letter `S`
is reserved for them.

Every v1 rule not restated here is unchanged.

## Versioning

- v2 semantics apply **only when the first record is a header with `v` ≥ 2**.
  Otherwise the trace is read as v1. In a v1 trace, `pid`, `kind`, `ph`, and
  `cpu` are ordinary custom fields, and `B`, `X`, `C`, `T` are unknown ops and
  skipped, as v1 specifies.
- A `v` greater than 2 is read as v2 and flagged (`trace.unknown_version`,
  the existing `version` warning). `v` 1 and 2 raise no warning.
- **Why gate:** v2 changes what existing keys mean. In a v1 trace, `kind` on
  an `E` is a custom field, and two processes' `thr: 1` are one thread. A
  v1 file must never be reinterpreted by a newer reader.

## Records

| `op` | Spine | Meaning | New in v2 |
|------|:----:|---------|:---:|
| `H` | — | header | fields added |
| `T` | — | process/thread metadata | ✓ |
| `M` `F` `R` | ✓ | heap | `pid` |
| `E` | ✓ | landmark, or a user kind via `kind` | `kind`, `ph` |
| `L` | ✓ | log line | `pid` |
| `B` `X` | ✓ | interval begin, end | ✓ |
| `C` | ✓ | context switch on a CPU | ✓ |

"Spine" means the record occupies an event index
([DOM-001](../../spec/13-domains-and-logs.md#dom-001-one-event-spine)).
Records off the spine take no `seq`, do not move the clock, and may appear
anywhere after the header. Every spine record may carry `pid` and `thr`.

## Process identity

- **`pid`**: an integer in 0 … 2³²−1. It identifies an OS process or a
  stable synthetic process. If absent, it is the header's `pid`, or 0 when
  the header has none. A `pid` of the wrong shape makes the line malformed,
  exactly as a bad `thr` does today.
- **`thr`**: any JSON integer that fits i64, unchanged from v1. Its meaning is
  now scoped **by process**.
- **Track identity is `(pid, thr)`**, with `thr` possibly absent. The parser
  interns `(pid, thr?)` pairs into one track table. That replaces today's
  global `thr → u16` interning, where `thr: 1` in two processes was one
  thread. The spine keeps a single 16-bit track column. The `thr`-absent track
  of a process is its **process track**; in a single-process trace it
  displays as "no thread", which matches v1.
- **Limit:** 65,535 tracks per trace (`NONE_U16` stays reserved). A record on
  a track beyond the limit reads as track-less and raises
  `trace.too_many_tracks`. That is the existing `too_many_threads` warning,
  renamed in meaning and kept under the old API name.
- **Producer duty:** a `(pid, thr)` pair names one thread for the whole trace.
  If the OS reuses a tid within the trace window, the producer must remap the
  second thread to a fresh `thr`.
- **Heap scoping:** allocation `id`s and address spaces are per process. The
  id→creator map, overlap detection, and `dup-id`/`unknown-id` checks key on
  `(pid, id)` and `(pid, addr)`. The address map shows one process's address
  space at a time; by default it shows the process with the most heap
  records. In a single-process trace this changes nothing.

### `T`: track metadata

```json
{"op":"T","pid":7,"name":"api-server"}
{"op":"T","pid":7,"thr":2,"name":"worker-1"}
```

`T` names the process (without `thr`) or the thread (with `thr`). If a track
is named more than once, the last name wins. Names have no history. `name` is
a string of at most 256 bytes, truncated at a character boundary. A `T`
without a string `name` is dropped silently. That is the one exception to "a
dropped record raises `malformed`": a `T` carries no evidence.

## CPU tracks

- **`cpu`**: an integer in 0 … 4095. It is meaningful only on `C` records and
  on user-kind `E` records whose kind declares `"track":"cpu"`.
- CPU tracks are machine-wide, never per process. The trace describes one
  machine; a merge of several machines must renumber CPUs into disjoint
  ranges.
- `cpu` never appears on the spine's track column. A CPU's records live in the
  interval store.

## Clock contract

```json
{"op":"H","v":2,"clock":{"source":"monotonic","unit":"ns",
  "wall":{"t":1000,"unix_ns":"1791504000000001000"}}}
```

| Field | Meaning |
|-------|---------|
| `clock.source` | The clock every `t` was read from: `monotonic` (CLOCK_MONOTONIC, the recommended value), `boottime`, `monotonic_raw`, `tsc`, or a producer-chosen string. Informative only; the viewer displays it. |
| `clock.unit` | `ns` (default), `us`, `ms`, `s`, or `tick`. It supersedes top-level `unit`. |
| `clock.hz` | Ticks per second. Only for `unit:"tick"`; it allows wall-time display. |
| `clock.wall` | Optional anchor: the trace time `t` (integer) that corresponds to `unix_ns`, Unix time in nanoseconds as a decimal **string**. |
| `clock.error` | Optional bound on cross-source alignment error, in `clock.unit`. A merger writes it; the viewer displays it next to correlations. |

Rules:

- **One clock per trace.** Every `t` in the file, from every process and
  domain, is on `clock.source`. `t` stays the u64 lookup coordinate and `seq`
  stays canonical (TRACE-007, MODEL-004).
- **Wall time is display-only:** `unix_ns + (t − wall.t) · unit`. There is
  one anchor and no drift model. Wall time never orders or matches records.
- **Unit conflict:** if both `unit` and `clock.unit` are present and differ,
  `clock.unit` wins and the header raises `trace.clock_conflict`. Producers
  should write both, so v1 readers get the unit right.
- **Producer duty:** each process's records must be written in
  non-decreasing `t`, in program order per track. The existing clamp and
  `t-decrease` warning still apply, and are a diagnosis, not a merge
  strategy.
- **Merging** (merger duty, never done by the viewer):
  1. Convert each source to the common clock with a monotonic map
     (offset and positive scale). The map must not reorder records within a
     source.
  2. K-way merge by `(t, source rank, position in source)`. The source rank
     is fixed for the merge.
  3. Renumber colliding `pid`s, and prefix span ids by source when the
     sources could collide.
  4. Union `kinds`. Two sources declaring the same kind name with different
     schemas is a merge error; the merger must rename one.
  5. Drop or rewrite every `seq`. Write one header and set `clock.error`
     when alignment was approximate.

## User kinds

### Header schema

```json
"kinds": {
  "gc": {"shape":"interval","track":"pid","title":"phase",
         "fields":{"phase":{"type":"enum","values":["mark","sweep"],"required":true},
                   "freed":"uint"}},
  "frame": {"shape":"point","track":"global","fields":{"n":"uint"}}
}
```

| Key | Values | Default |
|-----|--------|---------|
| `shape` | `point` or `interval` | `point` |
| `track` | `thr` (the record's `(pid,thr)` track), `pid` (its process), `cpu` (needs `cpu` on the record), `global` | `thr` |
| `title` | Name of the field whose value labels the record | the record's `title` field, else the kind name |
| `fields` | Map from field name to a type, or to `{type, required?, values?}` | none |

**Field types:** `bool`, `int` (i64), `uint` (u64; may be written as a
decimal string to stay exact), `float`, `string`, `addr` (an address string
under TRACE-001), `enum` (requires `values`, at most 64 strings), and `json`
(any value, display-only).

- A **kind name** matches `[a-z][a-z0-9_.-]{0,63}`.
- **Reserved names:** `heap`, `log`, `call`, `span`, `sched`, `interval`, and
  any name starting with `hv.`.
- **An invalid kind entry** (bad name, reserved name, unknown `shape` or
  `track`, bad field spec) is ignored and raises `kind.bad_schema` (detail:
  the entry's position). Records of that kind are read as undeclared.
- **Unknown keys** in a kind entry or field spec are ignored, for forward
  compatibility.

### `E` records with `kind`

- `kind` is a string. A non-string `kind` is an ordinary custom field, and
  the record is a plain landmark.
- **Declared point kind:** a point on the spine, on the kind's track. Fields
  are validated against the schema. A field of the wrong type is kept
  verbatim as display-only and raises `kind.field_type`. A missing required
  field raises `kind.missing_field`. The record is always kept.
- **Declared interval kind:** the record must carry `"ph":"B"` (begin) or
  `"ph":"X"` (end). It pairs by the interval rules below, scoped to
  `(kind, track instance)`. A `span` field switches the record to pairing by
  id within the kind. A missing or invalid `ph` reads the record as a point
  of that kind and raises `kind.bad_edge`. Fields on the end record are kept
  as the interval's end fields.
- **Undeclared kind:** a point landmark on its `thr` track. `ph` is just a
  field. Its keys and their observed type bitmasks are catalogued **per
  kind**, the same way FieldInfo catalogues custom fields today. Interval
  shape requires a declaration.
- **Reserved name in an `E`:** read as an undeclared point kind, with one
  `kind.reserved` warning per name.
- `title` keeps its TRACE-010 meaning. `site` and `stack` are not read.
- Typed `E` records belong to a **kinds store**, keyed by spine index
  (DOM-002), and not to the heap columns. Their fields are not part of the
  allocation filter's custom-field catalogue. A plain `E` without `kind` is
  unchanged in every respect.

## Interval domain

One shape covers every interval: `(category, track, begin seq, end seq?,
depth, parent?, name, begin fields, end fields)`. The categories are **call**,
**span**, **sched**, and one per declared interval kind.

### `B` / `X`: calls and spans

```json
{"op":"B","t":1250,"thr":1,"name":"handle_upload"}
{"op":"X","t":1850,"thr":1,"name":"handle_upload"}
{"op":"B","t":1200,"thr":1,"span":"r42","name":"request","parent":"r41"}
{"op":"X","t":1900,"thr":3,"span":"r42","status":"ok"}
```

| Field | On | Meaning |
|-------|----|---------|
| `name` | B; optional on X | Function or span name. String, at most 1 KiB, interned. On a call `X` it is checked against the frame it closes. |
| `span` | B, X | The span id: a string of at most 128 bytes, or an integer. Its presence makes the record a **span** edge rather than a **call** edge. |
| `parent` | span B | The parent span's id. |
| `t`, `seq`, `pid`, `thr` | both | As for every spine record. |

Every other key is a custom field: begin fields on `B`, end fields on `X`.
A `name`, `span`, or `parent` of the wrong shape makes the line malformed.

**Pairing: calls.** Each track has a LIFO stack of call frames.

- `B` pushes a frame. Its **depth** is the stack size before the push, and
  its **parent** is the frame below it.
- `X` without `name` pops the top frame.
- `X` with `name` pops the innermost open frame of that name. Any frames
  above that frame are closed at the same `X` and each raises
  `interval.implicit_close`. This covers missed exits from unwinding and
  `longjmp`. If no open frame has that name, nothing is closed.
- An `X` that closes nothing (empty stack, or no frame of that name) stays on
  the spine and raises `interval.unmatched_end`.

**Pairing: spans.** Spans pair **by id, trace-wide**, and may begin and end
on different tracks and processes.

- Span `B` with an id that is already open raises `interval.duplicate_span`.
  The record stays on the spine, but nothing is opened.
- An id may be reused after its span closes.
- `parent` resolves, at begin, to the most recent span begun with that id,
  whether open or closed: async children may outlive their parent. An
  unresolved `parent` raises `interval.unknown_parent`, and the span becomes
  a root.
- A span's depth is its parent's depth plus 1.
- Spans and call frames form **separate trees**: a span is never a call
  frame's parent, and a call frame is never a span's. Whether a call frame is
  enclosed by a span is a query (same track, overlapping range), not a stored
  link.
- Span `X` for an id that is not open raises `interval.unmatched_end`.

### `C`: context switches

```json
{"op":"C","t":1000,"cpu":0,"pid":7,"thr":1}
{"op":"C","t":1550,"cpu":1}
```

From this record on, `cpu` runs thread `(pid, thr)`. With `thr` absent, the
CPU is idle (and `pid` is ignored). The spine track of a `C` is the incoming
thread's track.

- **Recommended encoding:** one `C` per switch, rather than begin/end slices
  per CPU. A switch is exactly what `sched_switch` and ETW report. It is half
  the records of slice pairs, and it cannot produce unmatched pairs.
- The reader expands `C` into **sched intervals**: each `C` ends the previous
  slice on its CPU and begins a new one.
- A slice still open at the end of the trace is normal and raises no warning.
- Before a CPU's first `C`, its state is *unknown*, not idle.
- A thread that is running on two CPUs at once raises `sched.double_run`.
  Both slices are kept.
- A `C` without a valid `cpu` is malformed and dropped.
- An optional `state` string records the outgoing thread's state (`R`, `S`,
  `D`, …). It is kept as an end field of the closed slice.

### Limits and unclosed intervals

- **Call depth:** 1024 open frames per track. A `B` past the limit opens
  nothing. It increments a per-track overflow counter and raises
  `interval.depth_limit` once per track. While the counter is non-zero, `X`
  records on that track decrement it before they pop anything. This keeps
  pairing correct after the overflow.
- **Span depth** is capped at 1024 as well. A span that would exceed the cap
  becomes a root and raises `interval.depth_limit`.
- **Open spans:** at most 65,536 at once, trace-wide. Past that, a span `B`
  opens nothing and raises `interval.too_many_open`.
- **Interval kinds:** the call depth limit applies per `(kind, track
  instance)`.
- **Unclosed intervals:** a call, span, or user interval still open at the
  end of the trace raises one `interval.unclosed` (detail: begin seq). It is
  displayed as extending to the trace end and is marked open. Sched slices
  are exempt.

### State at the playhead

An interval with begin record *b* and end record *x* is **open at playhead
P** when *b* has been applied at P and *x* (if any) has not. This is the same
position convention as the live set
([MODEL-003](../../spec/03-core-model.md#model-003-the-live-set),
MODEL-004). At P the domain answers:

- **call stack per track:** that track's open call frames, ordered by depth;
- **open spans:** every open span, with its parent chain;
- **per CPU:** the running `(pid, thr)`, idle, or unknown, plus the slice's
  begin;
- **per interval kind:** the open intervals on each track instance.

**Cost bounds** (replay is not allowed):

- A call stack is answered in O(log n + depth): binary-search the track's
  last frame begun at or before P, then walk parent links until a frame is
  still open. Proper nesting makes every ancestor of that frame open.
- A CPU's state is answered in O(log n) over that CPU's `C` list.
- Open spans and open kind intervals use load-time checkpoints of the
  open-set, taken at the heap snapshot cadence (MODEL-004), plus forward
  replay of interval records only. The cost is bounded by one checkpoint
  interval.

Interval records never mutate the heap (DOM-002). The allocation filter never
matches them (DOM-003). In the Events list they appear as rows that show the
edge (`→ name` / `← name`, `cpu 3 ⇐ worker-1`).

## `seq` width

**Do not widen.** The wire `seq` is a JSON integer and has no width. The
engine's spine index stays u32, with `NONE_U32` reserved. That allows at most
2³² − 1 records.

- **Why:** the browser must load every trace the server does (connected mode,
  [D012](../decisions/D012-connection-mode-has-one-authority.md)), and wasm32
  memory is 4 GiB. One spine row is at least 11 bytes (op 1, `t` 8, track 2),
  so 2³² records need over 44 GiB before any payload. Memory runs out more
  than ten times sooner than u32 does. Widening would double every link,
  rank, and seq column (`target`, `death`, `hrank`, log `seq`, interval
  begin/end) to raise a bound that can't be reached.
- **Hard limit:** records past index 2³² − 2 are dropped, and the stream
  raises one `trace.too_many_records`.
- **Revisit** together with a binary encoding and a native-only viewer. Both
  are out of scope here.
- Producers **should omit `seq`** in v2. Stream position is authoritative,
  and v1 readers count positions differently (see Compatibility).

## Hard limits

| Item | Limit | Past the limit |
|------|-------|----------------|
| Spine records | 2³² − 1 | dropped, `trace.too_many_records` once |
| Tracks `(pid, thr?)` | 65,535 | track-less, `trace.too_many_tracks` |
| CPUs | `cpu` < 4096 | `C` malformed; kind record raises `kind.field_type` |
| Kinds (declared + undeclared) | 255 | record read as a plain landmark, `kind.too_many` once |
| Declared fields per kind | 64 | kind is `kind.bad_schema` |
| Catalogued keys per kind | 256 | kept verbatim, not catalogued |
| Kind name | 64 bytes | `kind.bad_schema` / custom field |
| Call depth per track; span depth | 1024 | `interval.depth_limit` |
| Open spans | 65,536 | `interval.too_many_open` |
| `name`, `title` | 1 KiB | truncated at a character boundary, `trace.long_field` |
| `span` id | 128 bytes | line malformed |
| `stack` array (heap) | 256 frames, 1 KiB each | innermost kept, `trace.long_field` |
| Custom-field fragment per record | 64 KiB | replaced by `{"_truncated":<bytes>}`, `trace.long_field` |
| `L` `msg` | 16 KiB | unchanged (`log.long_log`) |

## Validity and warnings

v1's principle holds: invalid input is shown and warned about, not rejected.
v2 extends the list of dropped records (TRACE-009) with `C` without a valid
`cpu`, and with `B`/`X` whose `name`/`span`/`parent` have the wrong shape.
`T` without `name` is also dropped, silently. A dropped record still leaves
no other trace. Unmatched, duplicate, and over-limit interval edges are
**kept** on the spine, so the warning can jump to them.

Warnings are namespaced by domain. The canonical name is `domain.kind`. The
agent API keeps the bare `kind` string and adds `domain`, so bare kinds must
be unique across domains. Numeric codes keep appending after 11.

| Domain | Kinds |
|--------|-------|
| `trace` | `malformed_line`, `decreasing_time`, `sequence_mismatch`, `unknown_version`, `too_many_threads` (now tracks), new: `clock_conflict`, `too_many_records`, `long_field` |
| `heap` | `unknown_id`, `double_free`, `duplicate_id`, `overlap`, `invalid_size` |
| `log` | `bad_level`, `long_log` |
| `interval` | `unmatched_end`, `implicit_close`, `unclosed`, `duplicate_span`, `unknown_parent`, `depth_limit`, `too_many_open` |
| `sched` | `double_run` |
| `kind` | `bad_schema`, `reserved`, `field_type`, `missing_field`, `bad_edge`, `too_many` |

Header warnings attach where `version` attaches today. Counts are always
full, and detail records stay capped at 1000 across all domains.

## Compatibility

- **v1 trace, v2 reader:** identical behavior. The trace isn't gated in, so
  every key and letter keeps its v1 meaning.
- **v2 trace, v1 reader:**
  - The v1 reader raises `version` and parses anyway.
  - Heap and logs read correctly within one process, because DOM-002 keeps
    other records non-mutating.
  - `B`, `X`, `C`, `T` are skipped. Typed `E` records become landmarks with
    `kind`/`ph` as custom fields.
  - `pid` is ignored, so threads alias across processes. A multi-process
    heap shows false overlaps.
- **Seq drift:** the readers number the spine differently, because a v1
  reader skips `B`/`X`/`C`. Analysis anchored by seq (`.heapa`, ANL-007)
  therefore does not transfer between a v1 and a v2 reader of the same v2
  file. The existing trace-size check flags this. Analysis of a v2 trace must
  be made with a v2 reader.
- **v2 writers** should write top-level `unit` alongside `clock.unit`, omit
  `seq`, and keep a single-process trace at `pid` 0 or omit `pid`, so a v1
  reader sees the most faithful picture.
- **API and ABI:** existing documents keep their shapes. The new domain adds
  its own reads (paged intervals, and state at a seq). Those are bounded by
  the depth and open-span limits above, so a state read stays within API-001
  even though API-010 rules out heap snapshots at arbitrary seqs.

## Example

One process with two threads and two CPUs. It mixes heap, logs, calls, a
cross-thread span tree, sched switches, a declared interval kind, and an
undeclared point kind. The seq column is shown for reference and is not
written.

```jsonl
{"op":"H","v":2,"unit":"ns","title":"upload","pid":7,"clock":{"source":"monotonic","unit":"ns","wall":{"t":1000,"unix_ns":"1791504000000001000"}},"kinds":{"gc":{"shape":"interval","track":"pid","title":"phase","fields":{"phase":{"type":"enum","values":["mark","sweep"],"required":true},"freed":"uint"}}}}
{"op":"T","pid":7,"name":"api-server"}
{"op":"T","pid":7,"thr":1,"name":"main"}
{"op":"T","pid":7,"thr":2,"name":"worker"}
{"op":"C","t":1000,"cpu":0,"thr":1}
{"op":"C","t":1000,"cpu":1,"thr":2}
{"op":"B","t":1100,"thr":1,"name":"main"}
{"op":"B","t":1200,"thr":1,"span":"r42","name":"request","route":"/upload"}
{"op":"B","t":1250,"thr":1,"name":"handle_upload"}
{"op":"M","t":1300,"thr":1,"id":1,"addr":"0x7f0000001000","size":4096,"site":"read_body"}
{"op":"L","t":1350,"thr":1,"level":"info","logger":"http","msg":"body read","bytes":4096}
{"op":"B","t":1400,"thr":2,"span":"r42.parse","parent":"r42","name":"parse"}
{"op":"M","t":1450,"thr":2,"id":2,"addr":"0x7f0000003000","size":256,"site":"json_node"}
{"op":"E","t":1500,"thr":2,"kind":"cache_miss","key":"user:9"}
{"op":"C","t":1550,"cpu":1,"state":"S"}
{"op":"E","t":1600,"kind":"gc","ph":"B","phase":"mark"}
{"op":"F","t":1650,"thr":1,"id":1}
{"op":"E","t":1700,"kind":"gc","ph":"X","freed":4096}
{"op":"C","t":1720,"cpu":1,"thr":2}
{"op":"X","t":1750,"thr":2,"span":"r42.parse","status":"ok"}
{"op":"L","t":1800,"thr":1,"level":"warn","logger":"http","msg":"slow request","ms":0.7}
{"op":"X","t":1850,"thr":1,"name":"handle_upload"}
{"op":"X","t":1900,"thr":1,"span":"r42"}
{"op":"E","t":1950,"title":"frame end"}
```

Spine seqs: `C`=0, `C`=1, `B main`=2, `B r42`=3, `B handle_upload`=4, `M 1`=5,
`L`=6, `B r42.parse`=7, `M 2`=8, `E cache_miss`=9, `C idle`=10, `E gc B`=11,
`F 1`=12, `E gc X`=13, `C`=14, `X r42.parse`=15, `L`=16, `X handle_upload`=17,
`X r42`=18, `E`=19.

State with the playhead at seq 12 (record 12 applied):

| Question | Answer |
|----------|--------|
| Live heap | id 2 (id 1 died at seq 12) |
| Call stack `(7,1)` | `main` (depth 0) › `handle_upload` (depth 1) |
| Call stack `(7,2)` | empty (`r42.parse` is a span, not a frame) |
| Open spans | `r42` (root) › `r42.parse` (begun on thread 2) |
| CPU 0 / CPU 1 | `(7,1)` since seq 0 / idle since seq 10 |
| `gc` on process 7 | `mark`, open since seq 11 |

At the end of the trace, `main` (seq 2) is still open and raises one
`interval.unclosed`. The sched slices still open on CPUs 0 and 1 raise
nothing. `cache_miss` is catalogued as an undeclared kind with the field
`key: string`.

## Open questions

1. **Track width.** Are 65,535 `(pid, thr)` tracks per trace enough? A
   system-wide sched capture over hours can exceed that. Widening the spine
   track column to u32 costs 2 bytes per record.
2. **Multi-process address map.** Is one process's address space at a time
   (the recommendation) acceptable, or should several be shown side by side?
3. **Frame identity for calls.** Should `B` carry `name` only, or also allow
   module/build-id/address for delayed symbolization (E022 question 1)? If
   so, should frames be declared once in a dictionary record?
4. **User interval encoding.** This proposal writes user interval kinds as
   `E` + `ph`, which keeps D013's split strict. The alternative is to allow
   `kind` on `B`/`X`, which shares the interval letters but blurs which
   records are built-in.
5. **Version gating.** Is it acceptable that v2 features require a `v:2`
   header as the first record, so a headerless trace is always v1?
6. **Span id scope.** Should span ids be trace-wide (as proposed, with the
   merger prefixing ids from different sources), or scoped per `pid`, with
   cross-process parents written as `{pid, span}`?
7. **Sampled profiles.** E022 recommended samples as the first new domain;
   this proposal puts intervals first and only reserves `S`. Do profiles come
   next, and should a sample reference the open call stack instead of
   carrying its own?
8. **New heap limit.** The 256-frame limit on `stack` arrays is new for
   heap records. Is truncating to the innermost frames right for the
   producers that exist today?
