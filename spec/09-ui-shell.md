# 09 — UI Shell: Toolbar, Dock, Panels

The chrome around the views. Guiding stance: the views own the screen;
everything else is a **window** the user summons, places, and dismisses. Views
and windows alike are **panels in one dock** — a split/tab grid with edge
groups and floating groups — so a new view (a flame graph, a span view) is one
more panel type, not a new layout.

## SHELL-001: Layout

- **Top bar**: one row, IDE-style, that never wraps (the trace title gives
  way first, down to a 1100 px window):
  - *left*: the app name, then the **File / View / Help** menus
    ([SHELL-011](#shell-011-actions-menus-and-the-command-palette)), then the
    trace title;
  - *center*: the playback transport — step back, play/pause, step forward,
    the Play-settings button (it names the current speed and toggles the Play
    window), the viewport lock — and the jump box;
  - *right*: the horizontal-zoom pill and the crop pill while they apply, the
    warnings badge only when the trace has warnings, and the connection pill:
    the local companion's state as a dot and a short label. Not connected, a
    click opens a small popover offering Connect… (the same flow as File →
    Connect…) and What's heapviz? (the heapviz & AI agents guide); Escape or
    a click outside closes it. Connected, it asks before disconnecting.

  The bar carries no per-panel buttons: windows are shown and hidden from the
  View menu and the command palette.
- **Legend strip** under the top bar when a color mode needs one.
- **Workspace**: the dock ([SHELL-004](#shell-004-docking)), with the guide
  surface ([SHELL-009](#shell-009-the-guide-surface)) outside it at the left
  edge.
- **Status bar** (bottom): playhead position (seq + t), live count/bytes,
  transient info line, trace summary line.
- Overlays above everything as needed: tooltip, selection popover, search
  overlay, drop overlay, load progress.

## SHELL-002: Panels: views and windows

Everything in the workspace is a panel in the dock. Two kinds:

- **Views** — the address map, the time strip and the event-index strip. They
  start in the center grid, the two strips stacked above the map. The
  **address map cannot be closed**: its tab has no close button and no amount
  of restoring or resetting can leave the workspace without it. The strips can
  be closed from their tab and brought back from the View menu.
- **Windows** — Play, Layout, Appearance, Filter, Marks, Warnings, Events,
  Logs, Allocation, pinned allocation windows, Event, Request. Every window is
  closable. The View menu toggles them (Play and Warnings: their top-bar
  button; Request: the Help menu).

A panel's tab carries its title (a window that retitles itself, like
Allocation naming its allocation, retitles its tab), its close button, and is
its drag handle. A window's own controls (follow, filtered, pin, ＋ mark, a
line count) stay in a row at its top. A **toggle** (a View-menu entry, a
palette command, a top-bar button) closes its window
when it is on screen, and brings it to the front when it is open but out of
sight — a tab behind another, or in a collapsed edge group. Where each panel
is persists per trace via the session
([ANL-007](07-analysis.md#anl-007-persistence--heapa-files-and-autosave)), and
starts from the default layout ([SHELL-008](#shell-008-the-default-layout)).

Behaviors every window has, whatever it contains:

- **Below the overlays.** The dock is one stacking context: no floating group,
  however raised, can sit above an overlay (tooltip, selection popover, menu,
  search, drop and progress overlays, setup).
- **Reachable.** A floating group stays inside the workspace: positions
  restored from a session, and every floating group after a viewport resize,
  are held within it.
- **Keyboard.** A window is a labelled region (named by its title). Opening one
  from its toggle moves focus into it, and closing it while focus is
  inside (or with focus lost to the page) returns focus to whatever opened it.
  **Escape** closes the window that has focus, unless a control inside it used
  the key first (an open completion list closes on the first Escape, the
  window on the next). Escape never closes a view. Window close buttons carry
  an accessible name ("Close Filter"); toggles expose whether their
  window is open (`aria-checked` in the View menu, `aria-pressed` on a top-bar button); the dock's own
  collapse and maximize buttons are named and expose their state. A window
  opened by the app rather than by the user — the Allocation window following
  a selection — does not take focus.

## SHELL-003: Panels are declared as data

Every panel must be declared as data — one record per panel carrying at least
its element id, its title, and how it refills itself from a freshly loaded
trace — and that declaration must be the only place a panel id is written.
Nothing may keep a second list of panels alongside it, including the code that
titles panels, the code that toggles them, the code that hides them on a new
trace, and the code that persists their place. A refill function declared
against an id that is not in the table is an error, not a step that silently
never runs.

Each record must also carry that panel's place in the default layout — the
center grid, an edge group, or floating — whether it starts open, and whether
it can be closed ([SHELL-008](#shell-008-the-default-layout)). Windows that are
opened per selection or per event (Allocation, its pinned clones, Event) are
declared in the same table, marked as not persisted: a restored session does
not decide their open state. Pinned allocation windows are **multi-instance**:
one window per creator event, addressed as type + key, and the panel id is
`type:key`.

The declaration belongs to the domain, not to the shell: the shell places and
persists whatever panels it is handed, and must not name one. A window that is
not heap-shaped (Request) is declared to the shell by its own module.

The table is assembled from per-domain tables: the heap's, and one per
evidence domain module, which declares its panels through a registration hook
(`src/web/panels.ts`) at startup. Each module is registered for the domain it
needs, with the label of its View-menu group; its panels' View entries show,
and they start open, only for a trace that has records of that domain. A new domain's panels need no wiring beyond
its module's entry in that list.

**The shell's panel API.** Domain code reaches panels only through the shell's
layout API (`shell/layout.ts`), which owns visibility, placement, focus,
top-bar toggle buttons and close buttons; it is the only code that talks to
the dock engine ([D014](../docs/decisions/D014-dockview-for-windowing.md)).
Each record names its View-menu group (Heap, Stream, Logs, a module's label);
the View menu's entries are built from the records, never listed by hand
([SHELL-011](#shell-011-actions-menus-and-the-command-palette)). The API:

- `register(type, {title, singleton, closable, defaultLocation, build, persist,
  toggle, size, floatSize, autoPlace, onOpen, onClose})` declares a type. A
  singleton's element is adopted at once; a multi-instance type's
  `build(key, data)` makes an element per key.
- `open(type, key?, options)`, `close`, `toggle`, `reveal` (open, bring its tab
  to the front, and expand a collapsed edge group holding it), `isOpen`,
  `isShown`. Options cover moving focus, a floating position, a home (an edge,
  the center, floating), another window's place (`placeOf` — pinning and
  unpinning swap a window in place), and replaying a restore. Every open and
  close goes through these — domain code never writes a panel's visibility.
- `onOpen(type, fn)` / `onClose(type, fn)`: what a window does when it opens or
  comes back into sight (its tab brought to the front, its edge expanded — the
  Events and Logs lists catch up), and when it closes. Hooks run once the
  whole layout is in place, including after a reset or a restore.
- `resetLayout()` — the default layout ([SHELL-008](#shell-008-the-default-layout)).
- `serialize()` / `restore()` — the session's `shell` section, which the
  session module carries in its envelope without reading inside it
  ([SHELL-004](#shell-004-docking)).

Panel elements are **long-lived and adopted, never created by the dock**: the
views' canvases are transferred to the render worker once at startup, and the
app finds controls by element id. A closed panel's element stays in the
document, hidden; an open one is moved into the dock. A view that is closed or
hidden measures nothing, and the render worker keeps its last size rather than
being resized to nothing.

## SHELL-004: Docking

The dock is a grid of **groups**; a group shows one or more panels as tabs.
Dragging a tab rearranges it: onto another group's tab strip or center makes it
a tab there, onto a group's edge splits that group, onto the outer edge of the
grid splits the whole grid. Holding Shift while dragging (or the tab's context
menu → Float) floats a panel in its own **floating group**, which moves by its
title bar — the empty part of its tab strip — and resizes from its edges and
corners; dragging its tab (or Shift-dragging the strip) docks it. A grid group
can be **maximized** (its header button or the tab menu) to fill the dock, and
restored. Panels never leave the page: there are no popout windows.

Around the grid are three **edge groups** — left, right, bottom:

- An edge group is one group of tabs along that side, resizable at its inner
  edge. The bottom group's tab strip sits above its content, as every grid
  group's does.
- It **collapses** to a rail of its tab titles (written vertically on the
  left and right), from a button at the end of its tab strip; collapsing never
  closes, undocks or reorders its panels, and expanding restores its size.
  Collapse persists with the session. Opening or revealing a window that lives
  there expands it.
- An edge group with no panels **is not shown**; while a tab is being dragged,
  empty edges show as rails so a panel can be dropped onto them, and one that
  fills up from empty opens expanded.

Closing a panel keeps its place: reopening it from its toggle returns it to
the edge group, the grid group or the floating position it was in (or, if
that group is gone, to its default home).

**The dock layout in the session.** The shell's half of the session is a
`shell` section with its own `version`. Version 2 is the dock engine's own
serialization of the whole layout — groups, splits and their sizes, tabs and
the active one, edge groups' sizes and collapse, floating groups' positions —
plus where closed windows reopen. A restore replaces the layout wholly. A
saved panel whose window does not exist yet (a pinned allocation window, which
comes back after a worker round-trip) holds its slot until it is recreated
there, and the slot is dropped if it never is. A saved panel for a window that
is not persisted, or that this build does not know, is not restored; windows
that are not persisted keep their open state across a restore. Restoring a
layout that lacks a view that cannot be closed adds the view back.

A session written before the dock (shell version 1: `windows` with each
window's floating position and visibility, and `drawers` with the left and
right drawers' order, widths and collapse) is read once, through one path,
into a dock layout: each drawer becomes that edge group (its order the tab
order, its width the group's size, its collapse kept), docked pinned windows
keep their slot, windows the old session knew about but did not dock float
where they were, a window docked but closed reopens in that edge, and anything
the old session did not know about — the views, the bottom edge — takes its
default. It is written back in the current shape.

## SHELL-005: The allocation window lifecycle

One **live** Allocation panel follows selection (click, step, search-jump).
While it is open it stays exactly where it is — a new selection changes its
content, never its place or size. **Pinning** (📌) detaches the current window
in place — the pinned window takes the live window's place in the dock at the
same position and size, identical chrome, the orange pin the only tell — and
the next selection opens a fresh live panel placed from scratch. Selecting an
already-pinned allocation raises its window instead of duplicating it.
Unpinning returns the window's content to the live panel, in the pinned
window's place (moving the live panel there if it is open elsewhere). Pinned
windows dock like any other window and are restored from the session by
creator event index, each into its saved slot — a floating one at its saved
position and size.

**Placing a floating window from scratch.** A live panel that floats from
scratch (its first opening, or after a pin) opens at its declared float size
**beside the selection** it shows — to the right of the clicked point, else
the left, below, above — never covering that point. It takes the nearest spot
that overlaps no other floating window. When the workspace has no such spot,
it **cascades**: it goes where it hides least of the other floating windows,
above all their title strips, then the selection, then their bodies, as near
its preferred spot as that allows. A selection with no point (a step, a
search jump) places it at the workspace's bottom-left on the same terms. Any
window floated from its tab menu is placed the same way, from its own corner.
A plain close (×, Escape) is not a fresh start: the live panel reopens where
the user left it.

The window can insert `allocation(<id>).` at the Filter editor's current
selection and open contextual completion. This writes source only—it neither
applies a predicate nor introduces browser-selection state into the language.

## SHELL-006: Specific panels

Panels are split by *what the setting does*, not by what happens to be
convenient: **Layout** decides where things land on the map, **Appearance**
how they are drawn, **Play** how the playhead moves. A setting belongs to
exactly one of those.

- **Play**: advance mode (time / events) and speed. Stepping, play/pause and
  the viewport lock sit in the top bar's transport beside it — lock is
  playback behavior (it decides whether stepping scrolls), not layout
  ([06-playback-navigation](06-playback-navigation.md)).
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
- **Warnings**: the flagged-input list, grouped by the domain that raised
  each warning (with each domain's total), each row its kind, message and
  meaningful detail; click jumps to the event
  ([MODEL-005](03-core-model.md#model-005-warnings),
  [IVL-006](14-intervals.md#ivl-006-warnings)).
- **Events**: the virtualized list of every domain's records, with follow and
  filtered-only toggles ([NAV-005](06-playback-navigation.md#nav-005-the-events-panel))
  and one chip per domain the trace has records of, which leaves that
  domain's records out of the list
  ([DOM-004](13-domains-and-logs.md#dom-004-the-domain-registry)).
- **Logs**: the trace's log lines as a terminal — virtualized, dimmed past the
  playhead, following it like `tail -f`, narrowed by minimum level and text
  search ([LOG-007](13-domains-and-logs.md#log-007-the-logs-panel)). Its
  View entry (the Logs group) appears only for a trace with log records.

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

Where a panel sits before anyone has moved it is a decision, not an accident
of CSS. With no session to restore, the workspace must open with the views and
the panels that are consulted continuously already docked and open:

- **Center**, top to bottom: the time strip, the event-index strip (each at a
  strip's height), the address map (the rest).
- **Right edge**, as tabs in this order, Layout in front: Layout, Appearance,
  Filter, Marks.
- **Left edge**: Events.
- **Bottom edge**: Logs — a wide terminal. It starts open only when the loaded
  trace has log records, and closed otherwise
  ([LOG-007](13-domains-and-logs.md#log-007-the-logs-panel)); the panel table
  records that condition beside the panel's home and open state.
- **Floating and closed**: Play, Warnings, Allocation and its pinned clones.
  Play is a window a user opens for a moment and dismisses; Warnings only
  exists when the trace has any; Allocation follows selection and floats
  beside the selection, clear of other floating windows
  ([SHELL-005](#shell-005-the-allocation-window-lifecycle)).

A restored session overrides this **wholly**, not as a patch on top of it.

A newly loaded trace with no session starts from this layout too, keeping
floating windows' positions. **Reset layout** (View menu, and the palette) applies
it on demand and completely: every view back in the center, every declared
window back in its default edge and order or floating at its default spot,
persisted windows open or closed as declared, edge groups at their default
size and expanded. Windows opened per selection (Allocation, pinned clones,
Event) keep their open state and are only moved — floated, on screen. The
result is autosaved like any other layout change.

## SHELL-009: The guide surface

The user-facing guide is **not a window**. It must not appear in the panel
declaration ([SHELL-003](#shell-003-panels-are-declared-as-data)), must not
dock, float, or tab ([SHELL-002](#shell-002-panels-views-and-windows),
[SHELL-004](#shell-004-docking)), and must not carry per-trace session
geometry. It is its own surface at the left edge of the workspace, outside the
dock, and closable.

The surface hosts **multiple guides**, peers switched by tabs at its top. Each
guide has its own content (its own section files, in its own list) and its own
scroll position, kept across switches. There are two:

- **Tasks** — the how-to. Help → Guide opens the surface on it (or closes it
  when it is already showing Tasks).
- **heapviz & AI agents** — explains, in the user's terms, what the `heapviz`
  companion is, why to use it, where to install it (pointing at Setup rather
  than repeating its host-derived commands), how to open and connect a trace,
  how to enable an AI assistant, its commands, and its loopback-only,
  capability-guarded access. It is not a section of Tasks, and Tasks does not
  link to it. It is opened by Help → heapviz & AI agents… (and the palette),
  the connection pill's "What's heapviz?" while disconnected, Setup's "What is
  heapviz?" link, and the welcome card's "Work with AI agents" line
  ([SHELL-010](#shell-010-first-run-onboarding)).

A link from one guide to a section of the other switches to that guide.

Tasks' content must be a concise task list in plain markdown authored under `src/`,
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
element's own handler is bound to. A menu item is such a control: the
guide clicks it by its element id, and points at an item of a closed menu by
highlighting that menu. It must not post to the worker, mutate shared UI state,
or un-hide a panel behind its toggle. A guide action
whose target id does not exist must report that and change nothing.

## SHELL-010: First-run onboarding

An ordinary first visit presents two user goals: try the bundled demo or open a
trace from the current computer, plus a visible "Work with AI agents → heapviz &
AI agents" line that opens that guide
([SHELL-009](#shell-009-the-guide-surface)). It describes the browser as the workspace and
`heapviz` as the local companion; implementation terms such as standalone mode,
bearer capability, and local server are not prerequisites. Setup is always
reopenable from File → Setup… and contains Windows and Linux install, launch,
AI-assistant skill, update, and diagnostic commands derived from the current hosted
origin. The companion is deployment-neutral: setup tells the user to start it,
then the current website accepts its connection string and connects to it.
Setup also offers an OS-specific command that downloads the deployment's full
browser demo and opens that local copy through the companion, so the complete
connection path is testable without a user-supplied trace.

A launch carrying a configured local connection skips the welcome surface.
Connection failures reopen setup with a specific remedy, and an incompatible
companion is distinguished from an unreachable or permission-denied one.

## SHELL-011: Actions, menus and the command palette

Every command the top bar offers is one **action** in one registry
(`src/web/shell/actions.ts`): `{id, label, group, shortcut?, run, checked?,
enabled?, visible?}`, plus the section and heading it sits under. The File,
View and Help menus and the command palette are all rendered from it, so
there is one source of truth for what exists, what it is called, whether it is
on, and which key runs it.

- **File**: Open trace… (⌘/Ctrl+O), Open demo — separator — Save analysis…
  (⌘/Ctrl+S), Load analysis… — separator — Connect to heapviz… (Disconnect
  while connected), Setup…. Opening a file or the demo is unavailable while a
  local companion drives the tab; Save/Load need a loaded trace.
- **View**: one entry per window, **grouped by domain under a heading** (Heap:
  Layout, Appearance, Filter, Marks; Stream: Events; Logs: Logs; Intervals:
  Tracks, Stacks, Intervals), built from the panel records
  ([SHELL-003](#shell-003-panels-are-declared-as-data)) — a domain module's
  panels add their entries through its registration hook. An entry is checked
  while its window is open; choosing it toggles the window as any toggle does
  ([SHELL-002](#shell-002-panels-views-and-windows)). A group whose domain the
  loaded trace lacks is not shown. Then, after a separator: Time strip,
  Event-index strip, Reset layout, Command palette… (⌘/Ctrl+K).
- **Help**: Guide, heapviz & AI agents… (opens the guide surface on that
  guide, [SHELL-009](#shell-009-the-guide-surface)),
  Keyboard shortcuts (`?`), Request a feature….

**Menus** follow the menubar pattern: `menubar`, `menu`, `menuitem` /
`menuitemcheckbox` (with `aria-checked`), a heading per group. Arrow keys move
between menus and items (skipping disabled ones, wrapping), Enter or Space
runs the item, Escape closes. Once one menu is open, hovering another trigger
opens that one instead. A click outside closes the menu. A menu used with the
mouse leaves focus where it was, so the playback keys keep working; one
entered from the keyboard returns focus to its trigger on Escape. Menu items
keep stable element ids — the ids the old toolbar buttons had — for the guide
([SHELL-009](#shell-009-the-guide-surface)).

The **command palette** (⌘/Ctrl+K, or View → Command palette…) lists every
visible, enabled action — every menu item, every window ("Show Logs" /
"Hide Logs"), and palette-only commands (Go to seq, time or address…, Search,
Play / pause, the viewport lock, Playback settings, Warnings) — fuzzy filtered
as the user types (a subsequence of the label, word starts and runs ranked
first), each with where it lives and its shortcut. Up/Down (wrapping) and
Page Up/Down move, Enter runs, Escape or a click outside closes and gives
focus back.

**Shortcuts** run their action wherever focus is, except while typing in an
input, a select or a text area; they never take a key the playback and view
keys use ([NAV-007](06-playback-navigation.md#nav-007-keyboard-summary)).
