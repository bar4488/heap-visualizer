# Now

_Updated: 2026-08-01._

**No count in this file is written by hand.** Test counts, module sizes and
requirement totals are derivable, and the ones that used to be here had all
drifted — two of them disagreed with each other about the same crate. Run the
command instead; [context](context.md#test) lists them, and
[T022](tickets/T022-docs-cite-commands-not-counts.md) is why.

A heap allocation visualizer: a `.heapl` JSONL trace of malloc/free/realloc
events on an address-line map with two coordinated timelines and full time
travel, plus an analysis layer (tags, names, colors, marks) saved to `.heapa`.
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

## State

**Rust core (`src/core/`) — healthy; filter syntax is a separate
crate and evaluation is integrated.** The engine has clean module boundaries
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
stack methods. Its attached completion list follows the complete grammar
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
Filter panel lists the trace's whole field catalog. `python3 gen.py --fields`
makes a trace carrying some.

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

**Nothing is in flight.**

[T026](tickets/T026-custom-field-catalog.md) through
[T029](tickets/T029-custom-fields-in-the-ui.md) closed the custom-fields and
`named()` batch on 2026-08-01 — [E016](explorations/E016-what-to-build-next.md)
candidate A, plus a UI half E016 had not anticipated. Grounding corrected two
of that document's estimates, and both are worth knowing:

- **E010 asserts the core collects a catalog of custom field names and types at
  parse time. It never did.** `store.extras` held raw JSON object-body
  fragments and nothing in the core read them, so the catalog was its own
  ticket rather than something the evaluator could assume.
- **Allocation names had never reached the core at all.** `worker.ts` called
  `hp_set_names` behind a `typeof` guard for an export that existed nowhere in
  `src/core/`, so every rename since the feature shipped was a silent no-op as
  far as the engine was concerned. The export exists now, and a test pins the
  wire shape so the two ends cannot drift again.

Values resolve **once per distinct interned extras fragment**, never per event:
records carrying identical custom keys share one interned copy, and a filter
reads each referenced key out of each copy in a single scan before the creator
loop starts. That is a spec'd constraint in ANL-010, not an implementation
detail.

Two smaller things came out of it. `receiver_before_dot` in the filter-dsl
crate could only ever see one token, which is why `site.contains` completed and
`named("x").` produced nothing; it now walks back over a balanced parenthesis.
And `gen.py` gained `--fields`, because no trace in the repository carried any
— off by default, and output without it is byte-identical to before.

A review of the merged batch on 2026-07-31 found five
defects, all in the repository's own record-keeping rather than in the product,
and all five closed the same day:

- **[T020](tickets/T020-repair-duplicate-identifiers.md)** — `T010` named two
  tickets and `T016` named three. Renumbered under
  [D006](decisions/D006-a-duplicated-identifier-is-repaired-by-renumbering.md).
- **[T021](tickets/T021-live-docs-drop-npx-tsc.md)** — four live files still
  told a reader to run `npx tsc`, which T018 had shown does not run the
  compiler in a checkout without `npm install`.
- **[T022](tickets/T022-docs-cite-commands-not-counts.md)** — every
  hand-written count in `now.md` and `context.md` had drifted. They are gone,
  not corrected.
- **[T023](tickets/T023-reground-e014-and-e015.md)** — E014 was describing a
  filter language T016 deleted four days after it was written.
- **[T024](tickets/T024-guide-renderer-tests.md)** — the guide's markdown
  renderer shipped with no assertion on it.

None of the five was found by a suite, and none could have been: they are all
claims in prose that stopped being true. The one mechanical check that came out
of it is the duplicate-id query in
[README](README.md#a-note-on-the-identifier-spaces), which is a query rather
than a validator because `PROTOCOL.md` wants two recorded failures before a
mechanism, and there is now exactly one recorded pair.

[T016](tickets/T016-tags-is-a-string-set.md) closed on
2026-07-29. One note about how it closed, because it is unusual: the agent that
wrote it could not run `node` at all, so `cargo test` is the only suite it saw
pass. The web suite, `tsc` and `./build.sh web` were run by a person and
reported passing, and the ticket closed on that report.

[T017](tickets/T017-default-docked-layout.md) closed
on 2026-07-25. A trace with no saved session now starts with Events open in the
left drawer and Layout, Appearance, Filter and Marks open in the right; Play,
Warnings and Allocation remain floating and closed. Each populated drawer can
collapse to a narrow rail without closing or undocking its windows, and that
state persists with the rest of the per-trace layout. A saved layout replaces
the default wholly.

The data shape, persistence, override, build and served output are verified.
Per D001, the rendered rail geometry and pointer interaction were not driven
in a browser; those remain the part a person's ordinary use can inspect.

[T010](tickets/T010-standalone-filter-dsl-parser.md) established the first
filter-language slice as a separate crate. Type checking, the evaluator, the
expression editor, and contextual completion connect it to the core and web UI,
and T026–T029 finished the two surfaces it had left.

[T011](tickets/T011-legend-chips-toggle-filter.md) through
[T014](tickets/T014-filter-to-tag.md) closed the filter-action batch: legend
toggles, replace-and-apply match range, saved filters in marks, and a snapshot
of current matches into a tag. All cheap checks pass; as before, real pointer
interaction and the worker/browser round trip are not automated.

[T015](tickets/T015-overlapping-tags.md) fixed the first filter-to-tag defect:
allocations now carry real overlapping memberships, so snapshotting matches
selected by tag `a` into tag `b` preserves both groups. Counts, filters,
`.heapa` persistence, the allocation panel, and segmented map stripes all use
the complete membership set.

[T016](tickets/T016-tags-is-a-string-set.md) fixed the second one, in the
language rather than the engine. The scalar `tag`, whose `==` secretly meant
"any membership satisfies this", is gone; `tags` is a set field with exact
equality, a `contains` operator for one member, and `tags == {}` for untagged.
`Value::Strings` and its equality/ordering/string-method overloads are gone with
it, `is missing` now requires an optional operand instead of answering a
constant, and the session's persisted filter is language version 2 — a
version-1 source is read back as no filter rather than restored broken. Saved
filters in a `.heapa` file carry no version, so an old `tag == "x"` there
reports a diagnostic when set; nothing migrates it. The rule is
[ANL-009](../spec/07-analysis.md#anl-009-filtering-by-tag).

[E014](explorations/E014-overlapping-tags-cost-model.md) recorded the resulting
cost model and semantics and is **settled: nothing was selected.** The current
tag-indexed bitsets are compact for a few
tags, but inverse event-to-tags scans reach count refresh, timeline index
rebuilds, export, and rendering. It proposes
measurement and separable optimizations; none is queued, and none should be
until a trace someone actually opens is slow. Its DSL sections describe the
pre-T016 scalar `tag` and carry a dated correction saying so — the engine
sections stand unmeasured.

**The guide drawer is complete.**
[E015](explorations/E015-interactive-tutorial.md) settled, over three steers,
what it is: a reference-density technical guide authored as plain markdown,
living in **its own drawer** at the left edge of the workspace — outside the
panel system, free to look unlike a panel — whose prose can highlight and drive
the real UI. [T019](tickets/T019-guide-drawer-prototype.md) is the prototype and
[SHELL-009](../spec/09-ui-shell.md#shell-009-the-guide-surface) is the rule it
must not break: the guide reaches app state **only** by driving real controls,
never by posting to the worker or touching shared state. What is still open —
what persists, how wide the action vocabulary goes, how much content there is —
E015 lists, to be answered from using it; that file stays `open` deliberately,
and was re-grounded on 2026-07-31 against what actually shipped. The prototype
ships five markdown
sections and five focused scenario traces; its build, automated checks, and
browser interaction have been verified. Its markdown renderer is now covered by
the web suite ([T024](tickets/T024-guide-renderer-tests.md)), including a check
that every `#show:`/`#do:`/`#set:` id in a page exists in `index.html` and that
every scenario link resolves — the class of bug T019's third pass had to find
by hand.

**[T009](tickets/T009-type-the-deps-contracts.md) is next after it, and is not
urgent.**
It types the `init*(deps)` contracts in
`analysis.ts`, `session.ts` and `events-panel.ts` — today a comment above each
`init*` and a `let d = null` under it. That one pattern is the largest single
cause under each of the two type-checking flags that are still off; what is left
underneath is deliberately not planned yet, per
[D005](decisions/D005-strictness-is-per-flag.md), which carries the measured
counts.

Why the language changed at all is
[D004](decisions/D004-typescript-is-the-language-for-web.md); the argument that
got there, including the position that lost, is
[E008](explorations/E008-typescript-and-the-build-boundary.md).

[T004](tickets/T004-shell-host.md) is blocked on a second domain existing and
must stay blocked — see [D002](decisions/D002-shell-split-before-host.md).

**Nothing else is queued, and that is the correct state.** T009 and the blocked
T004 are the whole of the backlog.
[E016](explorations/E016-what-to-build-next.md) collects the candidates that are
named around the repository but not queued, with what is actually known about
each and a proposed order. **It binds nothing.** Its candidate A is now done;
what it still lists is T009, an exploration for undo/redo, an exploration for
multiple open traces, and two candidates it argues should stay untouched —
E015's guide questions, which answer themselves from use, and E014's costs,
which want a measurement nobody has needed to take.
[E009](explorations/E009-the-hand-verification-bottleneck.md) asked whether the
verification pass should be partly mechanized, and settled at no: the changes
it was written against worked first try, so the risk never showed up. No
tooling came out of it, and the later D001 amendment did not change that — it
moved who runs the checks that already exist, not whether new ones get built.

## Not being done, deliberately

- **F9** — JSON strings on the per-frame boundary. Reassessed and not worth it;
  the reasoning is in [E004](explorations/E004-engine-soundness.md#f9).
- **Undo/redo over analysis data** and **multiple open traces** — real features
  with user value, not side effects of a refactor. Neither has a ticket; each
  needs its own exploration first. The second is also a prerequisite question
  for T004. See [E007 §6](explorations/E007-web-architecture-direction.md).
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
