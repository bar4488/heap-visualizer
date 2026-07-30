# Time

Two strips, two x axes, one playhead.

- [time](#show:strip-t) — wall-clock time from the trace. Bursts bunch up, idle
  gaps are wide.
- [events](#show:strip-s) — event index. Equal width per event, so order and
  count are readable and duration is not.

[bursts.heapl](index.html?trace=guide/traces/bursts.heapl&guide=1) is 26 events in two
clusters 0.4 s apart. The gap is most of the time strip and zero width on the
events strip.

## The playhead

Position is `seq` — an index into the event stream — plus `t`, the timestamp of
that event. Both show in the status bar. Stepping moves one event, so it moves
in time by whatever the gap happens to be.

The jump box reads three forms:

- `41200` — a `seq`. Scientific notation works: `4.12e4`.
- `t:1e6` — a time in the trace's unit.
- `0x7f001000` — an address. Scrolls the map to the nearest live row and selects
  what is there; the playhead stays where it is.

Try [seq 12](#set:jump-input=12) then [Go](#do:btn-jump). `g` opens the search
overlay, which also finds marks, names, and warnings.

Stepping onto a realloc draws a link between the old and new regions: dashed red
for the address it left, green for where it landed.
[realloc.heapl](index.html?trace=guide/traces/realloc.heapl&guide=1) is one buffer grown
five times, including one in-place grow that draws no link because the address
did not change.

## Playback

Controls are in [Play](#show:play-panel).

- **advance by time** replays at wall-clock rate. Idle gaps take real seconds.
- **advance by events** advances a fixed count per tick, which compresses idle
  stretches.
- `←` `→` step one event, shift makes it 100. `space` plays. `Home` and `End` go
  to the ends.
- `L` locks the viewport: stepping stops auto-scrolling the map.

## Events panel

The textual twin of the events strip: seq, op, addr, size, site. Rows come from
the engine per visible window, so the list scrolls at any trace size.

- Click jumps and selects. Clicking the current event flashes exactly where it
  is on the map — a rect flash plus a ping ring.
- **follow**, on by default, keeps the current event in view while stepping.
- **filtered** lists only events whose allocation passes the filter. An `F`
  follows the allocation it frees, so a matching allocation's birth and death
  both stay in the list.
- Arrow keys step the selection. Dragging vertically makes a seq range
  selection.
