# 1. Load a trace

We will use one small trace for the whole walkthrough. It has 16 allocations,
three call sites, two threads, several frees, and five allocations left live.

[Open sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1).

You should now see a sparse address map and both timelines populated. The
playhead starts at the end, so the map contains the allocations still live after
the final event.

The input is `.heapl`: JSONL with a header followed by `M`, `F`, `R`, and
optional custom-event `E` records. `#` starts a comment. Producer-defined fields
are preserved and queryable, so an emitter can add domain data without extending
the viewer.

[Download the annotated format sample](guide/traces/format.heapl) when you want
to instrument your own allocator. For now, keep `sites.heapl` open and continue.
