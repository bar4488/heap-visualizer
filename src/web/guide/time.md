# Time

Two strips share one playhead and use different x axes.

- [time](#show:strip-t) — wall-clock time from the trace. Bursts bunch up, idle
  gaps are wide.
- [events](#show:strip-s) — event index. Equal width per event, so you can read
  order and count but not duration.

[bursts.heapl](index.html?trace=guide/traces/bursts.heapl&guide=1) has 26 events
in two clusters 0.4 s apart. The gap fills most of the time strip and has zero
width on the events strip.

## The playhead

Its position is `seq`, an index into the event stream, plus `t`, the timestamp
of that event. Both show in the status bar. Stepping moves one event, so how
far it moves in time depends on the gap.

The jump box reads three forms:

- `41200` — a `seq`. Scientific notation works: `4.12e4`.
- `t:1e6` — a time in the trace's unit.
- `0x7f001000` — an address. Scrolls the map to the nearest live row and selects
  what is there, leaving the playhead where it is.

Try [seq 12](#set:jump-input=12) then [Go](#do:btn-jump). `g` opens the search
overlay, which also finds marks, names, and warnings.

Stepping onto a realloc draws a link between the old and new regions: dashed red
for the address it left, green for where it landed.
[realloc.heapl](index.html?trace=guide/traces/realloc.heapl&guide=1) grows one
buffer five times. One of those grows in place and draws no link, because the
address did not change.

## Playback

Controls are in [Play](#show:play-panel).

- **advance by time** replays at wall-clock rate. Idle gaps take real seconds.
- **advance by events** advances a fixed count per tick, which compresses idle
  stretches.
- `←` `→` step one event, shift makes it 100. `space` plays. `Home` and `End` go
  to the ends.
- `L` locks the viewport, so stepping stops auto-scrolling the map.

## Events panel

The events strip in text: seq, op, addr, size, site. Rows come from the engine
per visible window, so the list scrolls at any trace size.

- Click jumps and selects. Clicking the current event flashes exactly where it
  is on the map — a rect flash plus a ping ring.
- **follow**, on by default, keeps the current event in view while stepping.
- **filtered** lists only events whose allocation passes the filter. An `F`
  follows the allocation it frees, so a matching allocation's birth and death
  both stay in the list.
- Arrow keys step the selection. Dragging vertically makes a seq range
  selection.
