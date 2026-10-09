# 09 — UI Shell: Toolbar, Windows, Docking

The chrome around the three views. Guiding stance: the views own the screen;
everything else is a **window** the user summons, places, and dismisses.

## SHELL-001: Layout

- **Toolbar** (top): open/demo, trace title, panel toggles (Play, Layout,
  Appearance, Filter, Events, Logs, Marks), horizontal-zoom pill, crop pill, marks
  Save/Load, jump box, warnings badge, and an overflow menu (⋯) carrying
  workspace actions — **Reset layout**
  ([SHELL-008](#shell-008-the-default-layout)).
- **Legend strip** under the toolbar when a color mode needs one.
- **Workspace**: optional left/right drawers flanking the three stacked views,
  with the guide surface ([SHELL-009](#shell-009-the-guide-surface)) outside
  them at the left edge.
- **Status bar** (bottom): playhead position (seq + t), live count/bytes,
  transient info line, trace summary line.
- Overlays above everything as needed: tooltip, selection popover, search
  overlay, drop overlay, load progress.

## SHELL-002: Panels are windows

Every panel (Play, Layout, Appearance, Filter, Marks, Warnings, Events, Logs,
Allocation, pinned allocation windows, Event, Request) is a window: it is
either floating — dragged by its header, z-stacked with most-recently-touched
on top — or docked in a drawer ([SHELL-004](#shell-004-docking-drawers)).
Every window is closable. Toolbar buttons toggle visibility; which home a
window has, and where it sits in it, persists per trace via the session
([ANL-007](07-analysis.md#anl-007-persistence--heapa-files-and-autosave)), and
starts from the default layout ([SHELL-008](#shell-008-the-default-layout)).

Behaviors every window has, whatever it contains:

- **One z band.** Floating windows stack among themselves only, in a band
  below every overlay (tooltip, selection popover, search, drop and progress
  overlays, setup). No amount of raising may carry a window above an overlay;
  the stack is renormalized rather than counted upward.
- **Reachable.** A floating window's header must stay on screen: a position
  restored from a session, and every floating window after a viewport resize,
  is pulled back so at least a strip of its header is inside the viewport.
- **Keyboard.** A window is a labelled region (named by its title). Opening one
  from its toolbar toggle moves focus into it, and closing it while focus is
  inside returns focus to whatever opened it. **Escape** closes the window that
  has focus, unless a control inside it used the key first (an open completion
  list closes on the first Escape, the window on the next). Close buttons carry
  an accessible name ("Close Filter"); toolbar toggles expose whether their
  window is open (`aria-pressed`). A window opened by the app rather than by
  the user — the Allocation window following a selection — does not take
  focus.

## SHELL-003: Panels are declared as data

Every window must be declared as data — one record per panel carrying at least
its element id, its title, and how it refills itself from a freshly loaded
trace — and that declaration must be the only place a panel id is written.
Nothing may keep a second list of panels alongside it, including the code that
titles panels, the code that toggles them, the code that hides them on a new
trace, and the code that persists their geometry. A refill function declared
against an id that is not in the table is an error, not a step that silently
never runs.

Each record must also carry that panel's place in the default layout — which
drawer it docks in, or that it floats, and whether it starts open
([SHELL-008](#shell-008-the-default-layout)). Windows that are opened per
selection or per event (Allocation, its pinned clones, Event) are declared in
the same table, marked as not persisted: the session does not store their open
state or geometry as windows. Pinned allocation windows are **multi-instance**:
one window per creator event, addressed as type + key.

The declaration belongs to the domain, not to the shell: the shell places and
persists whatever windows it is handed, and must not name a panel. A window
that is not heap-shaped (Request) is declared to the shell by its own module.

**The shell's panel API.** Domain code reaches windows only through the shell's
layout API (`shell/layout.ts`), which owns visibility, drawer bookkeeping,
placement, focus, toolbar toggles and close buttons:

- `register(type, {title, singleton, defaultLocation, build, persist, toggle,
  autoPlace, onOpen, onClose})` declares a type. A singleton's element is
  adopted at once; a multi-instance type's `build(key, data)` makes a window
  per key.
- `open(type, key?, options)`, `close`, `toggle`, `reveal` (open, raise, and
  expand a collapsed drawer holding it), `isOpen`. Options cover moving focus,
  a floating position, docking, and replaying a restore. Every open and close
  goes through these, and they keep the drawer, the toolbar toggle and the
  hooks consistent — domain code never writes a window's visibility or dock
  side itself.
- `onOpen(type, fn)` / `onClose(type, fn)`: what a window does when it becomes
  visible (the Events and Logs lists catch up) or hidden. Hooks run on every
  open/close transition, including those a reset or a restore makes, once the
  whole layout is in place.
- `resetLayout()` — the default layout ([SHELL-008](#shell-008-the-default-layout)).
- `serialize()` / `restore()` — the session's `windows` and `drawers`, which
  the session module carries in its envelope without reading inside them.
  Restoring clamps what it restores (positions, drawer widths) to the current
  viewport.

The API, not the drawer and drag machinery behind it, is the contract: a
different layout engine (a split/tab tree) replaces what is behind it without
domain code changing.

## SHELL-004: Docking drawers

Any window can be **docked** by dragging it to a screen edge (or an already
open drawer): an insertion indicator previews the drop position in an open
drawer, and an outline over the workspace previews where an empty or
collapsed drawer will appear — a preview never shows, hides or resizes a
drawer, so nothing reflows mid-drag. Drop docks the window into a vertical
stack; **Escape** during a drag puts the window back exactly where it was
picked up, docked or floating. Behaviors that define the feel:

- A drawer exists only while it has visible docked windows; empty drawers
  vanish.
- A drawer that has content carries a bar at its top with a **collapse**
  control. Collapsing must reduce the drawer to a narrow rail carrying that
  control and the titles of its open windows, written vertically (clicking a
  title expands the drawer). It must not close, undock, or reorder the windows
  in it; expanding must restore them at the drawer's previous width. Collapsed
  state persists with the session, and dropping a window on a collapsed drawer
  expands it.
- Docked windows share the drawer's height **in proportion**: each has a share,
  even by default. Dividers between them move share between the neighboring
  pair only. Opening, closing or adding a window redistributes height by those
  shares rather than resetting them, and the shares persist with the session.
  Dividers are focusable separators, adjustable with ↑/↓.
- The drawer's width is draggable at its inner edge (also a focusable
  separator, ←/→), within 160–600 px, and never so wide that the views get
  narrower than a minimum (320 px). The width asked for is kept: when the
  viewport narrows the drawer is shown narrower, and it returns to the asked
  width when there is room again. A restored width is clamped the same way.
- Dragging a docked window pops it out immediately (it re-docks only if
  actually dropped on a drawer), so a window in motion is always visibly "in
  hand".
- Closing a docked window keeps its dock slot so reopening from the toolbar
  returns it to its place; the drawer vanishes if that leaves it empty.
- Dock layout and order (pinned allocation windows included), drawer widths,
  heights, collapse and floating positions restore with the session.

## SHELL-005: The allocation window lifecycle

One **live** Allocation panel follows selection (click, step, search-jump).
**Pinning** (📌) detaches the current window in place — identical chrome, the
orange pin the only tell — and the next selection opens a fresh live panel,
cascade-placed to avoid landing on pinned ones. Selecting an
already-pinned allocation raises its window instead of duplicating it.
Unpinning returns the window's content to the live panel. Pinned windows dock
like any other window and are restored from the session by creator event
index.

The window can insert `allocation(<id>).` at the Filter editor's current
selection and open contextual completion. This writes source only—it neither
applies a predicate nor introduces browser-selection state into the language.

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
- **Filter**: one allocation-expression editor with Apply, Clear, status /
  diagnostics, and dim/hide presentation mode
  ([ANL-003](07-analysis.md#anl-003-filter)).
- **Analysis**: tag management, time marks, address marks, named allocations —
  each row renameable inline, with the applicable recolor/jump/center/delete
  actions
  ([07-analysis](07-analysis.md)).
- **Warnings**: the flagged-input list; click jumps to the event
  ([MODEL-005](03-core-model.md#model-005-warnings)).
- **Events**: the virtualized event list, with follow and filtered-only
  toggles ([NAV-005](06-playback-navigation.md#nav-005-the-events-panel)).
- **Logs**: the trace's log lines as a terminal — virtualized, dimmed past the
  playhead, following it like `tail -f`, narrowed by minimum level and text
  search ([LOG-007](13-domains-and-logs.md#log-007-the-logs-panel)). Its
  toolbar button appears only for a trace with log records.

The **Event** window is per-event, as the allocation window is: it opens when
a custom event is stepped onto or clicked, and carries no pin — there is
nothing per-allocation about it to restore. The panel table declares it as a
window that is not persisted
([SHELL-003](#shell-003-panels-are-declared-as-data)).

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
- **Left drawer**, top to bottom: Events, Logs. Logs starts open only when
  the loaded trace has log records, and closed otherwise
  ([LOG-007](13-domains-and-logs.md#log-007-the-logs-panel)); the panel
  table records that condition beside the panel's dock and open state.
- **Floating and closed**: Play, Warnings, Allocation and its pinned clones.
  Play is a window a user opens for a moment and dismisses; Warnings only
  exists when the trace has any; Allocation follows selection and is placed
  relative to it ([SHELL-005](#shell-005-the-allocation-window-lifecycle)).

A restored session overrides this **wholly**, not as a patch on top of it: a
window the default docks and the session does not must end up floating.

A newly loaded trace with no session starts from this layout too, keeping
floating windows where the user left them. **Reset layout** (toolbar overflow
menu) applies it on demand and completely: every declared window back in its
default drawer and order, or floating at its default spot, persisted windows
open or closed as declared, drawers at their default width, docked heights
even, nothing collapsed. Windows opened per selection (Allocation, pinned
clones, Event) keep their open state and are only moved — undocked and back
on screen. The result is autosaved like any other layout change.

## SHELL-009: The guide surface

The user-facing guide is **not a window**. It must not appear in the panel
declaration ([SHELL-003](#shell-003-panels-are-declared-as-data)), must not
dock, float, or z-stack ([SHELL-002](#shell-002-panels-are-windows),
[SHELL-004](#shell-004-docking-drawers)), and must not carry per-trace session
geometry. It is its own surface at the left edge of the workspace, outside the
docking drawers, toggled from the toolbar and closable.

Its content must be a concise task list in plain markdown authored under `src/`,
such that each section read as raw text is complete. It prioritizes actions and
expected results over tutorial prose. The only non-prose element is a link
naming a real element id: one form highlights that element in the running app,
the others act on it.

Content may ship **scenario traces** — small `.heapl` files, each demonstrating
a specific case the bundled demo does not. A scenario is offered as an ordinary
link to `?trace=…` autoload ([TOOL-002](10-tooling.md)), so the guide has no
loading path of its own.

A trace file may also be linked **directly**, to be taken away rather than
opened: the format is documented by a readable example, and the guide must
offer one. A direct link to a `.heapl` must download it, not navigate the tab
onto it.

**The guide must reach application state only by driving the real controls** —
clicking the element, or setting its value and dispatching the event that
element's own handler is bound to. It must not post to the worker, mutate
shared UI state, or un-hide a panel behind its toolbar toggle. A guide action
whose target id does not exist must report that and change nothing.

## SHELL-010: First-run onboarding

An ordinary first visit presents two user goals: try the bundled demo or open a
trace from the current computer. It describes the browser as the workspace and
`heapviz` as the local companion; implementation terms such as standalone mode,
bearer capability, and local server are not prerequisites. Setup is always
reopenable from the toolbar and contains Windows and Linux install, launch,
AI-assistant skill, update, and diagnostic commands derived from the current hosted
origin. The companion is deployment-neutral: setup tells the user to start it,
then the current website accepts its connection string and connects to it.
Setup also offers an OS-specific command that downloads the deployment's full
browser demo and opens that local copy through the companion, so the complete
connection path is testable without a user-supplied trace.

A launch carrying a configured local connection skips the welcome surface.
Connection failures reopen setup with a specific remedy, and an incompatible
companion is distinguished from an unreachable or permission-denied one.
