# Filters

One expression over allocations, written in [Filter](#show:filter-panel). **dim
others** keeps the surrounding heap visible; **hide others** removes it.

**It is a Python expression.** `and`, `or`, `not`, `in`, `is None`, chained
comparisons, `len()` — all mean what they mean in Python. The language ignores
the playhead: `alloc.freed` and `alloc.lifetime` describe the whole trace. A
`live_now` field would invalidate the match set on every seek, so there isn't
one.

## The three objects

Every field hangs off one of three: the allocation, and the two records that
bound its life.

- **`alloc`** — the allocation itself. `size`, `usable`, `address`, `end`,
  `span`, `id`, `tags`, `freed`, `lifetime`.
- **`malloc`** — the record that created it. `seq`, `time`, `site`, `thread`,
  `stack`, and `fields.<key>` for the producer's own.
- **`free`** — the record that ended it, or nothing. `seq`, `time`, and
  `fields.<key>`.

`site` and `thread` are on `malloc` because that is the record carrying them —
an `F` record has neither. Type `alloc.` and the completion list is the whole
object.

Anything on `malloc` or `free` can be absent, and absent is its own state:
write `malloc.site is None`, not `malloc.site == ""`. Every other operation on
a missing value is false, so an allocation with no site never matches
`malloc.site.startswith("x")` and never matches its negation either.

## Writing it

- `"x" in alloc.tags` — membership, the same `in` that tests a set, a
  substring of `malloc.site`, a frame of `malloc.stack`, and a `range`.
- `alloc.address in range(0x1000, 0x1800)` — half-open, like Python's.
- `alloc.span.overlaps(range(A, B))` — the range test against an allocation.
- `0 <= alloc.size < 4096` — comparisons chain.
- `malloc.site.startswith("x")`, `.endswith("x")`.
- `alloc.tags == {"a", "b"}` is exact set equality; `alloc.tags == {}` is
  untagged; `len(alloc.tags) > 1` counts.
- Sizes accept units — `4KiB`. Addresses accept `_` separators —
  `0x7f00_0000`.
- Ctrl or Cmd with Space opens completions. They come from the same catalog
  that checks the expression, so they only offer what the evaluator implements.

## Applying

Typing checks the expression and changes nothing. **Apply** compiles and scans.
On a diagnostic the previous filter stays active. Applying an empty source
turns filtering off, same as **Clear**.

Against [sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1) — 16
allocations:

- [alloc.size >= 4096](#set:filter-source=alloc.size >= 4096) matches 6.
- [malloc.site == "json_node"](#set:filter-source=malloc.site == "json_node")
  matches 10.
- [not alloc.freed](#set:filter-source=not alloc.freed) matches the 5 that
  leak.
- [malloc.site == "read_buffer" and not alloc.freed](#set:filter-source=malloc.site == "read_buffer" and not alloc.freed)
  matches 2.

[Apply](#do:filter-apply) after setting one, or [Clear](#do:filter-clear).

Three things write the expression for you, all editing that same source:

- Legend chips toggle their own predicate as a top-level conjunct and apply.
  Shift-click uses a disjunction. String values are escaped, and an existing
  top-level disjunction is parenthesized so its meaning survives.
- **match range** on the allocation panel replaces it with
  `alloc.span.overlaps(range(<addr>, <end>))`.
- Saving under a name keeps the source text, per trace. Setting a saved filter
  again applies it.
