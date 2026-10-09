# 03 — Core Data Model

How the engine represents a loaded trace and answers the question every view
asks: *what is live at the playhead?*

## MODEL-001: The columnar store

The parsed trace lives in a **struct-of-arrays store** (`core/src/store.rs`):
one flat `Vec` per field (`op`, `t`, `id`, `addr`, `size`, …), indexed by
event index. This is a deliberate performance choice over an
array-of-structs / object-per-event model: render and scan passes touch only
the columns they need, memory is compact and cache-friendly, and the layout
survives millions of events without GC pressure — the JS side never holds the
trace at all.

Strings are **interned once at load**: sites, threads, stacks, and
extra-field blobs each get a small table plus a per-event index column. Hex
address strings are parsed to `u64` at load and never exist as strings again
internally.

The store is split along the domain boundary of
[DOM-001/DOM-002](13-domains-and-logs.md#dom-001-one-event-spine):

- the **event spine** holds the columns every record has — `op`, `t`, and
  thread — one row per record of any domain, indexed by `seq`;
- the **heap domain** (`HeapCols`) holds `id`, `addr`, `size`, `usable`,
  site, stack, custom-field fragment, `target`/`death` links, the timeline
  prefix sums, and the tag bitsets — one row per heap record (`M`, `F`,
  `R`), never one per record of another domain;
- each further domain keeps its own store keyed by spine index: the
  **marks** domain holds the `E` landmarks (title and custom fields), and
  the **log** domain the `L` records
  ([LOG-003](13-domains-and-logs.md#log-003-the-log-store)). Both are
  point stores ([DOM-004](13-domains-and-logs.md#dom-004-the-domain-registry)).

Which domain a record belongs to is decided by one table from op to
(domain, kind) — never by op numbering — and the domain stores sit side by
side as concrete fields, so heap work reaches its columns directly. A
landmark's custom fields stay in the trace-wide fragment table and field
catalog, which the allocation filter reads, exactly as when landmarks were
heap rows.

Heap rows are read **by spine index** through accessors. While every record
is a heap record the heap row *is* the spine index and no mapping exists; the
first non-heap record (a log line or a landmark) materializes a spine→heap rank (`hrank`) and a
heap→spine column, so a heap-only trace pays nothing for the boundary. Link
values stay spine indexes, so allocation identity (MODEL-002) is unchanged by
the presence of other domains.

Heap *work* runs in heap-row space and converts only at its boundaries
(`hrank` for spine→heap, the heap→spine column, or a binary search over
`t`). The allocation filter's plan, its match bitset, and the tag bitsets
are all over heap rows, so the column-slice and tag-word fast paths hold in a
mixed trace; replay and the Events-list filter walk heap rows; and range
reads (tagging a seq range, the agent timeline) visit only the heap records
inside the range. The cost of these operations follows the heap record
count, not the spine length: `cargo run --release --example mixed_bench
--manifest-path src/core/Cargo.toml` compares heap-only against the same
heap records with 10× and 100× as many log lines, and the mixed columns
should match the heap-only one within noise. What still grows with the spine
is per-record load cost, the timeline's per-column binary searches and log
lane (O(width · log n)), and a few percent on random seeks, whose replay
reads spine-indexed accessors.

## MODEL-002: Identity — ids resolve to event indices at load

The wire format names allocations by `id`; the engine does not. During the
single parse pass every `F`/`R` is resolved against an id→creator map into two
link columns:

- `target[e]` — for `F`/`R` events: the creator event index being killed.
- `death[e]` — for creator events: the event index that kills this
  allocation, if any.

After load, **an allocation *is* its creator event index**; `id` is kept only
for display. This makes every downstream operation (liveness, tagging,
selection, links) integer array indexing with no hash lookups, and gives every
allocation a stable identity even in malformed traces where ids are reused.

## MODEL-003: The live set

Applying events left-to-right:

- `M` → add the creator to the live set.
- `F` → remove its `target` (if resolved).
- `R` → remove `target`, add the creator.

The picture at a playhead position is **the live set at that position** —
nothing more. Rendering is a pure function of (store, playhead, view config),
which is what makes time travel trivial to reason about.

At runtime the live set is a `View` (`core/src/state.rs`) holding the
allocations ordered by `(addr, creator)` — address order is what both
rendering and hit-testing walk — plus running `live_count` / `live_bytes`
tallies and a per-row occupancy count that feeds the address-map layout
([04-address-map](04-address-map.md)).

## MODEL-004: Time travel — seeks and snapshots

Seeking to seq *n* means reconstructing the live set after *n* events.

- Events apply **bidirectionally**: every op has an inverse (an `F` un-applies
  by re-inserting its target), so short seeks in either direction replay
  incrementally from the current position.
- For long jumps the parser leaves behind **periodic snapshots** of the live
  set (creator-index lists, taken every N events during the load pass). A seek
  picks whichever is cheaper: incremental replay from where it is, or rebuild
  from the nearest snapshot at-or-before the target plus forward replay. This
  bounds worst-case seek cost to roughly one snapshot interval regardless of
  trace length. Both costs — and the snapshot cadence — are counted in heap
  records: other domains' records cannot change the live set, so replay
  skips them without visiting them.
- Snapshot count is capped (~96): when full, every other snapshot is dropped
  and the interval doubles, keeping memory bounded on huge traces while
  degrading seek cost only logarithmically. Snapshots are a viewer-internal
  tuning mechanism, never part of the stream.
- Seeking **by time** first maps `t` to the seq of the last event with
  `t' <= t` (binary search over the monotonic `t` column), then seeks by seq.
  `seq` is the canonical coordinate; `t` is a lookup into it.

## MODEL-005: Warnings

The parser validates while it loads and records per-event warnings instead of
rejecting input (goal: *faithful*). Warning codes:

| Code | Meaning |
|------|---------|
| malformed | Line was not a parseable record; skipped. |
| t-decrease | Timestamp went backwards; clamped to previous. |
| seq-mismatch | `seq` field disagrees with stream position (reported once). |
| unknown-id | `F`/`R` referenced an id never seen. |
| double-free | `F`/`R` referenced an already-dead allocation. |
| dup-id | An id was reused while still live. |
| overlap | A new allocation overlaps a live region. |
| bad-size | Creator with missing/zero `size` (rendered as 1 byte). |
| version | Header declared a version other than 1. |
| bad-level | `L` record whose `level` is not a known level name; read as `info` ([LOG-001](13-domains-and-logs.md#log-001-the-log-record-l)). |
| long-log | `L` record whose `msg` exceeded 16 KiB; truncated, record kept. Detail is the original byte length. |
| too-many-threads | A record on a thread beyond the first 65,535 distinct `thr` values; its thread is read as absent rather than aliased to another. Detail is the `thr` value. |

The agent API names these `bad_level`, `long_log` and `too_many_threads`;
numeric codes are 9, 10 and 11, after `version` (8).

Full counts per code are always kept; detailed records are capped (first
1000) so a pathological trace cannot blow up memory. The UI shows a toolbar
badge with the total and a panel listing each warning; clicking one jumps to
the offending event. Overlap is *also* flagged spatially: pixels covered by
two live allocations render orange ([04-address-map](04-address-map.md)).

## MODEL-006: Derived load-time indexes

Everything expensive is computed once, in the same single parse pass, so the
UI never triggers a full-trace scan after load:

- target/death links and snapshots (above);
- **prefix sums** of green (`M`/`R`) and red (`F`/`R`) event counts, which
  make timeline density binning O(width) instead of O(events)
  ([05-timelines](05-timelines.md));
- global stats: t/addr ranges, peak live bytes, total allocated bytes, op
  counts, per-site and per-thread counts, and the largest single span (used
  to bound hit-test scans).

## MODEL-007: Session state in the store

One store index is **not** derived from the trace: sparse membership bitsets
from user-assigned tag ids to creator events (at most 255 named tags).
Allocations may occur in several bitsets. Tags live in the store because the
engine renders and filters by them, but they are session state owned by the
analysis layer ([07-analysis](07-analysis.md)) and are never read from or
written to the wire format.
