# Time and navigation

Two strips share one playhead:

- [time](#show:strip-t) maps wall-clock timestamps, exposing bursts and idle
  gaps;
- [events](#show:strip-s) maps event sequence uniformly, exposing order and
  count.

[bursts.heapl](index.html?trace=guide/traces/bursts.heapl&guide=1) makes the
difference explicit. The playhead is an event `seq` plus that event's `t`.
Stepping changes `seq` by one; elapsed time depends on the trace.

The jump box accepts a sequence (`41200`, including scientific notation), a
timestamp (`t:1e6`), or an address (`0x7f001000`). An address jump selects the
nearest live allocation without moving the playhead. Try
[seq 12](#set:jump-input=12), then [Go](#do:btn-jump). `g` opens search across
marks, names, and warnings.

[Play](#show:play-panel) can advance by timestamp or by fixed event count.
`←`/`→` step one event, Shift steps 100, Space toggles playback, and Home/End
seek to the bounds. `L` disables map auto-scroll.

The Events panel is the sequence as a virtualized table. Click a row to seek and
select; arrow keys step; vertical drag selects a range. **filtered** retains the
birth and death records of matching allocations. Custom `E` records remain in
the unfiltered event stream.

On realloc, the map links the old and new regions unless the address is
unchanged. [realloc.heapl](index.html?trace=guide/traces/realloc.heapl&guide=1)
contains both cases.
