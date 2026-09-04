# Analysis state

Tags, names, colors, marks, and saved filters annotate a trace without changing
it. Their allocation identity is the creator event index, so annotations remain
stable across seeks and layout changes.

## Tags

A tag is a named, colored allocation set. Create memberships directly from an
Allocation panel, from allocations born/freed in a selected range, or by
snapshotting the applied filter. Range tagging intersects with the filter when
one is active. Tag legend chips add their predicate to the query; tag color mode
fills by first membership and shows additional memberships as stripes.

## Marks

[Marks](#show:analysis-panel) contains:

- time marks, added with `m`, which seek to a named playhead position;
- address marks, added with Shift-click, which keep an address row laid out;
- named allocations and saved filter expressions.

Rows can be renamed inline, and search (`g`) resolves all of them.

## Persistence

**Save…** writes `.heapa.json`: trace fingerprint, annotations, playhead, and
key view settings. **Load…** or dropping the file restores it; a fingerprint
mismatch warns but does not block the load. The same analysis autosaves locally
per trace filename. Layout, filter, crop, zoom, panel geometry, and pinned
windows are saved separately as view state.
