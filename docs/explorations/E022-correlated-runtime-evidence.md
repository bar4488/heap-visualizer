# E022 — Correlated runtime evidence

Status: planning exploration; no product behavior is committed here.

## Goal

Grow the heap workbench into a runtime-evidence workbench where allocations,
sampled function profiles, stack snapshots, structured logs, spans, and faults
share one ordered time axis. A user or agent should be able to ask not only
"what leaked?", but also:

- which functions were active during an allocation burst;
- which logs and request spans surround an allocation's birth or death;
- which stacks dominate retained bytes in a selected interval;
- whether a fault followed reuse, growth, or freeing of a relevant region.

This must preserve the existing first design goal: heap-only traces and heap
rendering stay fast at millions of events.

## Direction

Use one unified `.heapl` stream. Every record shares stream order, `seq`, `t`,
process, and thread identity. Non-heap evidence remains non-mutating: replaying
the heap while skipping all of it must produce exactly the same live set at
every heap operation.

Keep `M`, `F`, and `R` as the heap vocabulary. Evolve `E` from an untyped
landmark into a backwards-compatible observation envelope selected by `kind`:

```json
{"op":"E","kind":"sample","t":6804,"pid":7,"thr":2,"metric":"cpu","weight":1000000,"stack":["main","serve","parse"]}
{"op":"E","kind":"log","t":6810,"pid":7,"thr":2,"level":"warn","message":"retrying allocation","request":"r42"}
{"op":"E","kind":"stack","t":6820,"pid":7,"thr":2,"reason":"fault","stack":["main","serve","copy"]}
{"op":"E","kind":"span_begin","t":6700,"pid":7,"thr":2,"span":"r42","parent":null,"name":"request"}
{"op":"E","kind":"span_end","t":6900,"pid":7,"thr":2,"span":"r42","status":"error"}
```

An absent or unknown `kind` remains an ordinary landmark. Old readers already
ignore unknown fields and keep `E` records out of allocation state, making this
safer than assigning many unrelated top-level operation letters.

The producer or merger owns clock normalization and emits records in monotonic
order. Header metadata must identify the monotonic clock and process identity;
wall-clock timestamps are metadata for display and cross-run comparison, not
the canonical ordering coordinate. Equal timestamps are ordered by stream
position as they are today.

## Storage model before high-rate evidence

Do not put profile samples into the current `Store` unchanged. Its heap fields
are dense per event, so every sample would pay for allocation id, address,
size, target, death, and heap timeline prefixes.

Split storage into:

1. **Event spine** — one compact row per record: kind/domain, timestamp,
   process, thread, and a payload-row index. Global `seq` is the spine index.
2. **Heap store** — geometry, ids, creator/death links, sites, heap snapshots,
   and tag indexes only for heap records/allocations.
3. **Profile store** — sample spine index, stack id, metric, and weight.
   Frames and complete stacks are interned; repeated samples hold integers,
   never cloned strings.
4. **Log store** — spine index, severity, interned message/logger ids, and an
   interned structured-field fragment.
5. **Span store** — begin/end spine indexes, interned names, parent links,
   status, and correlation ids.

Retain stable mappings between a creator allocation and its global spine
index. Existing analysis remains anchored to creator `seq`; no migration to
wire allocation ids is needed.

Each track owns the indexes it needs. Timeline bins use per-track prefix sums;
time-range lookup uses binary search over monotonic timestamps. Heap seek and
address rendering must not scan profile, log, or span payloads.

## Product model

One playhead and one selected time/sequence range coordinate every view.
Evidence tracks are additive rather than replacements for the address map:

- **Evidence lanes** on the timelines show sample density, log severity, span
  boundaries, and faults without conflating them with allocation/free marks.
- **Profiles panel** summarizes the selected range as top functions and a
  flame graph. It can group by inclusive samples, exclusive samples, or a
  future allocation-weighted metric.
- **Logs panel** is virtualized and range-aware, with bounded text/field
  search and severity controls.
- **Trace panel** shows nested spans and selected-span heap deltas.
- **Event window** becomes typed while retaining the generic custom-field
  fallback.

Range selection is the first correlation primitive. For a selected range the
engine can report, from existing indexes: allocations/frees/net bytes, retained
allocations, top sampled stacks/functions, matching logs, and active/completed
spans. This avoids inventing hidden causal links from timestamps alone.

## Query and analysis boundaries

Do not stretch the allocation filter into a universal evaluator. Keep typed
subjects and plans:

- allocation filters continue to produce creator-allocation bitsets;
- profile queries operate on samples/stacks/functions;
- log queries operate on log records;
- span queries operate on spans.

Correlation composes those typed results over an explicit sequence/time range.
The local API should eventually expose bounded, paged forms such as profile
summary, log search, span context, and one correlation summary. Responses must
return evidence and counts, not assert causality. User-authored annotations may
later attach to any global event/range while existing allocation tags remain
allocation-specific.

## Delivery sequence

### 1. Specify the common envelope

- Define `pid`, clock metadata, `E.kind`, thread identity, frame representation,
  stack order, sample metric/weight, log severity/message, and span pairing.
- Define malformed-record behavior and hard limits for stack depth, frame text,
  messages, and custom fields.
- Add small hand-authored and large generated mixed-trace fixtures.

### 2. Separate the event spine from heap payloads

- Refactor storage with no visible behavior change.
- Preserve creator `seq`, replay, warnings, timelines, filtering, API output,
  and analysis persistence through compatibility tests.
- Measure heap-only memory, load, seek, filter, and render performance before
  and after; do not merge a regression hidden by functional tests.

### 3. Ship sampled CPU profiles as the first vertical slice

- Parse and intern frames/stacks.
- Add sample-density timeline lane, range selection, top-functions table, and
  flame graph.
- Add bounded profile summary/context API reads.
- Correlate selected profile ranges with heap births, deaths, retained bytes,
  sites, and allocation stacks.

Sampled profiles are the recommended first domain because they exercise the
highest-volume storage path and immediately answer useful heap questions.

### 4. Add structured logs and point stack traces

- Reuse the event spine, thread/process dictionaries, range selection, and
  virtualized event infrastructure.
- Add indexed severity/logger fields and bounded message search.
- Treat faults/crashes as point evidence carrying a stack and fields, not as
  proof of a heap defect.

### 5. Add spans and cross-domain analysis

- Pair span boundaries with explicit ids and parent links.
- Summarize heap and profile deltas per span/request.
- Add saved correlation views and canonical range/event annotations only after
  their ownership and persistence semantics are specified.

## Performance gates

- Heap-only storage must not gain dense profile/log/span columns.
- Heap seek, filtering, and address rendering must have unchanged asymptotic
  work and benchmark within an agreed noise budget on the existing corpus.
- Profile samples store integer ids after interning; no per-sample owned frame
  strings and no allocations in scan/aggregation hot loops.
- Timeline work remains proportional to pixels/bins plus logarithmic range
  lookup, never all records per frame.
- DOM lists and API reads remain virtualized/paged and bounded.
- Mixed-trace benchmarks must include evidence volume much larger than heap
  volume to catch accidental cross-domain scans.

## Decisions still needed before implementation

1. Exact frame identity: symbol only, or module/build-id/address plus optional
   file and line. The latter is more stable and supports delayed symbolization.
2. Whether the first producer emits already-symbolized stacks or raw addresses
   plus a module map.
3. Required multiprocess semantics and whether thread ids are unique only
   within a process.
4. Clock contract for evidence merged from external profilers. A unified file
   removes UI alignment controls, but does not remove the producer's need to
   normalize clocks correctly.
5. Flame-graph rendering strategy after representative sample counts and stack
   depths are measured.

The next planning step is to settle decisions 1–4 and write the mixed-record
trace semantics. Implementation should not begin with UI panels or generic
shell abstraction; the event spine and clock contract are the foundations.
