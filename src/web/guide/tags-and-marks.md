# Tags

A named, colored group of allocations. Up to 255 per trace, and an allocation
can be in any number of them. Everything is anchored to creator event indices,
so tags stay valid under any view setting.

Four ways to acquire them:

- **Range** — shift-drag a strip, then **Tag allocs** or **Tag freed**.
- **Direct** — the allocation panel's comma-separated tag field.
- **From a filter** — the Filter panel snapshots every allocation in the applied
  match set into a named tag. Later edits to the filter do not change the
  snapshot.
- **Filter-scoped range** — with a filter active, range tagging applies only to
  matching allocations. Filter plus drag reads as "tag all `json_node`
  allocations born here".

Adding a tag preserves memberships that are already there. Deleting one removes
that membership only. `tag == "a"` matches when any membership satisfies it.

Where they show: [tag color mode](#set:color-mode=5) fills by first tag with a
stripe per membership, tagged allocations carry a stripe along the bottom edge in
every mode, and each tag gets a legend chip that writes its predicate into the
filter.

Try it on [sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1): apply
[!freed](#set:filter-source=!freed), [Apply](#do:filter-apply), then tag the
matches from the Filter panel to get a `leaks` group that survives clearing the
filter.

# Marks

In [Marks](#show:analysis-panel), each row renameable inline.

- **Time mark** — a named playhead position, ⚑ on both strips. `m` adds one at
  the playhead. Click jumps in time and leaves the address view alone; ⌖ also
  centers the place.
- **Address mark** — a named line across the map at one address. Shift-click the
  map adds one. Its row stays laid out forever, so a marked address is always
  scrollable-to even when nothing there is live.
- **Named allocations** and **saved filters** are listed here too.

# Keeping the work

- **Save…** / **Load…** in the toolbar write a `.heapa.json`: tags and their
  overlapping memberships, names, colors, both kinds of mark, saved filters,
  plus the trace fingerprint, playhead, and key view settings. Drop one on the
  page to restore it. A trace-size mismatch warns and applies anyway.
- The same content autosaves to `localStorage` per trace file name, so a refresh
  loses nothing.
- Layout, filter, crop, zooms, window and drawer positions, and pinned
  allocation windows autosave separately, with no UI.
- Overlap display mode and the freed-nested toggle persist for every trace, not
  per trace.
