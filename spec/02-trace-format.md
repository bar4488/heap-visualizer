# 02 — Trace Format (`.heapl`, JSONL)

The input stream is **JSON Lines**: UTF-8 text, one JSON object per line,
`\n`-separated. Conventional extension: **`.heapl`**.

**Why JSONL (a decision, not an accident):** debuggability and zero-tooling
authoring dominate at this stage of the project — a trace is greppable,
hand-writable, and diffable. Parse cost is a one-time load hidden in a worker.
A fixed-width binary format is the natural successor once load time on huge
traces matters; it would be a pure encoding change with identical semantics,
which is why everything below is defined in terms of records and fields, not
bytes.

## TRACE-001: General rules

- Each line is a complete, self-contained JSON object.
- **Field order is not significant.** Parsers must not depend on it.
- Objects **may** carry fields not defined here; consumers **must** preserve
  and ignore unknown fields. This is the forward-compatibility mechanism — new
  metadata never breaks old viewers. (The viewer goes further: unrecognized
  fields on events are kept verbatim and shown in the allocation panel, so
  producers can attach domain data like pool names or refcounts for free.)
- Numbers (`t`, `size`, `seq`, `id`, `thr`) are JSON integers.
- **Addresses are strings** (`"0x555555550000"`), because a 64-bit address does
  not fit safely in a JSON double. Hex, `0x`-prefixed, lowercase preferred;
  consumers tolerate uppercase, a missing prefix, and plain decimal.
- Empty lines and lines whose first non-whitespace character is `#` are
  ignored, so hand-authored files can carry comments and separators.

## TRACE-002: Record types (`op`)

Every record has an `op` field naming its type. Unknown `op` values are
skipped (forward compatibility).

| `op` | Meaning |
|------|---------|
| `H`  | **Header** — stream metadata. |
| `M`  | **Malloc** — a new allocation becomes live. |
| `F`  | **Free** — an existing allocation ends. |
| `R`  | **Realloc** — one allocation ends and a new one begins, atomically. |
| `E`  | **Custom event** — a producer's own landmark; not an allocation ([TRACE-010](#trace-010-custom-event-record-e)). |

## TRACE-003: Header record `H`

The header **should** be the first line; at most one per stream. All fields
except `op` and `v` are optional. If no header is present, consumers assume
`v:1`, `unit:"ns"`, and auto-fit the address range.

```json
{"op":"H","v":1,"unit":"ns","arena_base":"0x555555550000","row_bytes":4096,"title":"seed=1"}
```

| Field | Meaning |
|-------|---------|
| `v` | Format version. This spec is version `1`; other values are flagged as a warning but parsed anyway. |
| `unit` | Time unit of every `t`: `"ns"` (default), `"us"`, `"ms"`, `"s"`, or `"tick"`. Display-only; never changes ordering. |
| `arena_base` | Lowest address the viewer should expect. A layout hint; the viewer still auto-fits to observed addresses. |
| `row_bytes` | Suggested default row width. A starting value only; the viewer's live control overrides it. |
| `title` | Human label for the trace, shown in the toolbar. |
| `meta` | Free-form producer metadata object (command line, allocator name, …). |

## TRACE-004: Malloc record `M`

An allocation `[addr, addr + size)` becomes live.

```json
{"seq":42,"t":10500,"op":"M","id":17,"addr":"0x555555551240","size":128,"thr":0,"site":"json_node"}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `id` | ✓ | Stream-unique allocation id. Never reused, even after the allocation is freed. |
| `addr` | ✓ | Base address (u64 hex string). |
| `size` | ✓ | **Requested** size in bytes, must be `> 0` (see [TRACE-008](#trace-008-requested-size-vs-real-footprint)). |
| `t` | rec | Timestamp. If absent, inherits the previous event's `t`. |
| `seq` | — | Event index; assigned from stream position if absent ([TRACE-007](#trace-007-ordering-seq-and-timestamps)). |
| `thr` | — | Originating thread id. |
| `site` | — | Allocation-site tag (function, symbol, stack-hash). Drives coloring and filtering. |
| `stack` | — | Call stack as an array of strings, outermost-last. |
| `usable` | — | Real usable size if the producer knows it ([TRACE-008](#trace-008-requested-size-vs-real-footprint)). |

## TRACE-005: Free record `F`

An allocation ends, referenced **by `id`**.

```json
{"seq":57,"t":11020,"op":"F","id":17,"addr":"0x555555551240","size":128,"thr":0}
```

`addr` and `size` are optional, redundant convenience copies — authoritative
geometry always comes from the matching creator record. Producers should
include them (cheap, and lets simple tools interpret a free in isolation);
consumers must not require them.

**`free(NULL)` / no-op frees** should simply be omitted from the stream. A
producer that must record them emits `id:0` (the reserved null id), which
consumers drop entirely.

## TRACE-006: Realloc record `R`

Models `realloc`: the old allocation ends and a new one begins — possibly at a
new address, possibly the same. Emitting a single `R` rather than an `F`+`M`
pair is deliberate: it preserves the *move* relationship, so the viewer can
draw a link between old and new regions when stepping. A consumer that does
not care may treat `R` as exactly that pair, applied atomically at one
`seq`/`t`.

```json
{"seq":88,"t":12030,"op":"R","id":40,"old_id":17,"addr":"0x555555560000","size":512,
 "old_addr":"0x555555551240","old_size":128,"thr":0,"site":"json_node"}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `id` | ✓ | id of the **new** allocation (fresh, never reused). |
| `old_id` | ✓ | id of the allocation being replaced; it dies at this event. |
| `addr`, `size` | ✓ | New geometry (`addr` may equal `old_addr` for in-place grow/shrink). |
| `old_addr`, `old_size` | — | Convenience copies; the resolved creator record wins when both exist. |
| `t`, `seq`, `thr`, `site`, `stack`, `usable` | — | As for `M`. |

## TRACE-007: Ordering, `seq`, and timestamps

- **Stream order is authoritative.** Events are applied in the order they
  appear. `seq`, if present, must equal the 0-based index among *event*
  records (header and comment lines excluded) and be strictly increasing; a
  mismatch is flagged once as a warning but stream order still wins.
- **Timestamps are monotonic non-decreasing.** Ties are allowed and are the
  point of the two-timeline design: many events sharing one `t` form a burst.
  A decreasing `t` is clamped to the previous value and flagged.
- Missing `t` inherits the previous event's timestamp.

## TRACE-008: Requested size vs. real footprint

`size` is the **requested** size. Real allocators round up and add header
overhead, so true footprints are larger and allocations are spaced apart. The
viewer renders the requested `[addr, addr+size)`; a producer that knows the
real usable size may add `usable` (int, bytes), which the viewer renders as a
lighter "slack" band beyond the requested region. `usable <= size` is treated
as absent.

## TRACE-009: Validity

Invalid input is a *property of the trace worth showing*, not a load error:
overlapping allocations, double frees, unknown ids, reused ids, zero sizes,
and malformed lines are all rendered as best as possible and surfaced as
warnings ([MODEL-005](03-core-model.md#model-005-warnings)). The only records dropped
entirely are unparseable lines, records with no/unknown `op`, creator records
with no `addr`, and `F` with the null id.

## TRACE-010: Custom event record `E`

A record a producer emits to mark a place in its own program — a phase, a
frame, a request boundary — rather than an allocation operation.

```json
{"seq":21,"t":6804,"op":"E","title":"phase: request","phase":"request","frame":1}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `title` | — | Human label for this event, shown wherever it is listed. |
| `t`, `seq`, `thr` | — | As for `M`. |

It **must** occupy an event index like any other record, so the playhead can
rest on it and `seq` keeps counting stream positions. It **must not** affect
allocation state in any way: nothing becomes live or dies, the address range
and the size totals are unchanged, and it contributes no allocation or free
mark to either timeline. A trace's live set at every playhead position must be
identical to that of the same trace with its `E` records removed.

Every other unrecognized top-level key is an ordinary custom field
([TRACE-001](#trace-001-general-rules)) and is catalogued as one. `site` and
`stack` describe an allocation and are not read off an `E` record.

Because an `E` record is not an allocation, nothing that resolves an event to
an allocation may resolve one: it is never selected, never highlighted on the
map, never tagged, never named, and never matched by a filter
([ANL-003](07-analysis.md#anl-003-filter)) — the filter language is over
allocations, so the filtered event list omits `E` records entirely.
