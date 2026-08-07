# The format

A trace is a `.heapl` file: JSONL, one JSON object per line, `#` starts a
comment. A header line, then one line per `malloc` / `free` / `realloc`. Any
language that can print a line can produce one.

There is a fourth record type, and it is optional.
`{"op":"E","title":"…"}` is a **custom event** — a landmark with no address
and no size. It takes a place in the stream so a long trace has parts you can
name. Put any fields on it you like. The Events panel lists it, and clicking
the row opens an Event window with those fields.

[Download a sample trace](guide/traces/format.heapl) — 60 operations, with a
commented header explaining every field.

**To learn the format fastest, hand that file to a language model.** It is
small, self-describing, and regular enough that a model can read it once and
write a producer for your program. Ask for an emitter in your language; the
sample is the whole specification you need to give it.

You can also open it here:
[format.heapl](index.html?trace=guide/traces/format.heapl&guide=1). It carries
custom producer fields — `pool`, `owner`, `hot` — so the Filter panel's
trace-field list has something in it.

Anything the format does not define is yours. Unknown top-level keys ride along
on the record, appear in the allocation panel, and can be filtered on.

`free` and `realloc` records take custom fields too. They describe the same
allocation the `malloc` did, so the panel shows both sets in one list. When the
two records use the same key, the freeing one wins and the row says so — the
sample's frees carry `refcount: 0` over the allocation's own count.
