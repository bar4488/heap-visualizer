# Filters

One expression over allocations, written in [Filter](#show:filter-panel). **dim
others** keeps the surrounding heap visible; **hide others** removes it.

The subject is always the creator allocation. The language ignores the
playhead: `freed` and `lifetime` describe the whole trace. A `live_now` field
would invalidate the match set on every seek, so there isn't one.

## Fields

- `size` — requested bytes. `usable` is what the producer reported, often
  absent.
- `address`, `end`, `span` — `end` is `address + max(size, usable)`; `span` is
  the range between them. `span overlaps A..B` is the range test.
- `seq`, `time` — the birth event.
- `freed`, `lifetime`, `death.seq`, `death.time` — the matching death, absent
  when there is none.
- `site`, `thread`, `tag`, `name` — each can be missing, and missing is its own
  state: write `site is missing`, not `site == ""`.
- `id`, `stack`.

## Grammar

- Comparisons do not chain. Write `0 <= size && size < 4096`.
- `!` takes a boolean.
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

- [size >= 4096](#set:filter-source=size >= 4096) matches 6.
- [site == "json_node"](#set:filter-source=site == "json_node") matches 10.
- [!freed](#set:filter-source=!freed) matches the 5 that leak.
- [site == "read_buffer" && !freed](#set:filter-source=site == "read_buffer" && !freed)
  matches 2.

[Apply](#do:filter-apply) after setting one, or [Clear](#do:filter-clear).

Three things write the expression for you, all editing that same source:

- Legend chips toggle their own predicate as a top-level conjunct and apply.
  Shift-click uses a disjunction. String values are escaped, and an existing
  top-level disjunction is parenthesized so its meaning survives.
- **match range** on the allocation panel replaces it with
  `span overlaps <addr>..<end>`.
- Saving under a name keeps the source text, per trace. Setting a saved filter
  again applies it.
