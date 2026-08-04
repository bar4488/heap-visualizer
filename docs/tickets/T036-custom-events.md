---
id: T036
title: Custom E events carry a producer's own landmarks through the viewer
status: todo
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

- [ ] `{"op":"E"}` parses into an event row with `OP_E`, no geometry, no
      liveness effect, and no contribution to the timelines' alloc/free marks;
      a native test asserts the live set at the end of a trace with `E` records
      equals the same trace without them.
- [ ] `title` on an `E` record is its label; every other unrecognized key is an
      ordinary custom field, catalogued as one.
- [ ] Nothing that walks creators picks one up: `hp_center_x_for_event`,
      `scroll_for_event`, `event_rects` and `move_link` return their empty
      answers for an `E` event, and the filtered event list drops them —
      an `E` has no allocation to pass a filter.
- [ ] The Events panel renders `E` rows and a click opens the Event window
      rather than the Allocation panel; the window's body is built by a pure,
      tested function.
- [ ] `python3 gen.py --events` emits them, and the checked-in
      `src/web/guide/traces/format.heapl` carries a few.
- [ ] The spec says all of it:
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
