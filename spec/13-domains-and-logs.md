# 13 — Evidence Domains and Logs

heap-visualizer is growing from a heap viewer into a runtime-evidence viewer.
The heap is the **first** evidence domain, not the product's only shape; logs
are the second. This module states what every domain shares, and then
specifies the log domain. Design background: `docs/explorations/E022`.

## DOM-001: One event spine

Every record that occupies an event index — of any domain — shares one
ordered spine: its `seq` (stream position), its timestamp `t`, its op, and its
thread. `seq` stays the one canonical coordinate
([MODEL-004](03-core-model.md#model-004-time-travel--seeks-and-snapshots));
`t` remains a lookup into it. The ordering, `seq`, and timestamp rules of
[TRACE-007](02-trace-format.md#trace-007-ordering-seq-and-timestamps) apply to
every domain's records identically.

One playhead, one view range, one crop, and one selected range coordinate
every domain's views.

## DOM-002: Domains own their payloads

Each domain keeps its own payload store and indexes, keyed by spine index.
A domain's payload columns must hold rows only for that domain's records:
heap columns (`id`, `addr`, `size`, links, sites, stacks, tags, snapshots)
must not grow a row per log record, and log columns must not grow a row per
heap record. A heap-only trace must load, seek, filter and render with no
added per-event cost from the existence of other domains.

Non-heap records are non-mutating with respect to the heap: replaying a
trace's heap records while skipping every other domain's records must produce
exactly the same live set at every heap event.

## DOM-003: What a domain provides

Each domain provides, within the core:

- parsing of its record types into its payload store;
- timeline lane data derived from load-time prefix sums, so a lane re-bins in
  O(width · log n) and never scans records;
- its rows in the Events list and its record view;
- its own query subject — the allocation filter language
  ([ANL-003](07-analysis.md#anl-003-filter)) stays a language over
  allocations and must not match another domain's records;
- bounded, paged reads for the browser and the agent API.

Domain-specific behavior is implemented once, in the core
([D011](../docs/decisions/D011-analysis-changes-have-one-core-implementation.md));
the worker and DOM present it.

## LOG-001: The log record `L`

A structured log line emitted by the traced program.

```json
{"seq":120,"t":10480,"op":"L","thr":2,"level":"warn","logger":"net.http","msg":"retrying request","attempt":3}
```

| Field | Req | Meaning |
|-------|-----|---------|
| `msg` | ✓ | Message text. A record without a string `msg` is malformed and dropped with a `malformed` warning. |
| `level` | — | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal` (case-insensitive; `warning` and `err` are accepted aliases). Absent means `info`. Any other value is read as `info` and flagged with a `bad-level` warning. |
| `logger` | — | Logger / component name. Interned. |
| `t`, `seq`, `thr` | — | As for `M` ([TRACE-004](02-trace-format.md#trace-004-malloc-record-m)). |

Every other top-level key is a custom field of the log record, preserved and
shown verbatim, as for the other records
([TRACE-001](02-trace-format.md#trace-001-general-rules)).

An `L` record occupies an event index. Like `E`, it must not affect
allocation state and contributes no allocation or free mark to the heap
density of either timeline. `site` and `stack` are not read off it.

Limits: `msg` beyond 16 KiB is truncated at a character boundary and the
record carries a `long-log` warning; the record is otherwise kept.

## LOG-002: Severity is ordered

Levels are ordered `trace < debug < info < warn < error < fatal`, encoded as
0–5. "Minimum level *L*" means every record whose level is ≥ *L*.

## LOG-003: The log store

Log payloads are columnar like the heap store
([MODEL-001](03-core-model.md#model-001-the-columnar-store)): per log row its
spine index, level, interned logger id, message, and custom-field fragment.
Messages are stored in one contiguous byte arena with offsets — no per-row
heap-allocated strings. Load-time prefix sums per level over spine index make
"how many logs of level ≥ *L* in this seq range" two lookups.

## LOG-004: Log queries

A log query has three parts, all optional:

- `minLevel` (LOG-002), default `trace`;
- `text` — a case-insensitive substring match against `msg` and `logger`;
- `seqLo`/`seqHi` — an inclusive spine range.

Results are ordered by `seq`. Every read is paged (`from`, `count`, at most
500 rows per page) and reports the total number of matches. A query with
`text` scans message bytes once per query and must not allocate per row
scanned. "Locate" answers, for a seq, the index within the matched list of
the last match at or before that seq — the operation that lets a log view
follow the playhead.

Case folding is ASCII: letters `A`–`Z` match `a`–`z`, and every other byte
(including non-ASCII text) must match exactly. A query without `text` is
answered from LOG-003's prefix sums; the browser engine keeps the last text
query's matches, so paging and locate against the same query do not rescan.

## LOG-005: Logs on the timelines

Both strips carry a **log lane** when the trace has log records: a thin band
along the strip's bottom edge, beneath the free bars and above the tag lanes,
in which each pixel column is colored by the most severe log level in it
(no log = empty). The lane is derived from LOG-003's prefix sums and drawn by
the same core timeline renderer as the density bars. The strip hover tooltip
adds the column's log count by level.

The lane is 2–4 px tall and sits directly above the space of the bottom tag
lane, which stays reserved whether or not anything is tagged so the lane does
not move when tagging starts. Colors: trace and debug dim grey, info blue,
warn yellow, error red, fatal magenta-red.

## LOG-006: Logs in the Events list and stepping

Log records appear in the Events list in stream order: the row shows the
level and the message in place of address, size and site, and is visibly a
log row rather than an allocation row. Stepping and playback walk log records
as they walk every other record. Clicking a log row in the Events list seeks
there and reveals the row in the Logs panel; it does not change the
allocation selection.

The engine's Events-list JSON (`hp_events_json`, `hp_events_filtered_json`,
`hp_event_json`) renders a log record in the style of an `E` row:

```json
{"seq":120,"op":4,"t":10480,"e":null,"level":3,"logger":"net.http","msg":"retrying request","thr":2,"extra":{"attempt":3}}
```

`op` 4 is the log op; `level` is 0–5; `logger` and `thr` are `null` when
absent; `extra` (the custom fields) is present only when the record has any.
`e` is `null` because a log record touches no allocation. While an
allocation filter is active the filtered list omits log rows, as it omits `E`
rows (DOM-003). `hp_meta_json` reports the log record count as `nLog`.

## LOG-007: The Logs panel

A declared panel ([SHELL-003](09-ui-shell.md#shell-003-panels-are-declared-as-data))
titled **Logs**, rendered as a terminal:

- monospace text on a dark terminal background in both themes, one line per
  record: relative time, thread, level badge, logger, message, then custom
  fields as `key=value`;
- level coloring: trace/debug dim, info default, warn yellow, error red,
  fatal red bold;
- a **playhead cursor**: lines after the playhead are dimmed as "not yet
  happened", and the line at or before the playhead is marked;
- **follow** (on by default): while following, the panel keeps the playhead
  line in view as playback and seeks move it — `tail -f` while playing;
  scrolling by hand turns follow off, and a control turns it back on;
- a minimum-level selector and a text search box; both narrow the list via
  LOG-004, and the heading shows `shown / total`;
- virtualized: the DOM holds only visible lines regardless of log count;
- clicking a line seeks the playhead to that record; text is selectable and
  copyable as plain lines.

Default layout ([SHELL-008](09-ui-shell.md#shell-008-the-default-layout)):
docked in the left drawer below Events, open when the loaded trace has log
records and closed otherwise.

## LOG-008: Logs in the agent API

`GET /api/v1/logs?minLevel=&text=&seqLo=&seqHi=&from=&count=` returns
`{traceId, total, from, items:[{seq, t, thr, level, logger, msg, fields}], next}`
under the bounds of [API-001](12-agent-api.md#api-001-progressive-bounded-evidence)
(`count` default 50, at most 200; `t` as a string). The overview
([API-002](12-agent-api.md#api-002-discovery-and-overview)) adds log counts
by level, and session capabilities list the endpoint.

Item `level` is the lowercase level name; `thr` is the thread number or
`null`; `fields` is the custom-field object or `null`; `next` is the next
`from`, or `null` on the last page. `minLevel` accepts a level name (aliases
accepted) or `0`–`5`. `count` of 0 or over 200, an unknown `minLevel`, and
`text` over 1 KiB are invalid requests, as are unknown, repeated, or
non-numeric `seqLo`/`seqHi`/`from`/`count` parameters (`400
invalid_request`). Session capabilities advertise `endpoints.logs` and the
`defaultLogPage`, `maximumLogPage`, and `maximumLogTextBytes` limits from the
core's constants. The core provides this as
`Engine::agent_logs(&LogsParams)` and the overview's `logs: {records,
byLevel:{trace..fatal}}`; the transport adds `traceId`.

## LOG-009: Browser ABI

Following the existing JSON-in-buffer convention
([ARCH-006](08-architecture.md#arch-006-protocol-conventions)):

| Export | Input (JSON in the shared buffer) | Result (`hp_ret` JSON) |
|--------|-----------------------------------|------------------------|
| `hp_logs_meta_json()` | — | `{count, byLevel:[n0..n5], loggers:[{name,count}]}` (loggers capped at 200, most frequent first) |
| `hp_logs_query(len)` | `{minLevel, text, seqLo?, seqHi?, from, count}` | `{total, from, rows:[{row, seq, t, thr, level, logger, msg, fields}]}` — `row` is the index within the match list, `level` 0–5, `t` a number, `fields` the custom-field object or `null` |
| `hp_logs_locate(len)` | `{minLevel, text, seq}` | `{row, total}` — `row` = last match with seq ≤ `seq`, or `-1` |

The timeline lane (LOG-005) needs no separate export: it is drawn into the
strip pixels, and its hover counts arrive in the existing `hp_tl_hover` JSON
as `logs:{count, byLevel:[...]}`. The `logs` key is present only when the
trace has log records.

Input details: `minLevel` is a number 0–5 or a level name (aliases accepted)
and defaults to 0; `text` defaults to empty; numbers are read leniently
(clamped to the unsigned 32-bit range). `seqLo`/`seqHi` are inclusive spine
indexes; `hp_logs_locate` also honors them. `count` defaults to and is capped
at 500; `from` past the end yields an empty page with `from = total`. A
request that is not a JSON object answers `{total:0, from:0, rows:[],
error}` (query) or `{row:-1, total:0, error}` (locate). The native `Engine`
exposes the same documents as `logs_meta_json`, `logs_query_json`, and
`logs_locate_json`.
