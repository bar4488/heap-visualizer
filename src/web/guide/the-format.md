# 1. Open the example

[Open sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1). We will use
this small trace throughout the guide.

A `.heapl` trace is JSONL: a header followed by malloc, free, realloc, and
optional custom-event records. The viewer derives every view from that stream.

[Download the annotated format sample](guide/traces/format.heapl) when you are
ready to emit traces from your own program.
