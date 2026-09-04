# Now

_Updated: 2026-09-04._

**No count in this file is written by hand.** Test counts, module sizes and
requirement totals are derivable, and the ones that used to be here had all
drifted — two of them disagreed with each other about the same crate. Run the
command instead; [context](context.md#test) lists them, and
[T022](tickets/T022-docs-cite-commands-not-counts.md) is why.

A heap allocation visualizer: a `.heapl` JSONL trace of malloc/free/realloc
events — plus a producer's own `E` landmarks — on an address-line map with two
coordinated timelines and full time travel, plus an analysis layer (tags,
names, colors, marks) saved to `.heapa`.
Rust → WASM core in a Web Worker with OffscreenCanvas; the page is fully
client-side.

## Read first

| Read | For |
|---|---|
| [README](README.md) | How work is done here, and the three rules that constrain it |
| [context](context.md) | Build, run, test, verify |
| [spec/README](../spec/README.md) | The authoritative spec, ten modules. When behavior and spec disagree, one of them is wrong. |
| [spec/01-overview](../spec/01-overview.md), [spec/08-architecture](../spec/08-architecture.md) | Goals and the three-layer split, in that order |
| [E007](explorations/E007-web-architecture-direction.md) | Where the web layer is going and why the host is last |
| [D004](decisions/D004-typescript-is-the-language-for-web.md), [E008](explorations/E008-typescript-and-the-build-boundary.md) | Why it is TypeScript with a build step, and what that costs |
| [D007](decisions/D007-prose-serves-the-code.md) | **How much to write.** Read before filing a ticket or editing this file. |

## State

**Rust core (`src/core/`) — healthy; filter syntax is a separate
crate, and filter evaluation is a compiled plan rather than an interpreter.**
`src/core/src/filter_plan.rs` lowers the checked tree to `Pred` over the
store's columns and executes it a 64-event block at a time; `filter_eval` keeps
checking, completion, and — under `#[cfg(test)]` — the tree walk, which now
exists only as the oracle every filter test is compared against. Tag membership has one owner
(`Store::tag_members`) and four derived indexes beside it, so no tag path's
cost depends on which id a tag happened to get
([D009](decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md),
[T044](tickets/T044-tag-scans-track-tags-in-use.md)); the rule to keep is that
those indexes are written only by the four mutation methods and checked by
`Store::assert_tag_indexes`. The engine has clean module boundaries
and its native tests assert
real invariants: snapshot seek ≡ forward replay, pick prefers the newest
overlap, anchor stability across reflow. Every performance and soundness
finding from the 2026-07-24 review is fixed. `src/filter-dsl/` is
dependency-free and owns the grammar alone; its tests cover the Python-shaped
syntax, source-spanned AST, parser limits, incomplete cursor contexts, and the
lossy lexer that feeds highlighting. It builds twice: as an rlib the core
links, and as `dist/filter_lexer.wasm` for the editor.

**Web layer (`src/web/`) — all TypeScript now, split on the
shell/domain seam, no other internal structure yet.** `main.ts` was one flat
scope and is now trace/worker/toolbar wiring
plus the three coordinated views, and it owns `UIState`, the shared state every
other module takes as `deps.ui`.
`src/web/shell/` is domain-independent and stays that way by
check: `grep -ric heap src/web/shell/` reports 0 for every file.
`src/web/heap/` — analysis, the panel table, the events panel — and the
`src/web/session.ts` boundary module hold the rest.
The Filter panel is the draft/applied expression editor, speaks the typed
check/apply/mode worker protocol, and **highlights as you type** from a second
wasm module built from `src/filter-dsl/` and loaded on the main thread
([T043](tickets/T043-filter-syntax-highlighting.md)).

**The in-app guide is a short technical walkthrough, not a reference manual.**
Its six sections lead one investigation over a small trace: load, alter the map,
seek, inspect, query, and preserve the result. Each keeps only the explanation
needed to understand its action and expected observation. Standard Markdown
soft wraps render as paragraphs, and headings organize the drawer without rules.

**The filter language is Python.** `and`/`or`/`not`, `in` for every membership,
`range(lo, hi)`, `is None`, chained comparison, `len()`, `startswith` —
[ANL-003](../spec/07-analysis.md#anl-003-filter) is the rule and
[E019](explorations/E019-a-python-shaped-filter-language.md) the design. Every
field hangs off one of three objects: `alloc` is the allocation, `malloc` the
record that created it, `free` the record that ended it — so `malloc.site`,
`free.fields.reason`, `alloc.tags`, and `named("x").alloc.address`. There are
no bare field names; each removed spelling is a diagnostic naming what replaced
it, and the persisted filter language is version 3, so an older source is read
back as no filter rather than restored broken.
`filter_eval::resolve_path` is the single owner of what a path names, and the
checker, the plan, the oracle and the completion catalog all call it.
**Numbers are integers and floats**, one type to the person
writing a filter, mixing under every numeric operator and comparing exactly —
an integer operand is never widened to a double
([ANL-012](../spec/07-analysis.md#anl-012-numbers-in-the-filter-language),
[T034](tickets/T034-the-filter-language-has-floats.md)). Completion follows the
objects: a slot offers only the namespaces holding a field of the wanted type,
and each object offers only its own fields. Custom trace fields are filterable
through `malloc.fields.<key>` and `free.fields.<key>`, checked against a
catalog the load pass builds
([ANL-010](../spec/07-analysis.md#anl-010-filtering-on-custom-trace-fields),
[ANL-011](../spec/07-analysis.md#anl-011-filtering-relative-to-a-named-allocation)).
Both have a UI: an allocation's custom fields are their own
typed section of the allocation panel, each with a one-click predicate, and the
Filter panel lists the trace's whole field catalog — the panel section is
`src/web/heap/custom-fields.ts`, pure and tested. That section covers **both records that describe an allocation** — the
creator's fields and the freeing `F`/`R`'s, merged, the death value winning a
shared key and its row reading `free.fields.<key>`
([ANL-006](../spec/07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows),
[T035](tickets/T035-death-record-custom-fields.md)). `python3 gen.py --fields`
makes a trace carrying custom fields, one case per value shape and catalog
outcome the UI distinguishes ([T031](tickets/T031-gen-fields-cover-the-panel-cases.md));
`src/web/guide/traces/format.heapl` is a small checked-in one, and no other
trace in the repository has any.

**The trace format has a fourth record type, and it is not an allocation.**
`{"op":"E","title":"phase: request",…}` is a producer's landmark: it takes a
seq so the playhead can rest on it, carries a label and custom fields, and
touches no allocation state at all
([TRACE-010](../spec/02-trace-format.md#trace-010-custom-event-record-e),
[T036](tickets/T036-custom-events.md)). The Events panel lists it as an `E`
row and a click opens the Event window; the filtered list drops it, because
the filter language is over allocations. The engine's guard is that
`push_event_json` reports `e: null` for one — nothing downstream can select a
non-allocation — and the native test is that the live set at every playhead
position matches the same trace with the `E` records removed. `gen.py
--events` emits them.

The expression is also the single state behind the filter actions. Site,
thread, tag, and untagged legend chips toggle visible predicates and apply
them; **match range** replaces and applies the expression; named expressions
ride in `.heapa` marks; and **Tag matches** snapshots the applied creator set
into an ordinary tag. Pure source rewrites and marks parsing are covered by
the web suite, while the core match snapshot has a native invariant test.

**There is one server-side surface now, and the viewer is still client-side.**
`src/server/` is a stdlib Python process that serves `dist/` and four routes
beside it: the toolbar's **Request…** form posts to it, requests append to a
JSONL file, and `/admin` reviews them — set a status, or delete, which appends a
tombstone and hides the request without erasing its line
([T049](tickets/T049-delete-a-request.md)) — behind `HEAP_ADMIN_TOKEN` — which
`docker-compose.yml` defaults to `admin` so a bare `docker compose up` works,
warning on every start that it is running on a known string
([T048](tickets/T048-a-default-admin-token.md)). The service itself keeps no
default and serves nothing when the variable is unset
([spec/11](../spec/11-feature-requests.md),
[D010](decisions/D010-feature-requests-are-server-side.md)). No trace or
analysis data reaches it, and the app works with it absent — `./serve.py`
answers the POST with 501, which the form reports as *served without the
request service* rather than as a rejection. `docker compose up` runs the two
together; the image carries no toolchain and bind-mounts an already-built
`dist/`, so [TOOL-002](../spec/10-tooling.md#tool-002-build)'s one build path
is intact and [T038](tickets/T038-drop-the-docker-build.md) is not being
reversed.

**A separate server-only native binary now proves the future local data
boundary.** `src/local-server/` binds to loopback and prints a
deployment-agnostic connection string carrying a fresh bearer capability only
in its fragment. Any compatible hosted UI can accept it through Connect…,
keeps it for that tab, and visibly reports connected or the distinct failure
states; an ordinary visit remains standalone and makes no local request
([ARCH-008](../spec/08-architecture.md#arch-008-local-data-server-connection),
[T050](tickets/T050-prove-the-hosted-to-loopback-connection.md)). It serves no
trace yet and does no rendering; E021's next slice is the native data engine.

**Verification — native, web and service suites, a type-checker, and a
person.** `cargo test`
covers the engine and the filter parser/completion contexts;
`node --test 'src/web/**/*.test.ts'` covers the pure functions, the panel
table, the guide's markdown renderer, and both persisted round-trips, with no
npm and no browser. `tsc` covers
what those do not reach: the worker protocol
(`src/web/protocol.ts`, imported by both sides), the persisted shapes, and the
panel records — a message name one side does not know fails the build.
`python3 -m unittest discover -s src/server` covers the request service against
a real socket, and the local data server has its own Rust transport suite. How
strict that check is is a named list of flags rather than `strict: true`, most
on and two off, per [D005](decisions/D005-strictness-is-per-flag.md).

**Invoke the compiler as `node_modules/.bin/tsc`.** `npx tsc` works only when
`node_modules/` is already there; without it npx fetches an unrelated package
and a piped `| grep -c 'error TS'` reads zero errors from a compiler that never
ran ([T021](tickets/T021-live-docs-drop-npx-tsc.md)).

Rendering, pointer interaction and the real worker round trip are covered by
nothing, and no harness is coming
([D001](decisions/D001-web-changes-are-hand-smoke-tested.md),
[E009](explorations/E009-the-hand-verification-bottleneck.md)). **D001 was
amended on 2026-07-25**: an agent runs every check that is cheap — including
diffing the emitted `dist/` across a change meant to preserve behavior, which
is the strongest of them — and a person's pass is no longer a gate on closing a
ticket. What an agent must still not do is drive a browser or build something
to drive one. Recipes are in [context](context.md).

**Docs — just restructured.** This repository adopted the protocol on
2026-07-25. The reviews under the old `docs/findings/` are now
`docs/explorations/E001`–`E006`, moved unedited except for link repair, and
`specs/` is now `spec/`. Every spec requirement carries a permanent id
([T005](tickets/T005-spec-requirement-ids.md)) — `MAP-003`, `ANL-008` — and
every live citation names one. Section numbers survive only in the
explorations and in closed tickets, which are dated records.

**Three ticket numbers were issued twice and were repaired on 2026-07-31.**
`T010` named two tickets and `T016` named three; the later files are now `T017`,
`T018` and `T019`. Citations in the repository were swept, git commit messages
were not, and the translation table is in
[README](README.md#a-note-on-the-identifier-spaces). Before issuing a number,
run the duplicate check there — with the long `--no-filename` flag, because
`rg -h` is ripgrep's help and makes the check pass no matter what.
[D006](decisions/D006-a-duplicated-identifier-is-repaired-by-renumbering.md) is
the rule.

**Layout — `src/` in, `dist/` out.** Everything hand-written lives under
`src/`, everything generated under `dist/`, and `dist/` is what `./serve.py`
serves. `./build.sh` builds all of it and refuses to emit anything if the types
do not check; `./build.sh web` skips cargo. **What you are looking at in the
browser is compiled output, not the file you edited** — source maps make that
survivable, a stale `dist/` is the new way to be confused.

## Next

**The filter language is Python-shaped and the redesign is done.** E019's three
tickets all closed: [T041](tickets/T041-lower-the-filter-to-a-typed-plan.md)
lowered the evaluator, [T042](tickets/T042-the-filter-language-is-python-shaped.md)
cut the surface over, and [T043](tickets/T043-filter-syntax-highlighting.md)
gave the editor highlighting.

**Asking for a feature works end to end** ([T047](tickets/T047-ask-for-a-feature.md)):
button → service → `/admin`. What a person has to look at is the form's own
layout and the send path in a browser — the outcomes are unit-tested and the
routes were driven with `curl` against the container, but no automated check
presses the button (D001).

**T058 is in flight:** add render-free allocation detail and ephemeral bounded
filter queries to the server's native read surface. Canonical revisioned
analysis and synchronization follow as their own slice. The browser still owns
all rendering. The older backlog is
[T045](tickets/T045-lower-integer-arithmetic-to-a-narrow-path.md) and
[T046](tickets/T046-negative-numbers-are-writable.md) — both came out of that
work, neither is urgent — plus T009, T030, and the blocked T004.

**Browser checks are outstanding and are a person's**, because
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md) says an agent must
not drive a browser. E010's performance gates are stated in release WASM and
T041 measured native, where the margin is 60×. And the filter editor's
highlight overlay has to sit exactly under the textarea's own text at every
zoom and wrap point; if the module fails to load the panel falls back to plain
text, so the failure mode is visible rather than silent. T050 additionally
needs its connection string pasted into the actual HTTPS deployment in current
Chrome (both granting and denying Apps on device), Firefox and Safari; the UI
already distinguishes permission denial where the browser exposes it from an
otherwise blocked or absent endpoint.

**[T046](tickets/T046-negative-numbers-are-writable.md) is worth knowing about
before writing a filter**: the language has no unary minus, in any version of
the grammar, so a negative custom field value gets a one-click predicate that
will not compile. `0 - 5` is the workaround.

[E016](explorations/E016-what-to-build-next.md) is still the standing list of
what is not queued and why. What remains on it is T009, an exploration for
undo/redo, and an exploration for multiple open traces.

**How work is written here changed on 2026-08-01.**
[D007](decisions/D007-prose-serves-the-code.md) binds: one record per finished
ticket (the commit body), ticket bodies default to `Outcome` and `Done when`,
this file is not a changelog, and one ticket per deliverable. The reasoning and
the measurements are [E018](explorations/E018-the-protocol-costs-too-much-prose.md);
friction with `PROTOCOL.md` itself goes in
[E017](explorations/E017-protocol-friction.md) as dated entries.

## Not being done, deliberately

- **F9** — JSON strings on the per-frame boundary. Reassessed and not worth it;
  the reasoning is in [E004](explorations/E004-engine-soundness.md#f9).
- **Undo/redo over analysis data** and **multiple open traces** — real features
  with user value, not side effects of a refactor. Neither has a ticket; each
  needs its own exploration first. The second is also a prerequisite question
  for T004. See [E007 §6](explorations/E007-web-architecture-direction.md).
- **Custom events on the timelines and on the map, and pinnable Event
  windows.** `E` records are listed and inspectable, and that was the whole
  ticket ([T036](tickets/T036-custom-events.md) names both as non-goals).
  Drawing a landmark on the two strips is a layout question of its own; pinning
  would mean extending machinery that is keyed to creator event indexes and
  persisted per allocation.
- **Browser automation, a boot harness, and a module-graph check.**
  [D001](decisions/D001-web-changes-are-hand-smoke-tested.md), and
  [E009](explorations/E009-the-hand-verification-bottleneck.md) for why the
  cheap end of it was declined too. The bar is a failure that actually
  happened, not one that could — and "it is only forty lines" is not evidence
  that it is needed. D001's amendment is about running what exists, not about
  writing this.

<!-- generated:begin -->
## Doing
- [T058](tickets/T058-allocation-detail-and-filter-query.md) — allocation detail and ephemeral filter query
<!-- generated:end -->
