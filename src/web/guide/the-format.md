# Trace format

Heap Visualizer consumes `.heapl`: JSONL with one object per line. `#` starts a
comment. A header is followed by `M` (malloc), `F` (free), `R` (realloc), and
optional `E` (custom event) records. Any producer that can print JSONL can emit
a trace.

[Download the annotated sample](guide/traces/format.heapl) or
[open it here](index.html?trace=guide/traces/format.heapl&guide=1). It is a
compact, executable description of the format and includes producer-defined
fields.

Unknown top-level keys are preserved. Fields on `M`, `F`, and `R` appear on the
allocation and are queryable through `malloc.fields.<key>` or
`free.fields.<key>`. When birth and death records share a key, the death value
wins. An `E` record is a timestamped landmark with a title and arbitrary fields;
it has no address or allocation state.

The viewer is client-side: opening a trace does not upload it.
