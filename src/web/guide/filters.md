# 5. Ask a question

Open [Filter](#show:filter-panel), set
[alloc.size >= 4096](#set:filter-source=alloc.size >= 4096), and press
[Apply](#do:filter-apply). Six allocations match. Switch between **dim others**
and **hide others** to choose whether non-matches remain as context.

Edit the expression to
[malloc.site == "read_buffer" and not alloc.freed](#set:filter-source=malloc.site == "read_buffer" and not alloc.freed),
then [Apply](#do:filter-apply). The result is the large buffers from that call
site which survive to the end of the trace.

The language is Python-shaped and evaluates over the complete trace, not the
current playhead. Its three roots are:

- `alloc` — `address`, `span`, `size`, `usable`, `tags`, `freed`, `lifetime`;
- `malloc` — creator `seq`, `time`, `site`, `thread`, `stack`, and custom
  `fields`;
- `free` — terminating `seq`, `time`, and custom `fields`, or absent.

Use chained comparisons, `and`/`or`/`not`, `in`, `is None`, half-open
`range(A, B)`, and string methods such as `startswith`. Ctrl/Cmd-Space opens
type-aware completion. Typing checks a draft; only **Apply** changes the active
match set, and an invalid draft leaves the previous result intact.

Keep this filter applied for the final step.
