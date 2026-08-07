# Now

_Updated: 2026-08-07._

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
dependency-free; its tests cover the E010 grammar, source-spanned AST,
parser limits, and incomplete cursor contexts. The core links it to semantic
checking, contextual completion, and a column-backed evaluator for the first
set of built-in fields and operations.

**Web layer (`src/web/`) — all TypeScript now, split on the
shell/domain seam, no other internal structure yet.** `main.ts` was one flat
scope and is now trace/worker/toolbar wiring
plus the three coordinated views, and it owns `UIState`, the shared state every
other module takes as `deps.ui`.
`src/web/shell/` is domain-independent and stays that way by
check: `grep -ric heap src/web/shell/` reports 0 for every file.
`src/web/heap/` — analysis, the panel table, the events panel — and the
`src/web/session.ts` boundary module hold the rest.
The Filter panel is now the E010 draft/applied expression editor and speaks
the typed check/apply/mode worker protocol. The core exports the first
column-backed evaluator for built-in allocation/death fields, boolean and
numeric/string operations, sets/ranges, overlap, missing tests, and string /
stack methods. **Numbers are integers and floats**, one type to the person
writing a filter, mixing under every numeric operator and comparing exactly —
an integer operand is never widened to a double
([ANL-012](../spec/07-analysis.md#anl-012-numbers-in-the-filter-language),
[T034](tickets/T034-the-filter-language-has-floats.md); E010 sketched the
language as integral-only and carries a note saying so). Its attached completion list follows the complete grammar
position: exact fields advance to operators, right-hand expressions are
filtered to the required type, calls/sets/ranges progress through their
delimiters, and live site/thread/tag values come from that same core catalog.
Tag candidates update on create, rename, delete, and restore, including escaped
labels. Allocations can carry overlapping tags, and the language says so: the
field is the set-typed `tags`, `tags == {"a", "aa"}` is exact set equality,
`tags contains "a"` is membership, `tags == {}` is untagged, and filter-to-tag
adds its snapshot without removing the tags that selected it.
**The E010 language is now complete on the two surfaces that were missing.**
Custom trace fields are filterable — `field.pool`, `field["allocator-class"]`,
`death.field.reason` — checked against a catalog the load pass builds, and
`named("x")` resolves one allocation by its user-given name at check time.
[ANL-010](../spec/07-analysis.md#anl-010-filtering-on-custom-trace-fields) and
[ANL-011](../spec/07-analysis.md#anl-011-filtering-relative-to-a-named-allocation)
are the rules. Both have a UI: an allocation's custom fields are their own
typed section of the allocation panel, each with a one-click predicate, and the
Filter panel lists the trace's whole field catalog — the panel section is
`src/web/heap/custom-fields.ts`, pure and tested. That section covers **both records that describe an allocation** — the
creator's fields and the freeing `F`/`R`'s, merged, the death value winning a
shared key and its row reading `death.field.<key>`
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

**Verification — three suites, a type-checker, and a person.** `cargo test`
covers the engine and the filter parser/completion contexts;
`node --test 'src/web/**/*.test.ts'` covers the pure functions, the panel
table, the guide's markdown renderer, and both persisted round-trips, with no
npm and no browser. `tsc` covers
what those do not reach: the worker protocol
(`src/web/protocol.ts`, imported by both sides), the persisted shapes, and the
panel records — a message name one side does not know fails the build. How
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

**The filter language is being redesigned, and the evaluator with it.**
[E019](explorations/E019-a-python-shaped-filter-language.md) is the design: a
Python-shaped surface (`and`/`or`/`not`, `in` for every membership, `range()`,
`is None`, chained comparison) over three namespaces — `alloc`, `malloc`,
`free` — replacing the flat global field list. Requested on 2026-08-07; the
three conflicts Python cannot express were decided by the user the same day and
E019 records which.

**[T041](tickets/T041-lower-the-filter-to-a-typed-plan.md) is next**, and its
tag prerequisite is done:
[T044](tickets/T044-tag-scans-track-tags-in-use.md) removed the `O(H)`
enumeration that put `tags contains` out of reach of T041's 2×-of-floor bar.
[E020](explorations/E020-tags-cost-tracks-the-highest-tag-id.md) is the
measurement and doubles as the acceptance harness.

**Grounding it found that the evaluator never got the execution model E010
specified** — `filter_eval::eval` walked the AST once per event, 45× above its
floor. [T041](tickets/T041-lower-the-filter-to-a-typed-plan.md) fixed that and
is done: an Apply now compiles to `filter_plan::Pred` and scans 64 events at a
time, and `size >= 4096` over 1M creators went **38.0 ms → 0.40 ms** native.
[D008](decisions/D008-the-filter-evaluator-is-a-lowered-plan.md) is the rule
that keeps it there — a new operator extends the plan, it does not add a case
to a tree walk — and
[E019](explorations/E019-a-python-shaped-filter-language.md#measurement) has
the whole table.

**One check is outstanding and is a person's**: E010's gates are stated in
release WASM and T041 measured native, because driving a browser is what
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md) says an agent must
not do. The margin is 60× on the common shapes, so this is a confirmation
rather than a risk.

Next is [T042](tickets/T042-the-filter-language-is-python-shaped.md), then
[T043](tickets/T043-filter-syntax-highlighting.md). T042 was ordered after the
lowering because namespacing costs a string comparison per event on a tree walk
and nothing at all on a plan. [T045](tickets/T045-lower-integer-arithmetic-to-a-narrow-path.md)
came out of T041's measurements — general integer arithmetic is the one shape
with no specialized leaf — and nothing waits on it.

The rest of the backlog is T009, T030, and the blocked T004.

**[T009](tickets/T009-type-the-deps-contracts.md) is next, and is not urgent.**
It types the `init*(deps)` contracts in `analysis.ts`, `session.ts` and
`events-panel.ts` — today a comment above each `init*` and a `let d = null`
under it, and the largest single cause under each of the two type-checking
flags still off ([D005](decisions/D005-strictness-is-per-flag.md), which
carries the measured counts). Its `updated` is 2026-07-25 and the web layer has
moved since; re-ground it before starting.

**[T030](tickets/T030-v8-frontmatter-conformance.md) is small and mechanical.**
`PROTOCOL.md` moved from version 6 to version 8 on 2026-08-01 and its new
frontmatter table leaves this file and D001–D006 non-conformant. The trap is in
the ticket: on a decision, `created` is not a rename of `updated`, and at least
one of the six carries an amendment date rather than a creation date.

**[T004](tickets/T004-shell-host.md) is blocked and must stay blocked** until a
second domain is concrete — see
[D002](decisions/D002-shell-split-before-host.md).

[E016](explorations/E016-what-to-build-next.md) is the standing list of what is
not queued and why, with a proposed order. It binds nothing. Its candidate A
(the custom-field and `named()` surfaces) closed on 2026-08-01; what remains is
T009, an exploration for undo/redo, an exploration for multiple open traces,
and two candidates it argues should stay untouched. T035 and T036 came from
outside that list, on 2026-08-05.

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

Nothing in flight.
<!-- generated:end -->
