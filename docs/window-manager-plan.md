# Window manager & view unification — plan (draft)

**Status: proposal, not started.** Captures the discussion from 2026-07-21
so it survives context resets. Nothing in this doc has been implemented.

## The ask

Bar asked two related questions:

1. Make the address view a window, as well as time/events and the lanes.
2. Build better window-manager mechanisms in general.

## Where this fits the spec

Spec v2 Part III ("Analyzer architecture: views and lanes",
`SPECIFICATION.md` §6) already declares the end state: *"the address-line is
one view among peers"* and *"every open window is a view — a projection of
the document"*, coordinating only through the shared playhead/filter/
selection. Today the address view, the two timeline strips, and the lane
strip are still hardcoded fixtures in `#views` — this plan is what actually
gets them onto the same footing as the dockable panels (allocation detail,
span/log, events, warnings, etc.).

## Proposed order

Staged so each step is independently useful and the later ones fall out of
the earlier ones rather than needing to be built in parallel.

### 1. Layout-tree window manager (do this first)

Today's docking is three fixed 1-D drawers (left/right/bottom) plus a fixed
center — see `main.js` `UI.drawers`, `dockPanelAt`, `refreshDrawerDividers`,
`.drawer`/`.panel.docked` in `style.css`. Panels sharing a drawer just stack
and split the space evenly, which is why enough panels in one dock reads as
"crowded" — five panels in the right dock is five slivers, no tabs.

Replace it with a recursive split tree (VS Code / Perfetto style):

- Nodes are either a **split** (horizontal or vertical, with a divider) or a
  **tab group** (one or more views stacked as tabs, one visible at a time).
- The current three drawers become three regions of the same tree instead
  of special-cased containers; the center becomes just another (currently
  biggest) leaf.
- Dragging a window's header over another window shows a **five-zone
  overlay** (top/bottom/left/right/center) instead of today's edge-of-screen
  detection: drop on **center** = join as a tab; drop on an edge = split
  that node in that direction and place the view in the new pane.
- Keep today's per-panel chrome (`.panel-head`, close button, etc.) — the
  tree changes how panels are *arranged*, not what a panel looks like.
- Cheap wins to fold in here: double-click a header to maximize/restore a
  pane, double-click a divider to reset a split to 50/50, layout presets
  ("memory", "logs", "profiling") saved next to the per-run layout that
  already lives in `.heapa`.
- This is what makes step 3 (address view as a window) fall out for free:
  once the center is just a leaf in the tree, any view — including the
  address-line — can occupy it, get dragged out of it, or share it as a tab
  with something else.

Rough size estimate discussed: ~500–700 lines, reusing existing panel
chrome. Preference is to write this in-house rather than pull in a
dependency (Golden Layout, dockview) — the app is dependency-free today and
those libraries would fight the OffscreenCanvas/worker setup (see below).

### 2. Timeline view unification

Right now there are three independent hardcoded strips plus a separate Lanes
panel that only governs the third:

- `#strip-t` (temporal density) and `#strip-s` (sequential density) — each
  wired by `setupTimeline()` in `main.js`, each with its own zoom/pan/select
  handling, rendered by `hp_tl_render`/`hp_tl_hover` in the core
  (`core/src/timeline.rs`).
- `#lane-strip` (span/log lanes) — a separate rendering path in `main.js`
  (`buildLanes`/`renderLanes`), its own wheel-zoom handler that mirrors the
  temporal view, its own hit-testing.

Per spec v2 §6 "Lanes", these are conceptually the same thing: a lane =
**axis (temporal | sequential) × content (density | spans | logs | tags)**.
The plan is to fold all of them into one **Timeline** view containing the
full lane stack, with the existing Lanes panel governing visibility/order
for every lane kind (not just spans/logs as today). This:

- Kills the duplicated zoom/hover/selection code across three
  implementations.
- Makes "sequential-axis lanes" (spec's future item) just another lane
  instead of a parallel code path.
- Fixes the "lanes feel bolted on" complaint structurally, not cosmetically.

Editors in this space (Perfetto, Tracy, DAW timelines) keep the timeline as
a transport bar that's always visible and usually pinned at the top even
though everything around it is a floating/dockable pane. Recommendation:
give the Timeline view a sensible default pinned position (top of the
center area) even after it becomes a closable/dockable window, rather than
letting it wander to the same footing as, say, the Warnings panel.

### 3. Address view as a window

Mostly plumbing once step 1 exists: wrap `#addr-scroll` (canvas + overlay +
spacer + empty-hint) in `.panel` chrome and let it participate in the tree.
The OffscreenCanvas transfer, the ResizeObserver-driven resize messages, and
the scroll/overlay/marks machinery are already self-contained and don't care
where the element lives in the DOM.

**Constraint to respect:** keep it single-instance for this step. The
worker protocol (`worker.js`) keys everything by a fixed canvas name (`addr`,
`tlt`, `tls`) — `canvases.addr`, `ctxs.addr`, `hp_render_addr`, etc. all
assume exactly one address view. Supporting *two* address views (e.g. to
compare two regions side by side with different `row_bytes`) would need
every worker message and every `hp_*` WASM export that touches the address
view to carry an instance id. That's valuable eventually but is a distinct,
larger change — don't couple it to the windowing work.

### 4. (Later) multi-instance views

Once the above lands and if there's demand: instance-keyed worker messages
so any view (address-line, and eventually flame/lifetime/stats views from
the spec's "future views" list) can be opened more than once, each bound to
its own slice of state (e.g. two address views at different `row_bytes`, or
pinned to different crops).

## Non-goals / explicitly deferred

- Pulling in a third-party docking library — rejected in favor of an
  in-house layout tree that reuses existing panel chrome and doesn't fight
  the worker/OffscreenCanvas architecture.
- Multi-instance views (step 4) is out of scope until steps 1–3 are done and
  there's an actual need.
- This doc does not cover the other open spec-v2 items already tracked in
  `TASKS.md` (analysis spans on lanes, log importer, anomaly view, rename) —
  those are independent of the window manager work.

## Next step

Waiting on Bar to confirm the order above (or adjust it) before starting
implementation. If confirmed, step 1 (layout-tree manager) is the first
piece of actual code.
