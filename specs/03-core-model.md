# 03 — Core Data Model

How the engine represents a loaded trace and answers the question every view
asks: *what is live at the playhead?*

## 3.1 The columnar store

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

## 3.2 Identity: ids resolve to event indices at load

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

## 3.3 The live set

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

## 3.4 Time travel: seeks and snapshots

Seeking to seq *n* means reconstructing the live set after *n* events.

- Events apply **bidirectionally**: every op has an inverse (an `F` un-applies
  by re-inserting its target), so short seeks in either direction replay
  incrementally from the current position.
- For long jumps the parser leaves behind **periodic snapshots** of the live
  set (creator-index lists, taken every N events during the load pass). A seek
  picks whichever is cheaper: incremental replay from where it is, or rebuild
  from the nearest snapshot at-or-before the target plus forward replay. This
  bounds worst-case seek cost to roughly one snapshot interval regardless of
  trace length.
- Snapshot count is capped (~96): when full, every other snapshot is dropped
  and the interval doubles, keeping memory bounded on huge traces while
  degrading seek cost only logarithmically. Snapshots are a viewer-internal
  tuning mechanism, never part of the stream.
- Seeking **by time** first maps `t` to the seq of the last event with
  `t' <= t` (binary search over the monotonic `t` column), then seeks by seq.
  `seq` is the canonical coordinate; `t` is a lookup into it.

## 3.5 Warnings

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

Full counts per code are always kept; detailed records are capped (first
1000) so a pathological trace cannot blow up memory. The UI shows a toolbar
badge with the total and a panel listing each warning; clicking one jumps to
the offending event. Overlap is *also* flagged spatially: pixels covered by
two live allocations render orange ([04-address-map](04-address-map.md)).

## 3.6 Derived load-time indexes

Everything expensive is computed once, in the same single parse pass, so the
UI never triggers a full-trace scan after load:

- target/death links and snapshots (above);
- **prefix sums** of green (`M`/`R`) and red (`F`/`R`) event counts, which
  make timeline density binning O(width) instead of O(events)
  ([05-timelines](05-timelines.md));
- global stats: t/addr ranges, peak live bytes, total allocated bytes, op
  counts, per-site and per-thread counts, and the largest single span (used
  to bound hit-test scans).

## 3.7 Session state in the store

One store column is **not** derived from the trace: `tag[e]`, the
user-assigned tag id per creator event (0 = untagged, at most 255 tags). Tags
live in the store because the engine renders and filters by them, but they are
session state owned by the analysis layer ([07-analysis](07-analysis.md)) and
are never read from or written to the wire format.
