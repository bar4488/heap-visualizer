# 07 — Analysis: Tags, Marks, Filter, Crop, Persistence

The layer that turns the viewer into a workbench: user-authored state on top
of an immutable trace. Nothing here ever modifies the trace or its file.

## ANL-001: The analysis objects

| Object | What it is | Anchored to |
|--------|-----------|-------------|
| **Tag** | Named, colored group of allocations. At most 255 per trace; each allocation carries at most one tag. | creator events |
| **Name** | Free-text label on a single allocation; shows in its in-map label, tooltip, panel, and search. | creator event |
| **Highlight color** | Per-allocation color override, visible in every color mode. | creator event |
| **Time mark (bookmark)** | Named playhead position; ⚑ flags on both timelines. | seq (+ t for display) |
| **Address mark** | Named horizontal flag line on the map; its row is pinned into the layout forever ([MAP-003](04-address-map.md#map-003-layout-stability)). | address |
| **Saved filter** | Named version-1 filter source that can be set and applied again. | trace analysis |

Everything is anchored to creator event indices or seq — never to ids or
addresses (except address marks, whose point *is* the address) — so analysis
state stays valid under any view configuration and is cheap for the engine to
render.

## ANL-002: Acquiring tags

- **Range tagging**: shift-drag a range on either timeline (or drag in the
  Events panel), then *Tag allocs* (created in range) or *Tag freed* (freed in
  range — the creator each `F`/`R` kills). Tagging by frees exists because
  "what died during this dip?" is as common a question as "what was born?".
- **Single tagging** from the allocation panel.
- **Filter-scoped**: when a filter is active, range tagging applies only to
  allocations the filter matches — the filter defines the working set, so
  filter+drag composes into "tag all `json_node` allocations born here".

Tags can be renamed, recolored, and deleted (delete untags and compacts higher
tag ids down). Filtering by tag is expressed in the Filter panel below.

## ANL-003: Filter

The Filter panel is one multiline allocation-expression editor plus **dim
others** (default) / **hide others** presentation mode. The expression surface
and semantics are the version-1 DSL defined by
[E010](../docs/explorations/E010-filter-expression-language.md): there are no
checkbox predicates, quick filters, or hidden conjunctions with another
representation.

The visible draft and the last successfully applied source are separate.
Typing performs a debounced check but never changes visibility; **Apply**
compiles and scans in the worker. A diagnostic leaves the previous applied
filter active. Applying an empty source turns filtering off. Dim/hide changes
immediately when a non-empty filter is active because it does not change the
match set.

Site, thread, and tag legend chips are expression-writing actions, not another
filter state. Clicking one toggles its visible predicate as a top-level
conjunct and immediately applies the result; Shift-click uses a disjunction.
Active styling is derived from the successfully applied source. String values
are escaped as DSL literals, and adding a conjunct parenthesizes an existing
top-level disjunction so its meaning is preserved.

The current expression can be saved under a trace-local name. The Filter panel
lists saved filters and can set and apply one again, rename it, or delete it.
Saving an existing name overwrites its source. A saved filter is source text,
not a compiled plan or a live match set.

The focused editor offers contextual completion from the same core catalog
that checks the expression: executable fields, type-valid operators and
members, and observed site/thread/tag values. The attached list opens while
typing; **Ctrl/⌘+Space** also opens it at an empty source. Up/Down selects,
Enter or Tab inserts without applying, and Escape closes it. Completion never
advertises a language surface the evaluator does not implement.

The core owns checking, evaluation, and one creator-allocation match bitset.
Rendering, filter-scoped range tagging ([ANL-002](#anl-002-acquiring-tags)),
and the Events panel's filtered index
([NAV-005](06-playback-navigation.md#nav-005-the-events-panel)) all consume
those same match bits. The allocation panel's **match range** action replaces
the expression with visible source of the form
`span overlaps 0x1000..0x1800` and applies it immediately; it does not mutate
separate filter state.

Only the successfully applied source, dim/hide mode, and filter-language
version persist in the heap session. An unapplied draft, compiled plan, and
match bits do not.

## ANL-004: Crop

Crop restricts attention to allocations *created* in a seq window (set from a
range selection's popover). Unlike the transient selection it persists until
explicitly cleared (toolbar ✂ pill), and unlike the filter it **always dims,
never hides**, regardless of the filter's dim/hide mode — a deliberate
invariant so a crop can never silently empty the map. Crop bands show on both
timelines.

## ANL-005: Range selection

Shift-drag on either strip (or the Events panel) creates a transient
selection in that domain, mirrored into the other domain on both strips and
the Events gutter. Its popover offers: **Zoom** (strip view), **Crop**, **Tag
allocs / Tag freed**. Escape clears.

## ANL-006: The allocation panel and pinned windows

Clicking an allocation (or stepping onto an event) opens the allocation
panel: full info (id, range, size/usable, site, thread, birth/death, stack,
extra wire-format fields) plus the editing surface — name, tag, highlight
color, focus/birth/death navigation. **Pinning** (📌) freezes the current
panel as an independent window and lets the next selection open fresh; any
number of allocations can be pinned side by side for comparison
([09-ui-shell](09-ui-shell.md)).

## ANL-007: Persistence — `.heapa` files and autosave

Two deliberately different persistence channels:

- **Marks** — the shareable deliverable: tags (+ per-event assignments),
  names, colors, bookmarks, address marks, saved filters, plus trace
  fingerprint, playhead, and key view settings. Manually exported/imported as **`.heapa.json`** (a
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

## ANL-008: The session blob's shape

The session blob must separate the two kinds of state it carries. Its top
level is a single JSON object marked `heapVisualizerSession: 1` holding only
workspace state — panel window geometry and drawer layout — and everything
whose meaning comes from a heap trace must sit under a `heap` key carrying its
own `version`. Reading a blob whose `heap` version is not one this build knows
must restore the workspace state and leave heap state at its defaults, rather
than apply the section partially. A blob written in the pre-namespace shape,
with the heap fields at the top level and no `heap` key, must still restore
in full.
