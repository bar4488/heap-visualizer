# 6. Keep the result

Turn the current query result into data you can revisit. Enter
[surviving buffers](#set:filter-tag-name=surviving buffers), then click
[Tag matches](#do:filter-to-tag).

Clear the query with [Clear](#do:filter-clear). The filter disappears, but the
tag remains: **Tag matches** captured a set of allocation identities rather than
a live query. Switch to [tag color](#set:color-mode=5) to see the set on the
map.

Open [Marks](#show:analysis-panel). This is the analysis layer:

- tags are named allocation sets;
- time and address marks name positions in the trace and map;
- allocation names and colors annotate individual objects;
- saved filters preserve query source for reuse.

All allocation annotations key off creator event indices, so they survive seeks
and layout changes. Press `m` to add a time mark at the playhead; Shift-click
the map to add an address mark. Search (`g`) resolves marks and allocation names.

**Save…** writes this layer to `.heapa.json` with the trace fingerprint,
playhead, and key view settings. **Load…** or dropping that file restores it.
The trace itself is unchanged, and both trace and analysis remain in the
browser.

You now have the core workflow: load, orient spatially, seek, inspect, query,
and preserve the result.
