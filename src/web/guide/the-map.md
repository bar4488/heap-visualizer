# Address map

The map is the live allocation set at the playhead, projected onto rows of the
address space. For address `A`, base `B`, and row width `W`:

```
row    = floor((A - B) / W)
column = (A - B) mod W
```

`B` is the lowest observed address (or lower `arena_base`) rounded to a row;
`W` is `row_bytes`, default `0x1000`. Allocations wrap across rows. Change `W`
in [Layout](#show:layout-panel), for example to
[0x400](#set:row-bytes=0x400), to inspect fragmentation at another scale.

Empty row runs collapse. **all rows** keeps every row ever touched in the
layout, preventing reflow while seeking; [disable it](#set:show-all=false) for
maximum density. Address marks also keep their row present.

Base rendering is green for live, red for freed, and orange for overlapping
live allocations. Slack between requested and `usable` size is lighter. Use
[defects.heapl](index.html?trace=guide/traces/defects.heapl&guide=1) to inspect
overlap, nested frees, slack, double-free, and unknown-free handling.

## Encoding

[Appearance](#show:appearance-panel) selects live, site, thread, size, age, or
tag coloring. Site and thread are categorical; size and age are logarithmic;
tag mode fills from the first tag and stripes every membership. Explicit
allocation colors remain visible in every mode.

[colors.heapl](index.html?trace=guide/traces/colors.heapl&guide=1) is structured
to make those encodings legible. Ctrl/Alt-wheel zooms the byte axis around the
cursor; Shift-wheel pans it. Row height changes only display density.
