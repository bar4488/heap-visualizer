# 06 — Playback & Navigation

How the user moves through time and space, and what the app promises about
each kind of movement.

## NAV-001: The playhead

One playhead, shared by all views, canonically a `seq` ("n events applied").
On load it starts **at the end of the trace** — the first picture a user sees
is "what was live at exit", the most common leak-hunting question.

Two distinct movement flavors, used consistently everywhere:

- **Seek** (timeline drag, bookmark click): time changes, the address view
  stays where it is — scroll-anchored ([MAP-003](04-address-map.md#map-003-layout-stability)).
- **Jump** (event list click, warning click, `⌖` buttons, jump box): time
  changes *and* the address view centers on the allocation the target event
  touches, panning it into view under horizontal zoom.

## NAV-002: Playback

Play/pause (space, ▶ button) advances the playhead in real time from the
playback clock in the worker's frame loop. Two modes:

- **By time**: the trace's time span replayed over a chosen wall duration
  (trace in 5 s / 15 s / 1 m / 3 m) — faithful pacing, bursts look like bursts.
- **By events**: fixed events/second (100 → 100 k) — uniform pacing that
  never stalls on idle gaps.

Playing from the end restarts at the beginning. Playback stops at the end of
the trace, on any explicit seek/jump, or on step.

## NAV-003: Stepping

⏭/⏮ (arrow keys; shift = ×100) move one event at a time. Stepping is the
close-inspection mode, so it does more than move the playhead:

- selects the allocation the event touches (an `F` selects what it frees),
- opens/updates the allocation panel for it,
- centers it in the address view (unless the viewport is locked) and shows the
  event's link geometry — green outline for a fresh `M`, red flash for `F`,
  old→new link for `R`,
- prints a one-line event readout in the status bar.

**Viewport lock** (🔓/🔒 in the top bar's transport, key L): when locked, stepping
never auto-scrolls; the view stays anchored on the address under inspection.

## NAV-004: Jump box and search overlay

The top bar's jump box accepts three grammars, disambiguated by shape: a
number = seq, `t:…` = time, `0x…` (or `a:0x…`) = address. Address jumps move
only the address view (nearest laid-out row, centered, flashed) and
auto-select the live allocation covering that address, if any.

`g` opens the **search overlay**: one input matching the same jump grammar
plus fuzzy search over everything the user has named — bookmarks, address
marks, named allocations, and warnings — with keyboard selection. Enter
executes the item's own action (seek, go-to-address, select+jump, …).

## NAV-005: The Events panel

A virtualized list of every event — the textual twin of the sequential strip.
A row says what the record is before where it happened, so the useful part
survives a narrow panel: the domain's bar, the kind chip, then the **primary**
text, then the **secondary** text, dim, and last the seq when shown.

- **Primary:** heap — size and site (`12.4 KiB json_node`; a free shows the
  freed allocation's size and site); a call or return — the function's name;
  a span — its name; a switch — `cpu 3 → worker-1`; a log — its message; a
  mark — its title.
- **Secondary:** the thread by its short name (`worker-2`, or `t3` without
  one), prefixed by its pid (`4242/worker-2`) only when the trace's threads
  span more than one process; for heap rows, the address shortened to its
  last six hex digits (`…ea41a0`).
- **Space:** the secondary text gives up its width before the primary does;
  each secondary field shows whole or not at all, and the primary text
  ellipsizes from its end only once the secondary is gone.
- **Tooltip:** hovering a row gives what it shortens or leaves out — the full
  seq, `t`, the full address, and the thread with its pid — and what a click
  does.
- **Columns:** a `cols ▾` menu in the panel header shows or hides the thread,
  the address and the seq (small, dim, right-aligned, no thousands
  separators). The thread and address are shown and the seq hidden by
  default; the choice is a viewer preference kept in local storage across
  traces and reloads.

The same short thread naming — no pid in a single-process trace — is used in
the kind tooltip and the status line.

The **kind** column names each record in a word, never a wire letter: heap
`alloc` / `free` / `realloc` (green / red / amber), `mark`, a log's level as a
badge (`INFO`, `WARN`, … as in the Logs panel), and intervals `call ▸` /
`ret ◂` for a function call's begin and end, `span ▸` / `span ◂` for a span,
and `switch` for a context switch, whose details read `cpu 3 → worker-1`.
Labels come from the domain descriptors' `kinds`
([DOM-004](13-domains-and-logs.md)); the web falls back to the same words for
a core without them, and to the kind name itself for a kind it does not know.
The column is fixed-width (about eight characters) so rows scan as a table;
each kind sits in a chip tinted by its domain, and a thin bar on the row's
left repeats the domain's color, as the domain's toggle chip at the top of the
panel does. Hovering the kind says the record in words — "Allocation of 64 B
at 0x… (site json_node)", "Function call begins on thread worker-2:
parse_body" (`(pid 4242)` after the thread only in a multi-process trace). The status line on stepping onto a record, and the Event
window's title (`Mark · <label>`), use the same words.

A custom event ([TRACE-010](02-trace-format.md#trace-010-custom-event-record-e))
has no geometry to list, so its row's primary text is its label, and the row
is visibly not an allocation row. Clicking it seeks there
and opens the **Event** window — label, seq, time, thread, and the record's
custom fields, presented as the allocation panel presents them
([ANL-006](07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows)),
minus the per-field filter action, which would speak about allocations rather
than about this record. The current selection is left alone: a landmark
replaces no allocation.

- Rows are fetched on demand from the engine per visible window; the scroll
  height is capped (~12 M px) and index-mapped beyond that, so billion-row
  traces still scroll. (Browsers clamp element heights; the cap is a
  workaround, and position-in-list is approximate past it by design.)
- Click = jump+select; clicking the *current* event instead flashes exactly
  where it is on the map (rect flash + expanding ping ring — the answer to
  "where is this 16-byte allocation?"). A custom event is nowhere on the map,
  so re-clicking one reopens its window instead of flashing.
- **Follow** (default on) keeps the current event scrolled into view during
  stepping/playback.
- **Filtered** (default off) lists only events whose allocation passes the
  active Filter — a `free` follows the allocation it frees, so an allocation's
  birth and death both stay in the list; a custom event has no allocation and
  drops out. Rows keep their real seq; the
  engine owns the filtered index (count, slice, seq→row position), rebuilt
  lazily after any filter or tag change.
- Arrow keys step the selection (along the filtered rows when the toggle is
  on); dragging vertically makes a seq range selection feeding the same
  popover as timeline shift-drag ([07-analysis](07-analysis.md)).

## NAV-006: Scroll ownership

The worker owns the authoritative scroll position (it renders from it); the
DOM scrollbar is the input device. Programmatic scrolls (anchoring, jump
centering) echo back as DOM scroll events, which are detected and swallowed
— only real user scrolls are forwarded. This one-owner rule is what keeps
anchored seeks from fighting the user mid-drag.

## NAV-007: Keyboard summary

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → (shift = ×100) | Step |
| Home / End | Seek to start / end |
| m | Bookmark the current position |
| L | Toggle viewport lock |
| g | Search overlay |
| Escape | Clear selection / close overlay |
| ⌘/Ctrl+K | Command palette ([SHELL-011](09-ui-shell.md#shell-011-actions-menus-and-the-command-palette)) |
| ⌘/Ctrl+O | Open a trace |
| ⌘/Ctrl+S | Save the analysis |
| ? | The shortcut list (Help → Keyboard shortcuts) |

None of these fire while typing in an input.
