# Agent API

The authenticated local-server API exposes semantic evidence from its one
active trace. It is the same `/api/v1` authority used by a connected browser;
an MCP adapter may translate these operations later but must not implement
filtering, allocation semantics, or analysis changes independently.

## API-001: Progressive, bounded evidence

An agent should inspect a trace in this order when each preceding result shows
that more detail is useful:

1. session capabilities and a compact trace overview;
2. grouped allocation summaries or a binned timeline;
3. compact allocation matches;
4. one allocation with creator and death records; and
5. a small stream window around a relevant event.

Agent semantic responses must contain `traceId` and, when analysis can affect
the result, `analysisRevision`. They must contain no canvas, viewport, DOM,
playhead, or layout state. Integer byte counts, addresses, trace times, and
allocation ids that may exceed JavaScript's exact integer range are strings.
Every agent semantic response is limited to 256 KiB; a response that cannot fit
returns `413 response_too_large` and directs the caller to reduce its page or
range.

## API-002: Discovery and overview

`GET /api/v1/session` returns a compact metadata summary and a `capabilities`
object containing endpoint paths, accepted allocation orderings, summary
groups, timeline domains, tag-query operations, and all transport limits. It
must not embed the potentially unbounded site or thread catalogs.

`GET /api/v1/overview?top=N` returns event/allocation operation counts, trace
time bounds and unit, total allocated bytes, live allocations and bytes at end,
peak live bytes and position, warning counts by semantic warning name, analysis
object counts, and the top allocation sites by requested bytes. `top` defaults
to 10 and is from 1 through 50; `topSitesOmitted` reports omitted groups.

`GET /api/v1/warnings?from=&count=` retains the existing bounded paging rules.
Each item includes a stable string `kind` in addition to its legacy numeric
`code`, message, sequence, and exact string detail. The envelope distinguishes
`observed` warnings from the parser's capped `retained` evidence and reports
`omitted`.

## API-003: Filter discovery and validation

`GET /api/v1/filter/schema?from=&count=` returns the core evaluator's built-in
namespaces, field types, functions, operators and literals. Its custom-field
catalog is paged: `count` defaults to 20, is at most 100, and
`customFieldPage` contains `from`, actual `count`, `total`, and nullable `next`.

`POST /api/v1/filter/check` accepts `{traceId, source}`. A valid source returns
`valid: true`; syntax, type, unknown-field, or unresolved-name failures return
`400 invalid_filter` with a UTF-8 source-span `{start,end}`. Source is limited
to 16 KiB. Empty source means all allocations. Every endpoint accepting a
filter accepts either `{source}` or `{savedFilterId}`, but never both. Filters
are ephemeral and must not alter browser or server view state.

## API-004: Compact allocation query

`POST /api/v1/allocations/query` accepts:

```json
{
  "traceId": "sha256:…",
  "filter": { "source": "alloc.size >= 4096" },
  "orderBy": "size-desc",
  "limit": 20,
  "cursor": null
}
```

`filter` is optional and defaults to all allocations. `limit` defaults to 20
and is from 1 through 100. Supported orderings are `creator-asc`, `birth-desc`,
`size-desc`, `lifetime-desc`, and `death-desc`; ties are creator-event order.
The response contains aggregate matched counts/bytes plus compact items with
creator identity, allocation id/address/size/usable size, birth/death/lifetime,
site/thread, and current name/color/tags. It deliberately omits stack and
custom fields.

Usable-byte totals count only records carrying a non-zero usable size;
`usableKnownAllocations` states that denominator.

`nextCursor` is an opaque cursor bound to trace identity, analysis revision,
filter source, and ordering. A changed revision, changed query, malformed
cursor, or out-of-range cursor returns `409`; clients must restart the query.

## API-005: Allocation detail

`GET /api/v1/allocations/{creator}` returns the compact allocation fields plus
operation, end address, realloc predecessor/successor relations, and explicit
`creatorEvent` and nullable `deathEvent`. Those records include exact time,
semantic operation name, custom fields, and creator site/thread/stack. A
non-creator or missing event returns `404`. Render geometry is forbidden.

## API-006: Allocation summaries

`POST /api/v1/allocations/summarize` accepts `traceId`, optional `filter`,
`groupBy`, and optional `limit`. Grouping is one of `site`, `thread`, `freed`,
`size-bucket`, `lifetime-bucket`, or `tag`; the limit defaults to 20 and is at
most 50. Groups are ordered by requested bytes then allocation count and carry
stable `key`, display `label`, allocation/requested/usable counts, and
freed/live-at-end counts. `groupsOmitted` makes truncation explicit. A tagged
allocation contributes to each of its tags.

## API-007: Timeline summary

`POST /api/v1/timeline` accepts `traceId`, optional `filter`, `domain`
(`sequence` or `time`), half-open `range: {from,to}`, and `bins` (default 50,
maximum 200). Time bounds may be decimal strings; sequence bounds are integers.
Each bin contains allocation, free, realloc, and custom-event counts plus
allocated, freed, and net live-byte deltas. For a realloc, the old allocation's
free contribution and new allocation's birth contribution are filtered
independently. Custom landmarks remain visible as temporal context.

## API-008: Focused stream context

`POST /api/v1/stream/context` accepts `traceId`, optional `filter`, a valid
`center` event, `before`, `after`, and `includeLandmarks` (default true). The
half-open raw sequence range may span at most 100 events. The response returns
only events touching matching allocations plus requested custom landmarks,
using string operation names. Realloc events identify both their creator and
the allocation they replace.

## API-009: Canonical and bulk analysis changes

`POST /api/v1/analysis/changes` remains the sole vocabulary for ordinary
analysis mutations. It also accepts optional `requestId`: 1–64 ASCII letters,
digits, `_`, or `-`. Repeating the same retained request returns its original
successful response; reusing its id for a different body conflicts.

`POST /api/v1/analysis/tag-query` is the compact bulk operation. It accepts
`traceId`, `expectedRevision`, optional `requestId`, an existing `tagId`, one
filter, and `operation` (`add`, `remove`, or `replace`). The Rust core evaluates
the filter and applies one atomic `ReplaceTagMembers` change. The response gives
the new revision and matched/changed counts. Because publishing every creator
id could be unbounded, the corresponding change-journal entry requires a full
analysis snapshot: the response says `snapshotRequired: true` and
`GET /api/v1/changes` returns `reset: true` to clients behind that revision.
Persistence must complete before acknowledgement, exactly as for ordinary
analysis changes.

Stale analysis writes return `409 revision_conflict` with `currentRevision`.
All failures use `{error:{code,message}}`, adding `diagnostic` or
`currentRevision` when applicable.

## API-010: Scope boundary

The first agent API does not load or switch traces, import/export `.heapa`,
control browser state, render on the server, maintain multiple active traces,
or return arbitrary-sequence heap snapshots. Overview, timeline deltas,
allocation birth/death evidence, and focused stream context are the bounded
v1 temporal workflow.
