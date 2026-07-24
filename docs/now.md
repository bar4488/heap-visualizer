# Now

Where the project stands and what to read first. Start here in a new session.

_Last updated: 2026-07-24._

## What this is

A heap allocation visualizer: a `.heapl` JSONL trace of malloc/free/realloc
events rendered on an address-line map with two coordinated timelines and full
time travel, plus an analysis layer (tags, names, colors, marks) saved to
`.heapa`. Rust → WASM core in a Web Worker with OffscreenCanvas; the page is
fully client-side. See [README](../README.md) to build and run.

## Read first

| Read | For |
|---|---|
| [specs/README](../specs/README.md) | The authoritative spec, split into 10 modules. **When behavior and spec disagree, one of them is wrong — fix it in the same change.** |
| [specs/01-overview](../specs/01-overview.md) | Goals in priority order, the three coordinated views, terminology |
| [specs/08-architecture](../specs/08-architecture.md) | The three-layer split and the scaling rules that constrain the engine |
| [docs/findings/2026-07-24/README](findings/2026-07-24/README.md) | Last full code read: 17 findings, 16 fixed, current quality assessment |
| [docs/findings/2026-07-24-2/web-architecture-direction](findings/2026-07-24-2/web-architecture-direction.md) | Where `web/` is going and the staged plan to get there |
| [docs/smoke-checklist](smoke-checklist.md) | The fixed hand-verification script for `web/`, run before each refactor slice |

## State of the code

**Rust core (`core/`, ~4.9k lines): healthy.** Clean module boundaries, 33
native tests asserting real invariants (snapshot seek ≡ forward replay, pick
prefers the newest overlap, anchor stability across reflow). The 2026-07-24
review rated it 8/10; every performance and soundness finding from that pass is
fixed.

**Web layer (`web/`, ~3.9k lines): split on the shell/domain seam.** `main.js`
went from 2,979 lines in one flat scope to 1,707 lines of trace/worker/toolbar
wiring plus the three coordinated views. `web/shell/` (433 lines) is
domain-independent — `grep -r heap web/shell/` comes back empty — and
`web/heap/` plus the `web/session.js` boundary module hold the rest. See
[specs/08.3](../specs/08-architecture.md).

**Verification.** `cargo test` covers the engine. `node --test
'web/**/*.test.js'` covers the JS pure functions and both persisted
round-trips (39 tests, no npm, no browser — see
[specs/10.3](../specs/10-tooling.md)). Rendering and pointer interaction are
still hand-verified: per [no-browser-automation-verify] web changes are
smoke-tested by Bar, not by an agent driving a browser, now to a fixed script
in [docs/smoke-checklist.md](smoke-checklist.md).

## Active work

The direction is a domain-independent shell hosting multiple analysis domains,
heap being the first. More domains are planned; the host itself is deliberately
last. Full reasoning and constraints:
[web-architecture-direction](findings/2026-07-24-2/web-architecture-direction.md).

| Stage | What | Status |
|---|---|---|
| 0 | Buy verification: `node --test` over pure functions + session/`.heapa` round-trips, written smoke checklist | ✅ done |
| 1 | Split `main.js` on the shell/domain seam into `web/shell/` and `web/heap/` — this is [F10](findings/2026-07-24/03-web-structure.md#f10) | ✅ done, less namespacing (below) |
| 2 | Declare panel content as data | ⬜ next |
| 3 | TypeScript at the worker protocol and persisted shapes | ⬜ |
| 4 | The host — only once a second domain is concrete, built alongside it | ⬜ blocked by design |

Stages 0 and 1 were done together rather than in sequence, as a deliberate
call: the whole split was a pure lift-and-shift with **no behavior change**, so
the tests and the move could land against the same shape.

**Carried forward from Stage 1**: domain-owned session fields are *not* yet
namespaced under a `heap` key with a version. That is a change to what gets
written to `localStorage` plus a read path for the old shape — a behavior
change, so it was held back. It is now the cheapest it will ever be to do,
because the session round-trip test exists to check old-shape-in against
new-shape-out. Do it before Stage 2.

Two features are split out as their own proposals rather than riding along with
the refactor: undo/redo over analysis data, and multiple open traces. The
second is also a prerequisite question for Stage 4 (see §5 of the direction
doc).

## Also open

- [F9](findings/2026-07-24/02-engine-soundness.md#f9) — JSON strings on the
  per-frame boundary. Reassessed, not fixed: not worth it yet.

## Conventions worth knowing

- **Specs are authoritative.** Behavior changes update the relevant spec in the
  same commit. This includes reversing documented decisions — Stage 3 reverses
  the zero-JS-build stance in [specs/10.2](../specs/10-tooling.md), and says so
  there.
- **Zero JS toolchain today**: `web/` is served as-is, no bundler, no npm. The
  worker is a `{ type: 'module' }` worker, so plain ES modules work now. The
  test suite keeps this: `node --test` ships with Node and no package is
  installed.
- **No module imports `UI`.** Modules receive what they need via
  `init*(deps)`. This is what makes the persisted shapes testable without a
  browser, and it keeps the coupling written down.
- **`./build.sh`** is the whole build (cargo → wasm → `web/`). `./serve.py` to
  serve, `?trace=demo.heapl` autoloads. `python3 gen.py` generates traces.
- **One commit per finding / per refactor slice**, smoke-tested before the
  next begins.
- `window.__heap_visualizer` exposes `UI` for console poking.

## History

- [findings/2026-07-24/](findings/2026-07-24/README.md) — full code read with
  the render hot path measured; 16 of 17 findings fixed, one commit each
  (`git log 41f4e37..HEAD`).
- [findings/2026-07-23/TASKS.md](findings/2026-07-23/TASKS.md) — the previous
  round, all done; notes record resolutions for the judgement calls.
