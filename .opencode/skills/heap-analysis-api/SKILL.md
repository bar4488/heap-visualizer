---
name: Heap Analysis API
description: Use an authenticated heap-visualizer local session to inspect traces, query allocations, analyze timelines and warnings, and make canonical annotations through /api/v1. Load this whenever a task provides a heap API base URL, bearer capability, or trace ID.
---

# Heap Analysis API

Use the supplied base URL, bearer capability, and trace ID. A compact connection
string may instead be supplied as `http://127.0.0.1:PORT#CAPABILITY`; the part
before `#` is the base URL and the complete fragment after `#` is the bearer
capability. Discover the trace ID from `/api/v1/session` when it was not supplied.
Analyze through the API rather than reading a raw trace. Send the capability on
every request:

```sh
curl -sS -H "Authorization: Bearer $CAPABILITY" "$BASE/api/v1/session"
```

For JSON requests, also send `Content-Type: application/json`. Every POST body
below requires the exact `traceId`. Fields not shown are rejected. Large byte
counts, times, addresses, and allocation IDs may be decimal or hexadecimal
strings; creator event indices and sequence bounds are JSON integers.

## Progressive workflow

1. `GET /api/v1/session`, then `GET /api/v1/overview?top=10`.
2. If warnings exist, page `GET /api/v1/warnings?from=0&count=100` before
   trusting totals or allocation identity.
3. Use summaries or timelines to identify cohorts/windows.
4. Query compact allocation matches.
5. Fetch allocation detail for representative or boundary creators.
6. Request focused stream context only when neighboring events matter.
7. If the overview reports `logs.records > 0`, read the program's own logs
   around interesting sequence ranges (see Logs).

Prefer bounded semantic endpoints over paging the entire allocation set.
`capabilities.limits` in the session response lists every page, body, and
response limit. A response over 256 KiB is refused with
`413 response_too_large`; repeat with a smaller page, limit, or range.

## Filters

Discover fields with `GET /api/v1/filter/schema?from=0&count=100`.

Validate source with:

```json
{"traceId":"sha256:…","source":"not alloc.freed"}
```

at `POST /api/v1/filter/check`.

The Python-shaped DSL uses `alloc`, `malloc`, and `free` namespaces. Common
fields include `alloc.size`, `alloc.freed`, `alloc.lifetime`, `alloc.tags`,
`malloc.seq`, `malloc.time`, `malloc.site`, `malloc.thread`, `free.seq`, and
`free.time`. Producer-defined fields use `malloc.fields.<name>`; deallocation
fields use `free.fields.<name>`. Use `and`, `or`, `not`, comparisons, `in`, set
literals, and `is None`/`is not None`.

In a trace with intervals, `malloc.calls` is the call stack open on the
allocating thread, `malloc.spans`/`malloc.span_ids` the thread's current span
and its ancestors, and `free.calls`/`free.spans`/`free.span_ids` the same at
the free (missing when never freed). Their only operation is membership of a
string constant: `"parse_body" in malloc.calls`. Without intervals they are
empty, so `in` is false. A filter input is always an object:

```json
{"source":"malloc.site == \"example_site\" and not alloc.freed"}
```

It may instead be `{"savedFilterId":"…"}`, never both.

## Allocation queries and detail

`POST /api/v1/allocations/query`:

```json
{
  "traceId":"sha256:…",
  "filter":{"source":"alloc.size >= 4096"},
  "orderBy":"size-desc",
  "limit":20,
  "cursor":null
}
```

The filter and cursor are optional. Orders are `creator-asc`, `birth-desc`,
`size-desc`, `lifetime-desc`, and `death-desc`; limit is 1–100. Continue with
the exact same request and returned `nextCursor`. Compact items omit custom
fields.

Fetch one allocation with
`GET /api/v1/allocations/{creator}?traceId=<url-encoded-trace-id>`. The path key
is the creator event, not allocation ID. Detail includes custom fields,
creator/death events, and `reallocatedFrom`/`reallocatedTo` creator relations.
Follow those relations to reconstruct realloc lineage.

## Summaries, timeline, and context

`POST /api/v1/allocations/summarize` requires `groupBy`:

```json
{
  "traceId":"sha256:…",
  "filter":{"source":"not alloc.freed"},
  "groupBy":"site",
  "limit":20
}
```

Groups: `site`, `thread`, `freed`, `size-bucket`, `lifetime-bucket`, `tag`.

`POST /api/v1/timeline` requires a half-open range:

```json
{
  "traceId":"sha256:…",
  "filter":{"source":"malloc.site == \"worker_buffer\""},
  "domain":"sequence",
  "range":{"from":0,"to":1000},
  "bins":50
}
```

Domains are `sequence` and `time`; time bounds may be decimal strings. Bins
must not exceed 200.

`POST /api/v1/stream/context`:

```json
{
  "traceId":"sha256:…",
  "filter":{"source":"not alloc.freed"},
  "center":500,
  "before":10,
  "after":10,
  "includeLandmarks":true,
  "includeLogs":false
}
```

The raw before/after window may span at most 100 events.
Custom records appear as `operation:"event"` with their producer-supplied
`title`; allocation/free/realloc records expose creator identity and operation
semantics. Custom-record fields beyond the title are not returned by this
endpoint. Log records in the window are left out unless `includeLogs` is true
(then they appear as `operation:"log"` with `level`, `logger`, `msg`,
`fields`); when left out, `omitted.logs` counts them.

## Logs

`GET /api/v1/logs?minLevel=warn&text=timeout&seqLo=0&seqHi=5000&from=0&count=50`
pages the trace's structured log records (`L`) in sequence order. Every
parameter is optional: `minLevel` is `trace`…`fatal` (records at or above it),
`text` a case-insensitive substring of message or logger (at most 1 KiB),
`seqLo`/`seqHi` an inclusive sequence range, `count` at most 200. Items carry
`seq`, `t` (string), `thr`, `level`, `logger`, `msg`, and `fields`; follow
`next` for the next page. Logs are evidence about what the program was doing
at a sequence, not proof that it caused a heap event — correlate by sequence
range, e.g. errors near a growth window found with the timeline.

## Other evidence domains

`GET /api/v1/domains` lists every evidence domain (`heap`, `marks`, `logs`)
with its record count, kinds, field catalog, and `query.params` — the
domain's own record parameters. `GET
/api/v1/domains/{domain}/records?seqLo=&seqHi=&from=&count=&…` pages any
domain's records the same way as `/logs` (for `marks`, `text` matches the
title). `/logs` is this page for `logs`. An unknown domain is
`404 unknown_domain`; a parameter the domain does not accept is `400`.

## Warnings

`GET /api/v1/warnings?from=0&count=100` returns warning items with `kind`,
`seq`, `msg`, and exact `detailExact`. Use these item sequences directly; do
not infer warning positions from later allocation detail. The envelope reports
`observed`, capped `retained`, and `omitted` counts.

## Canonical analysis mutations

First read `GET /api/v1/analysis/summary` and use its `analysisRevision`. It
also lists every existing tag (`id`, `name`, `color`) and counts the other
analysis objects; read per-allocation names, colors, and tags through allocation
query or detail. Do not read `GET /api/v1/analysis`: it is the browser's
complete synchronization snapshot, grows with tag membership, and is not
size-bounded. After a successful write, use the returned `revision` for the next
write instead of rereading. Ordinary mutations go to
`POST /api/v1/analysis/changes`:

```json
{
  "traceId":"sha256:…",
  "expectedRevision":0,
  "requestId":"unique-id",
  "change":{"type":"putTag","id":"suspect","name":"Suspect","color":"#d9485f"}
}
```

Useful change forms are:

```json
{"type":"putTag","id":"tag-id","name":"Display name","color":"#d9485f"}
{"type":"setAllocationTag","creator":42,"tagId":"tag-id","present":true}
{"type":"setAllocationName","creator":42,"name":"request root"}
{"type":"setAllocationColor","creator":42,"color":"#d9485f"}
{"type":"putSavedFilter","id":"large-live","name":"Large live","source":"not alloc.freed and alloc.size >= 4096"}
```

After creating a tag, atomically tag a filter result with
`POST /api/v1/analysis/tag-query`:

```json
{
  "traceId":"sha256:…",
  "expectedRevision":1,
  "requestId":"unique-bulk-id",
  "tagId":"suspect",
  "filter":{"source":"not alloc.freed and alloc.size >= 4096"},
  "operation":"replace"
}
```

Operations are `add`, `remove`, and `replace`. The tag must already exist.
Success returns `revision`, `matched`, `changed`, and `snapshotRequired:true`.
Use the new revision for subsequent writes. A `409 revision_conflict` includes
`currentRevision`; reread `/api/v1/analysis/summary` before retrying. Reusing the same request ID
with the same body is idempotent.
