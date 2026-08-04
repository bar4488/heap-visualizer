---
id: T036
title: Custom E events carry a producer's own landmarks through the viewer
status: done
updated: 2026-08-05
---

# T036: Custom `E` Events Carry a Producer's Own Landmarks Through the Viewer

## Outcome

A producer can put a record in the stream that is not an allocation event:
`{"op":"E","t":…,"title":"frame 12 begin","phase":"render"}`. It occupies a
seq like any other event, so the playhead can sit on it and both timelines
count it, and it touches no allocation state — nothing becomes live, nothing
dies, the address map is unchanged.

The Events panel lists it as an `E` row showing its title, and clicking it
seeks there and opens an **Event** window: seq, time, thread, title, and the
record's custom fields, the same presentation the allocation panel gives them.

This is what lets someone reading a long trace tell its phases apart —
"parsing", "frame 12", "after the flush" — without inventing a fake allocation
to carry the label.

## Done when

- [x] `{"op":"E"}` parses into an event row with `OP_E`, no geometry, no
      liveness effect, and no contribution to the timelines' alloc/free marks;
      a native test asserts the live set at the end of a trace with `E` records
      equals the same trace without them.
- [x] `title` on an `E` record is its label; every other unrecognized key is an
      ordinary custom field, catalogued as one.
- [x] Nothing that walks creators picks one up: `hp_center_x_for_event`,
      `scroll_for_event`, `event_rects` and `move_link` return their empty
      answers for an `E` event, and the filtered event list drops them —
      an `E` has no allocation to pass a filter.
- [x] The Events panel renders `E` rows and a click opens the Event window
      rather than the Allocation panel; the window's body is built by a pure,
      tested function.
- [x] `python3 gen.py --events` emits them, and the checked-in
      `src/web/guide/traces/format.heapl` carries a few.
- [x] The spec says all of it:
      [TRACE-002](../../spec/02-trace-format.md#trace-002-record-types-op) and a
      requirement for the record itself, plus
      [NAV-005](../../spec/06-playback-navigation.md#nav-005-the-events-panel)
      and [SHELL-006](../../spec/09-ui-shell.md#shell-006-specific-panels).

## Non-goals

- Marking `E` events on the two timelines or on the address map. They are
  listed and inspectable; drawing them is a separate question with its own
  layout cost.
- Pinning Event windows. The allocation window's pin/restore machinery is
  keyed to creator event indexes and persisted in the session
  ([SHELL-005](../../spec/09-ui-shell.md#shell-005-the-allocation-window-lifecycle));
  extending that is not needed to read a landmark.
- Filtering on `E` events. The filter language is over allocations
  ([ANL-003](../../spec/07-analysis.md#anl-003-filter)).

## Result

`op:"E"` parses, lists, and opens. The native suite asserts the invariant that
matters — the live set at every playhead position is identical to the same
trace without the `E` records — plus `e: null` on the wire, the four empty
answers from the creator-walking paths, and their absence from the filtered
list. `node --test` covers the Event window body, `tsc` and a full `./build.sh`
pass, and the built page serves.

What no cheap check covers, per
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md): the Event
window's appearance and placement, and the `E` row in the virtualized list.
Both are one click away — open
`index.html?trace=guide/traces/format.heapl&guide=1`, which now carries four of
them, and click a purple row in the Events panel.
