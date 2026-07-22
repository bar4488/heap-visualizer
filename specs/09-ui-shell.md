# 09 — UI Shell: Toolbar, Windows, Docking

The chrome around the three views. Guiding stance: the views own the screen;
everything else is a **window** the user summons, places, and dismisses.

## 9.1 Layout

- **Toolbar** (top): open/demo, trace title, panel toggles (Play, Layout,
  Filter, Events, Marks), horizontal-zoom pill, crop pill, marks Save/Load,
  jump box, warnings badge.
- **Legend strip** under the toolbar when a color mode needs one.
- **Workspace**: optional left/right drawers flanking the three stacked views.
- **Status bar** (bottom): playhead position (seq + t), live count/bytes,
  transient info line, trace summary line.
- Overlays above everything as needed: tooltip, selection popover, search
  overlay, drop overlay, load progress.

## 9.2 Panels are windows

Every panel (Play, Layout, Filter, Marks, Warnings, Events, Allocation, and
pinned allocation windows) is a floating window: dragged by its header,
closable, and z-stacked with most-recently-touched on top. Toolbar buttons
toggle visibility; position persists per trace via the session
([07-analysis §7.7](07-analysis.md)).

## 9.3 Docking drawers

Any window can be **docked** by dragging it to a screen edge (or an already
open drawer): an insertion indicator previews the drop position; drop docks
it into a vertical stack. Behaviors that define the feel:

- A drawer exists only while it has visible docked windows — there is no
  manual drawer toggle; empty drawers vanish.
- Docked windows share the drawer's height; dividers between them resize
  neighboring pairs only, and the drawer's width is draggable at its inner
  edge.
- Dragging a docked window pops it out immediately (it re-docks only if
  actually dropped on a drawer), so a window in motion is always visibly "in
  hand".
- Closing a docked window keeps its dock slot in the DOM so reopening from
  the toolbar returns it to its place; the drawer collapses if that leaves it
  empty.
- Dock layout, drawer widths, and floating positions restore with the
  session.

## 9.4 The allocation window lifecycle

One **live** Allocation panel follows selection (click, step, search-jump).
**Pinning** (📌) detaches the current window in place — identical chrome, the
orange pin the only tell — and the next selection opens a fresh live panel,
cascade-placed to avoid landing on pinned ones. Selecting an
already-pinned allocation raises its window instead of duplicating it.
Unpinning returns the window's content to the live panel. Pinned windows dock
like any other window and are restored from the session by creator event
index.

## 9.5 Specific panels

- **Play**: step/play buttons, advance mode (time / events), speed
  ([06-playback-navigation](06-playback-navigation.md)).
- **Layout**: row bytes, collapse threshold, all-rows, size labels + format,
  address labels, row zoom, color mode, viewport lock
  ([04-address-map](04-address-map.md)).
- **Filter**: dim/hide mode, size range, per-site and per-thread checkboxes
  (with all/none links), tag visibility list with recolor/rename/delete
  ([07-analysis](07-analysis.md)).
- **Marks**: time marks, address marks, named allocations — each row
  renameable inline, with jump/center/delete actions
  ([07-analysis](07-analysis.md)).
- **Warnings**: the flagged-input list; click jumps to the event
  ([03-core-model §3.5](03-core-model.md)).
- **Events**: the virtualized event list
  ([06-playback-navigation §6.5](06-playback-navigation.md)).

## 9.6 Status & feedback conventions

Every non-obvious action acknowledges itself in the status info line
("tagged 1,204 allocations …", "marked 0x… — rename it in the Marks panel").
Transient visual feedback (address flash, rect flash + ping ring, move links)
is used wherever the answer to "where did that happen?" is a place on the
map. Controls carry `title` tooltips explaining gesture modifiers.
