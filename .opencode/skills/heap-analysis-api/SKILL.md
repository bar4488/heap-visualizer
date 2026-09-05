---
name: Heap Analysis API
description: Use an authenticated heap-visualizer local session to inspect traces, query allocations, analyze timelines and warnings, and make canonical annotations through /api/v1. Load this whenever a task provides a heap API base URL, bearer capability, or trace ID.
---

# Heap Analysis API

Use the supplied base URL, bearer capability, and trace ID. Analyze through the
API rather than reading a raw trace. Send the capability on every request:

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

Prefer bounded semantic endpoints over paging the entire allocation set.

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
literals, and `is None`/`is not None`. A filter input is always an object:

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
  "includeLandmarks":true
}
```

The raw before/after window may span at most 100 events.
Custom records appear as `operation:"event"` with their producer-supplied
`title`; allocation/free/realloc records expose creator identity and operation
semantics. Custom-record fields beyond the title are not returned by this
endpoint.

## Warnings

`GET /api/v1/warnings?from=0&count=100` returns warning items with `kind`,
`seq`, `msg`, and exact `detailExact`. Use these item sequences directly; do
not infer warning positions from later allocation detail. The envelope reports
`observed`, capped `retained`, and `omitted` counts.

## Canonical analysis mutations

First read `GET /api/v1/analysis?traceId=<url-encoded-trace-id>` and use its
current document revision. Ordinary mutations go to
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
`currentRevision`; reread analysis before retrying. Reusing the same request ID
with the same body is idempotent.
