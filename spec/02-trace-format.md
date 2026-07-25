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

## 2.1 General rules

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

## 2.2 Record types (`op`)

Every record has an `op` field naming its type. Unknown `op` values are
skipped (forward compatibility).

| `op` | Meaning |
|------|---------|
| `H`  | **Header** — stream metadata. |
| `M`  | **Malloc** — a new allocation becomes live. |
| `F`  | **Free** — an existing allocation ends. |
| `R`  | **Realloc** — one allocation ends and a new one begins, atomically. |

## 2.3 Header record `H`

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

## 2.4 Malloc record `M`

An allocation `[addr, addr + size)` becomes live.

```json
{"seq":42,"t":10500,"op":"M","id":17,"addr":"0x555555551240","size":128,"thr":0,"site":"json_node"}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `id` | ✓ | Stream-unique allocation id. Never reused, even after the allocation is freed. |
| `addr` | ✓ | Base address (u64 hex string). |
| `size` | ✓ | **Requested** size in bytes, must be `> 0` (see §2.8). |
| `t` | rec | Timestamp. If absent, inherits the previous event's `t`. |
| `seq` | — | Event index; assigned from stream position if absent (§2.7). |
| `thr` | — | Originating thread id. |
| `site` | — | Allocation-site tag (function, symbol, stack-hash). Drives coloring and filtering. |
| `stack` | — | Call stack as an array of strings, outermost-last. |
| `usable` | — | Real usable size if the producer knows it (§2.8). |

## 2.5 Free record `F`

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

## 2.6 Realloc record `R`

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

## 2.7 Ordering, `seq`, and timestamps

- **Stream order is authoritative.** Events are applied in the order they
  appear. `seq`, if present, must equal the 0-based index among *event*
  records (header and comment lines excluded) and be strictly increasing; a
  mismatch is flagged once as a warning but stream order still wins.
- **Timestamps are monotonic non-decreasing.** Ties are allowed and are the
  point of the two-timeline design: many events sharing one `t` form a burst.
  A decreasing `t` is clamped to the previous value and flagged.
- Missing `t` inherits the previous event's timestamp.

## 2.8 Requested size vs. real footprint

`size` is the **requested** size. Real allocators round up and add header
overhead, so true footprints are larger and allocations are spaced apart. The
viewer renders the requested `[addr, addr+size)`; a producer that knows the
real usable size may add `usable` (int, bytes), which the viewer renders as a
lighter "slack" band beyond the requested region. `usable <= size` is treated
as absent.

## 2.9 Validity

Invalid input is a *property of the trace worth showing*, not a load error:
overlapping allocations, double frees, unknown ids, reused ids, zero sizes,
and malformed lines are all rendered as best as possible and surfaced as
warnings ([03-core-model §3.5](03-core-model.md)). The only records dropped
entirely are unparseable lines, records with no/unknown `op`, creator records
with no `addr`, and `F` with the null id.
