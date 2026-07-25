# Now

_Updated: 2026-07-25._

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

**Rust core (`src/core/`, ~4.9k lines) — healthy.** Clean module boundaries, 33
native tests asserting real invariants: snapshot seek ≡ forward replay, pick
prefers the newest overlap, anchor stability across reflow. Every performance
and soundness finding from the 2026-07-24 review is fixed.

**Web layer (`src/web/`, ~3.2k lines) — all TypeScript now, split on the
shell/domain seam, no other internal structure yet.** `main.ts` is down from
2,979 lines in one flat scope to ~1,750 lines of trace/worker/toolbar wiring
plus the three coordinated views, and it owns `UIState`, the shared state every
other module takes as `deps.ui`.
`src/web/shell/` (433 lines) is domain-independent and stays that way by
check: `grep -ric heap src/web/shell/` reports 0 for every file.
`src/web/heap/` — analysis, the panel table, the events panel — and the
`src/web/session.ts` boundary module hold the rest.

**Verification — two suites, a type-checker, and a person.** `cargo test` (33)
covers the engine; `node --test 'src/web/**/*.test.ts'` (44) covers the pure
functions, the panel table, and both persisted round-trips, with no npm and no
browser. `tsc` covers what neither reaches: the worker protocol
(`src/web/protocol.ts`, imported by both sides), the persisted shapes, and the
panel records — a message name one side does not know fails the build. How
strict that check is is a named list of flags rather than `strict: true`, ten
on and two off, per [D005](decisions/D005-strictness-is-per-flag.md).

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
`specs/` is now `spec/`. The spec's 61 requirements carry permanent ids
([T005](tickets/T005-spec-requirement-ids.md)) — `MAP-003`, `ANL-008` — and
every live citation names one. Section numbers survive only in the
explorations and in closed tickets, which are dated records.

**Layout — `src/` in, `dist/` out.** Everything hand-written lives under
`src/`, everything generated under `dist/`, and `dist/` is what `./serve.py`
serves. `./build.sh` builds all of it and refuses to emit anything if the types
do not check; `./build.sh web` skips cargo. **What you are looking at in the
browser is compiled output, not the file you edited** — source maps make that
survivable, a stale `dist/` is the new way to be confused.

## Next

**Nothing is in flight.** [T008](tickets/T008-convert-web-to-typescript.md)
closed on 2026-07-25 in one session, having braced for several: `main.js` was
already type-checked in place, so the rename produced 20 errors and no
findings, and the three coordinated views needed nothing. The web layer is
TypeScript end to end.

It also cost D001 an amendment — see Verification above. The ticket's Result
has the evidence that closed it, which is the shape worth copying: a `dist/`
built from the commit before the change, diffed against a `dist/` built after,
with the entire remaining difference enumerated.

**[T009](tickets/T009-type-the-deps-contracts.md) is next, and is not urgent.**
It types the `init*(deps)` contracts in
`analysis.ts`, `session.ts` and `events-panel.ts` — today a comment above each
`init*` and a `let d = null` under it. That one pattern is ~200 of the errors
under each of the two type-checking flags that are still off; what is left
underneath is deliberately not planned yet, per
[D005](decisions/D005-strictness-is-per-flag.md).

Why the language changed at all is
[D004](decisions/D004-typescript-is-the-language-for-web.md); the argument that
got there, including the position that lost, is
[E008](explorations/E008-typescript-and-the-build-boundary.md).

[T004](tickets/T004-shell-host.md) is blocked on a second domain existing and
must stay blocked — see [D002](decisions/D002-shell-split-before-host.md).

**Nothing else is queued, and that is the correct state.**
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
