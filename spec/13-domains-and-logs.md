# 13 — Evidence Domains and Logs

heap-visualizer is growing from a heap viewer into a runtime-evidence viewer.
The heap is the **first** evidence domain, not the product's only shape; logs
are the second. This module states what every domain shares, and then
specifies the log domain. Design background: `docs/explorations/E022`.

How a domain's records are encoded is settled by
[D013](../docs/decisions/D013-hybrid-record-types.md): a built-in domain gets
its own `op` letter, and producer-defined kinds use `E` with a `kind` field.
The proposed next format revision (process identity, clock contract, header
kinds, and the interval domain) is
[E023](../docs/explorations/E023-trace-format-v2.md); it is not yet part of
this spec.

## DOM-001: One event spine

Every record that occupies an event index — of any domain — shares one
ordered spine: its `seq` (stream position), its timestamp `t`, its op, and its
thread. `seq` stays the one canonical coordinate
([MODEL-004](03-core-model.md#model-004-time-travel--seeks-and-snapshots));
`t` remains a lookup into it. The ordering, `seq`, and timestamp rules of
[TRACE-007](02-trace-format.md#trace-007-ordering-seq-and-timestamps) apply to
every domain's records identically.

A domain's records are read only from its own store: a reader handed a
record of another domain never reads its columns (an `L` or `E` record has
no `size` to read).

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

## DOM-004: The domain registry

The core keeps one registry of domains — today `heap`, `marks` (the `E`
landmarks), `logs`, and `intervals` (calls, spans and run slices,
[spec/14](14-intervals.md)) — so that a new domain is added in one place
rather than threaded through the engine:

- **One op table** maps every record type to its domain and kind
  (`M`/`F`/`R` → heap, `E` → marks, `L` → logs, `B`/`X`/`C` →
  intervals). Nothing decides a record's
  domain by comparing op numbers.
- **Concrete stores.** Each domain's payload store is a field of one
  struct, so hot paths (replay, filter scans, density bars, the address
  map) read their columns directly and pay nothing for the registry.
- **One cold surface.** Every domain answers the same questions: its
  descriptor, its record count and row ↔ seq mapping, a generic record
  summary, a paged query and locate, its timeline lanes and their hover,
  an optional state at a seq, and agent pages. The generic exports below
  and the agent's records page are written once against it.
- **Point stores.** A domain whose records are instants (logs, landmarks)
  reuses one columnar point store: a category per row with prefix sums, an
  interned label, a text arena, interned custom-field fragments with the
  domain's own field catalog, and LOG-004's query and locate. Logs are the
  six-level instance; marks have one category, and their label is the
  title.

A **descriptor** is `{id, name, kinds:[{op, kind}], shape, count, lanes,
fields, query:{params}, limits}`, plus `categories` and `keys` (the JSON
keys its rows use: `{category, label, text}`) for a point domain. `shape`
is `allocation` (heap), `point`, or `interval`
([IVL-007](14-intervals.md#ivl-007-the-domain-on-the-registry)), whose
descriptor adds its own keys. `fields` is the domain's field catalog
in `hp_fields_json`'s shape: the log domain catalogues its own custom keys
(they never enter the allocation filter's catalog); the marks domain lists
its keys from the trace-wide catalog it shares with the heap. `lanes` is
`[{id, domain, title, categories, colors}]`; `limits` gives `page` (rows
per browser page, 500), `agentPage` (200), `agentDefault` (50) and, for a
point domain, `textBytes` (1024).

**Lanes** come from descriptors: each domain's lanes are stacked upward
from just above the bottom tag lane in registry order, each cell colored by
the highest category in its column, and a domain without records draws
none. Today the log lane and the interval activity lane exist; a trace
without interval records draws LOG-005's pixels exactly.

**Generic record summary**: `{seq, t, thr, domain, kind, title, level?,
source?, fields}` — `title` is a log's message, a landmark's title, or an
allocation event's one-line description (`malloc 64 B at 0x1000`);
`level` (0–5) is present for a domain with categories; `source` is a log's
logger or an allocation's site, when there is one; `fields` is the custom
field object or `null`. In the agent's form `t` is an exact string and
`level` a name.

**Generic browser ABI** (JSON in the shared buffer, as ARCH-006):

| Export | Input | Result |
|--------|-------|--------|
| `hp_domains_json()` | — | `[descriptor, …]` in registry order |
| `hp_domain_query(len)` | `{domain, …query, from, count}` | `{total, from, rows}` — each row `{row, …}` in the domain's own keys: LOG-009's for logs, `{row, seq, t, thr, title, fields}` for marks, the generic summary for heap |
| `hp_domain_locate(len)` | `{domain, …query, seq}` | `{row, total}` |
| `hp_record_json(seq)` | — | the generic summary of spine record `seq`, or `null` |
| `hp_lanes_json()` | — | the lanes the loaded trace draws, bottom first |
| `hp_domain_state(len)` | `{domain, seq}` | the domain's state with `seq` records applied, or `null` for a domain without one |
| `hp_interval_window(len)` | `{track, axis, lo, hi, width, category?}` | one track's intervals in a viewport, culled ([IVL-008](14-intervals.md#ivl-008-the-window)) |
| `hp_tracks_json()` | — | the interval tracks, `{threads, cpus}` (IVL-008) |

A point domain's query is LOG-004's (`minLevel` only where it has
categories, `text`, `seqLo`/`seqHi`); the heap's query takes only
`seqLo`/`seqHi` — its selection language is the allocation filter. An
unknown `domain`, a request that is not a JSON object, or a query or locate
naming a parameter outside the domain's `query.params` (besides `domain`,
`from`, `count` and `seq`) answers the empty document with an `error`
(`unknown parameter <name>`), as an agent page refuses one. The native `Engine` exposes the same documents
(`domains_json`, `domain_query_json`, `domain_locate_json`, `record_json`,
`lanes_json`, `domain_state_json`, `interval_window_json`, `tracks_json`)
and `domain_state(domain, seq)` — the
marks domain's state is the last mark at or before the playhead, the
interval domain's its open call stacks, spans and CPUs
([IVL-005](14-intervals.md#ivl-005-state-at-the-playhead)). The interval
query's parameters are IVL-007's.

**Agent records**: the core provides one bounded page of any domain's
records, `Engine::agent_domain_records(domain, params)` →
`{domain, total, from, items, next}`, with `seqLo`/`seqHi`/`from`/`count`
bounded as LOG-008 (`count` 1–200, default 50) plus the domain's own
parameters (for logs `minLevel` and `text`; for marks `text`; for
intervals IVL-007's); an unknown
parameter is an invalid request. It backs
`GET /api/v1/domains/{d}/records` ([API-002](12-agent-api.md#api-002-discovery-and-overview));
`GET /api/v1/logs` is this page for `logs`.

## LOG-001: The log record `L`

A structured log line emitted by the traced program. `L` is a built-in
domain letter under [D013](../docs/decisions/D013-hybrid-record-types.md);
logs are not written as `E` records with a `kind`.

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
docked in the bottom edge group, open when the loaded trace has log
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
trace has log records. It is listed by `hp_lanes_json` as `logs.level`.

These exports are the log domain's instance of the generic ABI
([DOM-004](#dom-004-the-domain-registry)): `hp_logs_query` and
`hp_logs_locate` are `hp_domain_query` / `hp_domain_locate` with
`domain: "logs"` and answer identical documents. They stay for the browser
until it moves to the generic exports.

Input details: `minLevel` is a number 0–5 or a level name (aliases accepted)
and defaults to 0; `text` defaults to empty; numbers are read leniently
(clamped to the unsigned 32-bit range). `seqLo`/`seqHi` are inclusive spine
indexes; `hp_logs_locate` also honors them. `count` defaults to and is capped
at 500; `from` past the end yields an empty page with `from = total`. A
request that is not a JSON object answers `{total:0, from:0, rows:[],
error}` (query) or `{row:-1, total:0, error}` (locate). The native `Engine`
exposes the same documents as `logs_meta_json`, `logs_query_json`, and
`logs_locate_json`.
