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

**Rust core (`core/`, ~4.9k lines) — healthy.** Clean module boundaries, 33
native tests asserting real invariants: snapshot seek ≡ forward replay, pick
prefers the newest overlap, anchor stability across reflow. Every performance
and soundness finding from the 2026-07-24 review is fixed.

**Web layer (`web/`, ~3.2k lines) — split on the shell/domain seam, no other
internal structure yet.** `main.js` is down from 2,979 lines in one flat scope
to 1,707 lines of trace/worker/toolbar wiring plus the three coordinated views.
`web/shell/` (433 lines) is domain-independent and stays that way by check:
`grep -ric heap web/shell/` reports 0 for every file. `web/heap/` and the
`web/session.js` boundary module hold the rest.

**Verification — two suites and a person.** `cargo test` (33) covers the
engine; `node --test 'web/**/*.test.js'` (39) covers the JS pure functions and
both persisted round-trips, with no npm and no browser. Rendering and pointer
interaction are hand-verified, per
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md).

**Docs — just restructured.** This repository adopted the protocol on
2026-07-25. The reviews under the old `docs/findings/` are now
`docs/explorations/E001`–`E006`, moved unedited except for link repair, and
`specs/` is now `spec/`. The spec's 61 requirements carry permanent ids
([T005](tickets/T005-spec-requirement-ids.md)) — `MAP-003`, `ANL-008` — and
every live citation names one. Section numbers survive only in the
explorations and in closed tickets, which are dated records.

## Next

**The web layer is moving to TypeScript, with a real compile step.** That
reverses [TOOL-002](../spec/10-tooling.md#tool-002-build)'s zero-build stance;
the decision is [D004](decisions/D004-typescript-is-the-language-for-web.md) and
the argument that got there is
[E008](explorations/E008-typescript-and-the-build-boundary.md). In order:

1. [T007](tickets/T007-src-dist-layout.md) — sources under `src/`, output under
   `dist/`, web layer still plain JS. The move lands on its own so a break in
   the browser can be blamed on one change, not two.
2. [T003](tickets/T003-typescript-at-the-contracts.md) — the toolchain and the
   contracts: worker protocol, persisted shapes, panel records.
3. [T008](tickets/T008-convert-web-to-typescript.md) — the rest of the
   conversion. **Deferred on purpose**: it is the largest body of hand-verified
   JS change left, and it should be picked up when there is appetite for
   repeated smoke-testing.

[T004](tickets/T004-shell-host.md) is blocked on a second domain existing and
must stay blocked — see [D002](decisions/D002-shell-split-before-host.md).

## Not being done, deliberately

- **F9** — JSON strings on the per-frame boundary. Reassessed and not worth it;
  the reasoning is in [E004](explorations/E004-engine-soundness.md#f9).
- **Undo/redo over analysis data** and **multiple open traces** — real features
  with user value, not side effects of a refactor. Neither has a ticket; each
  needs its own exploration first. The second is also a prerequisite question
  for T004. See [E007 §6](explorations/E007-web-architecture-direction.md).
- **Browser automation.** D001.

<!-- generated:begin -->
## Doing
- [T001](tickets/T001-namespace-heap-session-state.md) — namespace and version
  the heap-owned fields in the persisted session
- [T002](tickets/T002-panel-content-as-data.md) — declare panel content as data
  instead of a hand-maintained id list
<!-- generated:end -->
