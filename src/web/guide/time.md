# 3. Move through the trace

The two strips share one playhead but use different x axes: **time** uses trace
timestamps, while **events** gives every record equal width. One exposes pauses
and bursts; the other exposes order and count.

Jump to [sequence 12](#set:jump-input=12), then press [Go](#do:btn-jump).
Several rectangles disappear because you moved before their allocations were
created. The status bar shows both the event `seq` and its timestamp `t`.

Use `←` and `→` to step. Each step consumes one record, so an `M` adds an
allocation, an `F` removes one, and an `R` may move or resize one. Shift steps
100 records; Home and End seek to the bounds. `L` disables automatic map
scrolling while you inspect a fixed address range.

Open [Play](#show:play-panel). **advance by time** respects timestamp gaps;
**advance by events** advances a fixed record count per tick. Space toggles
playback.

Drag either strip to select a range. The selection appears on both axes, even
though its width differs. Press Escape to clear it before continuing.
