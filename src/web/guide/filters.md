# Query language

[Filter](#show:filter-panel) evaluates one Python-shaped expression over every
allocation. **dim others** preserves heap context; **hide others** removes
non-matches. Typing only checks the expression; **Apply** compiles and scans it.
An invalid draft leaves the previous filter active.

The object model has three roots:

- `alloc`: `id`, `address`, `end`, `span`, `size`, `usable`, `tags`, `freed`,
  and `lifetime`;
- `malloc`: creator `seq`, `time`, `site`, `thread`, `stack`, and
  `fields.<key>`;
- `free`: terminating `seq`, `time`, and `fields.<key>`, or absent.

The match set describes the complete trace, independent of the playhead.
Optional values use `is None`; operations on a missing value are false.

## Examples

- `0 <= alloc.size < 4096`
- `alloc.address in range(0x1000, 0x1800)`
- `alloc.span.overlaps(range(A, B))`
- `malloc.site.startswith("json_") and not alloc.freed`
- `"hot" in alloc.tags`
- `alloc.tags == {"a", "b"}` or `alloc.tags == {}`
- `malloc.fields.pool == "request"`

`range` is half-open. Numeric literals accept units (`4KiB`) and separators
(`0x7f00_0000`). Ctrl/Cmd-Space requests type-aware completion from the same
catalog used by the checker.

Against [sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1), try
[alloc.size >= 4096](#set:filter-source=alloc.size >= 4096) or
[malloc.site == "json_node"](#set:filter-source=malloc.site == "json_node"),
then [Apply](#do:filter-apply). [Clear](#do:filter-clear) disables filtering.

Legend chips, Allocation's **match range**, and saved filters all rewrite this
same source. **Tag matches** snapshots the current applied set; later query edits
do not change that tag.
