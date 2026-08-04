# The format

A trace is a `.heapl` file: JSONL, one JSON object per line, `#` for comments.
A header line, then one line per `malloc` / `free` / `realloc`. Nothing else —
no schema to install, no binary framing.

There is a fourth record type you never have to use: `{"op":"E","title":"…"}`
is a **custom event** — a landmark, not an allocation. It has no address and
no size and changes nothing about the heap; it takes a place in the stream so
that a long trace has parts you can name. Give it any fields you like; the
Events panel lists it, and clicking it opens an Event window showing them.

[Download a sample trace](guide/traces/format.heapl) — 60 operations, with a
commented header explaining every field.

**The fastest way to learn the format is to hand that file to a language
model.** It is small, it is self-describing, and the shape is regular enough
that a model reads it once and can then write a producer for your own program.
Ask it for an emitter in your language; the sample is the whole specification
you need to give it.

You can open it here too: [format.heapl](index.html?trace=guide/traces/format.heapl&guide=1).
It carries custom producer fields — `pool`, `owner`, `hot` — so the Filter
panel's trace-field list has something in it.

Anything the format does not define is yours. Unknown top-level keys ride along
on the record, show up in an allocation's panel, and can be filtered on.

That holds for `free` and `realloc` records too, and they describe the same
allocation the `malloc` did — so the panel shows both sets in one list. Where
the two records use the same key, the freeing one wins and says so; the sample
frees carry `refcount: 0` over the allocation's own count.
