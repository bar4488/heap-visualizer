# 09 — UI Shell: Toolbar, Windows, Docking

The chrome around the three views. Guiding stance: the views own the screen;
everything else is a **window** the user summons, places, and dismisses.

## SHELL-001: Layout

- **Toolbar** (top): open/demo, trace title, panel toggles (Play, Layout,
  Appearance, Filter, Events, Marks), horizontal-zoom pill, crop pill, marks
  Save/Load, jump box, warnings badge.
- **Legend strip** under the toolbar when a color mode needs one.
- **Workspace**: optional left/right drawers flanking the three stacked views.
- **Status bar** (bottom): playhead position (seq + t), live count/bytes,
  transient info line, trace summary line.
- Overlays above everything as needed: tooltip, selection popover, search
  overlay, drop overlay, load progress.

## SHELL-002: Panels are windows

Every panel (Play, Layout, Appearance, Filter, Marks, Warnings, Events,
Allocation, and pinned allocation windows) is a window: it is either floating —
dragged by its header, z-stacked with most-recently-touched on top — or docked
in a drawer ([SHELL-004](#shell-004-docking-drawers)). Every window is closable.
Toolbar buttons toggle visibility; which home a window has, and where it sits in
it, persists per trace via the session
([ANL-007](07-analysis.md#anl-007-persistence--heapa-files-and-autosave)), and
starts from the default layout ([SHELL-008](#shell-008-the-default-layout)).

## SHELL-003: Panels are declared as data

The set of session-restored panels must be declared as data — one record per
panel carrying at least its element id, its title, and how it refills itself
from a freshly loaded trace — and that declaration must be the only place a
panel id is written. Nothing may keep a second list of panels alongside it,
including the code that titles panels, the code that toggles them, and the
code that persists their geometry. A build function declared against an id
that is not in the table is an error, not a step that silently never runs.

Each record must also carry that panel's place in the default layout — which
drawer it docks in, or that it floats, and whether it starts open
([SHELL-008](#shell-008-the-default-layout)).

The declaration belongs to the domain, not to the shell: the shell places and
persists whatever windows it is handed, and must not name a panel.

## SHELL-004: Docking drawers

Any window can be **docked** by dragging it to a screen edge (or an already
open drawer): an insertion indicator previews the drop position; drop docks
it into a vertical stack. Behaviors that define the feel:

- A drawer exists only while it has visible docked windows; empty drawers
  vanish.
- A drawer that has content carries a bar at its top with a **collapse**
  control. Collapsing must reduce the drawer to a narrow rail carrying only
  that control, and must not close, undock, or reorder the windows in it;
  expanding must restore them at the drawer's previous width. Collapsed state
  persists with the session, and dropping a window on a collapsed drawer
  expands it.
- Docked windows share the drawer's height; dividers between them resize
  neighboring pairs only, and the drawer's width is draggable at its inner
  edge.
- Dragging a docked window pops it out immediately (it re-docks only if
  actually dropped on a drawer), so a window in motion is always visibly "in
  hand".
- Closing a docked window keeps its dock slot in the DOM so reopening from
  the toolbar returns it to its place; the drawer vanishes if that leaves it
  empty.
- Dock layout, drawer widths, and floating positions restore with the
  session.

## SHELL-005: The allocation window lifecycle

One **live** Allocation panel follows selection (click, step, search-jump).
**Pinning** (📌) detaches the current window in place — identical chrome, the
orange pin the only tell — and the next selection opens a fresh live panel,
cascade-placed to avoid landing on pinned ones. Selecting an
already-pinned allocation raises its window instead of duplicating it.
Unpinning returns the window's content to the live panel. Pinned windows dock
like any other window and are restored from the session by creator event
index.

## SHELL-006: Specific panels

Panels are split by *what the setting does*, not by what happens to be
convenient: **Layout** decides where things land on the map, **Appearance**
how they are drawn, **Play** how the playhead moves. A setting belongs to
exactly one of those.

- **Play**: step/play buttons, advance mode (time / events), speed, viewport
  lock — lock is playback behavior (it decides whether stepping scrolls), not
  layout ([06-playback-navigation](06-playback-navigation.md)).
- **Layout**: row bytes, collapse threshold, all-rows, row zoom, overlap
  display mode, freed-nested ghosts ([04-address-map](04-address-map.md)).
- **Appearance**: color mode, size labels, address labels, size format
  ([04-address-map](04-address-map.md)).
- **Filter**: dim/hide mode, size range, address ranges, per-site and
  per-thread checkboxes (with all/none links), tag visibility list with
  recolor/rename/delete ([07-analysis](07-analysis.md)).
- **Marks**: time marks, address marks, named allocations — each row
  renameable inline, with jump/center/delete actions
  ([07-analysis](07-analysis.md)).
- **Warnings**: the flagged-input list; click jumps to the event
  ([MODEL-005](03-core-model.md#model-005-warnings)).
- **Events**: the virtualized event list, with follow and filtered-only
  toggles ([NAV-005](06-playback-navigation.md#nav-005-the-events-panel)).

## SHELL-007: Status and feedback conventions

Every non-obvious action acknowledges itself in the status info line
("tagged 1,204 allocations …", "marked 0x… — rename it in the Marks panel").
Transient visual feedback (address flash, rect flash + ping ring, move links)
is used wherever the answer to "where did that happen?" is a place on the
map. Controls carry `title` tooltips explaining gesture modifiers.

## SHELL-008: The default layout

Where a window sits before anyone has moved it is a decision, not an accident
of CSS. With no session to restore, the workspace must open with the panels
that are consulted continuously already docked and open:

- **Right drawer**, top to bottom: Layout, Appearance, Filter, Marks.
- **Left drawer**: Events.
- **Floating and closed**: Play, Warnings, Allocation and its pinned clones.
  Play is a window a user opens for a moment and dismisses; Warnings only
  exists when the trace has any; Allocation follows selection and is placed
  relative to it ([SHELL-005](#shell-005-the-allocation-window-lifecycle)).

A restored session overrides this **wholly**, not as a patch on top of it: a
window the default docks and the session does not must end up floating.
