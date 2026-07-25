# 07 — Analysis: Tags, Marks, Filter, Crop, Persistence

The layer that turns the viewer into a workbench: user-authored state on top
of an immutable trace. Nothing here ever modifies the trace or its file.

## 7.1 The analysis objects

| Object | What it is | Anchored to |
|--------|-----------|-------------|
| **Tag** | Named, colored group of allocations. At most 255 per trace; each allocation carries at most one tag. | creator events |
| **Name** | Free-text label on a single allocation; shows in its in-map label, tooltip, panel, and search. | creator event |
| **Highlight color** | Per-allocation color override, visible in every color mode. | creator event |
| **Time mark (bookmark)** | Named playhead position; ⚑ flags on both timelines. | seq (+ t for display) |
| **Address mark** | Named horizontal flag line on the map; its row is pinned into the layout forever ([04-address-map §4.3](04-address-map.md)). | address |

Everything is anchored to creator event indices or seq — never to ids or
addresses (except address marks, whose point *is* the address) — so analysis
state stays valid under any view configuration and is cheap for the engine to
render.

## 7.2 Acquiring tags

- **Range tagging**: shift-drag a range on either timeline (or drag in the
  Events panel), then *Tag allocs* (created in range) or *Tag freed* (freed in
  range — the creator each `F`/`R` kills). Tagging by frees exists because
  "what died during this dip?" is as common a question as "what was born?".
- **Single tagging** from the allocation panel.
- **Filter-scoped**: when a filter is active, range tagging applies only to
  allocations the filter matches — the filter defines the working set, so
  filter+drag composes into "tag all `json_node` allocations born here".

Tags can be renamed, recolored, deleted (delete untags and compacts higher
tag ids down), and toggled visible per-tag; tag visibility participates in
the filter below.

## 7.3 Filter

The Filter panel selects by **site**, **thread**, **size range**, **address
range**, and **tag visibility** (including "untagged"). Two application modes,
chosen by the user: **dim others** (default — context stays visible) or **hide
others**. Empty selections are real constraints: unchecking every site means
"no site qualifies", not "no constraint". The filter applies everywhere
allocations render, (deliberately) also scopes range tagging (§7.2), and
drives the Events panel's "filtered" toggle
([06-playback-navigation §6.5](06-playback-navigation.md)).

Address ranges are a list, added by hand (two hex addresses) or from an
allocation's **match range** button, which seeds the list with that
allocation's own span. An allocation qualifies if it touches *any* range in
the list, so several ranges read as "or", matching how the site and thread
checkboxes already behave.

**Allocations without a site (or thread) are unconstrained by that
selection** — selecting "none" still shows them. Settled deliberately: the
site filter answers "which sites do I care about", and a record that never
named a site is not a member of any answer to that question; the alternative
(a "no site" pseudo-bucket with its own checkbox) buys precision that no
observed trace needs. Pinned by tests; do not change casually.

## 7.4 Crop

Crop restricts attention to allocations *created* in a seq window (set from a
range selection's popover). Unlike the transient selection it persists until
explicitly cleared (toolbar ✂ pill), and unlike the filter it **always dims,
never hides**, regardless of the filter's dim/hide mode — a deliberate
invariant so a crop can never silently empty the map. Crop bands show on both
timelines.

## 7.5 Range selection

Shift-drag on either strip (or the Events panel) creates a transient
selection in that domain, mirrored into the other domain on both strips and
the Events gutter. Its popover offers: **Zoom** (strip view), **Crop**, **Tag
allocs / Tag freed**. Escape clears.

## 7.6 The allocation panel and pinned windows

Clicking an allocation (or stepping onto an event) opens the allocation
panel: full info (id, range, size/usable, site, thread, birth/death, stack,
extra wire-format fields) plus the editing surface — name, tag, highlight
color, focus/birth/death navigation. **Pinning** (📌) freezes the current
panel as an independent window and lets the next selection open fresh; any
number of allocations can be pinned side by side for comparison
([09-ui-shell](09-ui-shell.md)).

## 7.7 Persistence: `.heapa` files and autosave

Two deliberately different persistence channels:

- **Marks** — the shareable deliverable: tags (+ per-event assignments),
  names, colors, bookmarks, address marks, plus trace fingerprint, playhead,
  and key view settings. Manually exported/imported as **`.heapa.json`** (a
  single JSON object marked `heapVisualizerAnalysis: 1`). Dropping one onto
  the page restores it; a trace-size mismatch warns but applies anyway.
  Anchoring by event index is what makes the file portable — it is only
  meaningful against the same trace.
- **Session** — working state, not a deliverable: layout settings, filter,
  crop, view zooms, window/drawer positions, pinned allocation windows (by
  creator event), playhead. Autosaved to `localStorage` keyed by trace file
  name and restored silently on load; no UI.

A third, tiny channel sits above both: **app preferences** (the overlap
display mode and the freed-nested ghost toggle) are how the user wants
*every* trace drawn, so they persist globally (`localStorage`, one key, not
trace-scoped) and restore at startup; a legacy per-trace `overlapMode` in an
old session blob is ignored rather than allowed to clobber them.

Marks additionally autosave to `localStorage` on the same key scheme, so a
plain refresh never loses un-exported work; the manual Save/Load buttons
remain the portable path. The exported `.heapa.json` also embeds the session
snapshot, making it a complete "everything as I left it" restore point.
