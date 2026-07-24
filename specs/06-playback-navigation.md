# 06 — Playback & Navigation

How the user moves through time and space, and what the app promises about
each kind of movement.

## 6.1 The playhead

One playhead, shared by all views, canonically a `seq` ("n events applied").
On load it starts **at the end of the trace** — the first picture a user sees
is "what was live at exit", the most common leak-hunting question.

Two distinct movement flavors, used consistently everywhere:

- **Seek** (timeline drag, bookmark click): time changes, the address view
  stays where it is — scroll-anchored ([04-address-map §4.3](04-address-map.md)).
- **Jump** (event list click, warning click, `⌖` buttons, jump box): time
  changes *and* the address view centers on the allocation the target event
  touches, panning it into view under horizontal zoom.

## 6.2 Playback

Play/pause (space, ▶ button) advances the playhead in real time from the
playback clock in the worker's frame loop. Two modes:

- **By time**: the trace's time span replayed over a chosen wall duration
  (trace in 5 s / 15 s / 1 m / 3 m) — faithful pacing, bursts look like bursts.
- **By events**: fixed events/second (100 → 100 k) — uniform pacing that
  never stalls on idle gaps.

Playing from the end restarts at the beginning. Playback stops at the end of
the trace, on any explicit seek/jump, or on step.

## 6.3 Stepping

⏭/⏮ (arrow keys; shift = ×100) move one event at a time. Stepping is the
close-inspection mode, so it does more than move the playhead:

- selects the allocation the event touches (an `F` selects what it frees),
- opens/updates the allocation panel for it,
- centers it in the address view (unless the viewport is locked) and shows the
  event's link geometry — green outline for a fresh `M`, red flash for `F`,
  old→new link for `R`,
- prints a one-line event readout in the status bar.

**Viewport lock** (🔓/🔒, key L): when locked, stepping never auto-scrolls;
the view stays anchored on the address under inspection.

## 6.4 Jump box and search overlay

The toolbar jump box accepts three grammars, disambiguated by shape: a
number = seq, `t:…` = time, `0x…` (or `a:0x…`) = address. Address jumps move
only the address view (nearest laid-out row, centered, flashed) and
auto-select the live allocation covering that address, if any.

`g` opens the **search overlay**: one input matching the same jump grammar
plus fuzzy search over everything the user has named — bookmarks, address
marks, named allocations, and warnings — with keyboard selection. Enter
executes the item's own action (seek, go-to-address, select+jump, …).

## 6.5 The Events panel

A virtualized list of every event (seq, op, addr, size, site) — the textual
twin of the sequential strip.

- Rows are fetched on demand from the engine per visible window; the scroll
  height is capped (~12 M px) and index-mapped beyond that, so billion-row
  traces still scroll. (Browsers clamp element heights; the cap is a
  workaround, and position-in-list is approximate past it by design.)
- Click = jump+select; clicking the *current* event instead flashes exactly
  where it is on the map (rect flash + expanding ping ring — the answer to
  "where is this 16-byte allocation?").
- **Follow** (default on) keeps the current event scrolled into view during
  stepping/playback.
- **Filtered** (default off) lists only events whose allocation passes the
  active Filter — an `F` follows the allocation it frees, so an allocation's
  birth and death both stay in the list. Rows keep their real seq; the
  engine owns the filtered index (count, slice, seq→row position), rebuilt
  lazily after any filter or tag change.
- Arrow keys step the selection (along the filtered rows when the toggle is
  on); dragging vertically makes a seq range selection feeding the same
  popover as timeline shift-drag ([07-analysis](07-analysis.md)).

## 6.6 Scroll ownership

The worker owns the authoritative scroll position (it renders from it); the
DOM scrollbar is the input device. Programmatic scrolls (anchoring, jump
centering) echo back as DOM scroll events, which are detected and swallowed
— only real user scrolls are forwarded. This one-owner rule is what keeps
anchored seeks from fighting the user mid-drag.

## 6.7 Keyboard summary

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → (shift = ×100) | Step |
| Home / End | Seek to start / end |
| m | Bookmark the current position |
| L | Toggle viewport lock |
| g | Search overlay |
| Escape | Clear selection / close overlay |
