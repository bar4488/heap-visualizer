---
id: T003
title: TypeScript over the worker protocol and the persisted shapes
status: doing
updated: 2026-07-25
---

# T003: TypeScript Over the Worker Protocol and the Persisted Shapes

## Outcome

The `main.js` ↔ `worker.js` message protocol and the two persisted shapes
(session, `.heapa`) are described by checked types. The shipped runtime is
unchanged: plain ES modules, no bundler, no framework.

## Context

Stage 3 of [E007](../explorations/E007-web-architecture-direction.md#stage-3--typescript-at-the-contracts).
Gated on the split, which is done, and on [T001](T001-namespace-heap-session-state.md)
and [T002](T002-panel-content-as-data.md), which settle the shapes worth typing.
It is also gated on [T007](T007-src-dist-layout.md), which puts the sources
where the compiler can emit past them.

Adoption order, by where an untyped contract actually costs: the worker
protocol first (a typo there is a silent no-op today), then the persisted
shapes, then the panel records from T002. The modules that carry no contract
keep compiling as JavaScript under `allowJs` until
[T008](T008-convert-web-to-typescript.md).

**This reverses a documented decision.**
[TOOL-002](../../spec/10-tooling.md#tool-002-build) records the zero-JS-build
stance — *"no bundler, no npm"* — as intentional. That spec text must change in
the same commit, saying what the stance was traded for. Leaving the spec
contradicted by the tree is not an option. The reversal itself, the shape it
takes, and what would reverse it back are
[D004](../decisions/D004-typescript-is-the-language-for-web.md); the session
that argued it out is
[E008](../explorations/E008-typescript-and-the-build-boundary.md).

## Done when

- [x] The worker message protocol has one type definition both sides check
      against, and a wrong message name fails the check rather than silently
      doing nothing.
- [x] Session and `.heapa` shapes are typed, and runtime validation of files off
      disk is still present — types do not replace it.
- [x] `./build.sh` compiles `src/web/` into `dist/` as ordinary browser ES
      modules with source maps, and `README.md` and `docs/context.md` give the
      command.
- [x] A type error fails the build rather than emitting silently.
- [x] `node --test` and `cargo test` pass, and the JS suite still runs with no
      npm install.
- [x] [TOOL-002](../../spec/10-tooling.md#tool-002-build) states the build step
      and why the zero-toolchain stance was traded away, and
      [TOOL-003](../../spec/10-tooling.md#tool-003-tests) matches how the tests
      are actually run.
- [ ] A person confirms the built output loads and behaves, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) — the
      served tree is now a build artifact, so this is the check that matters.
      **This is the only item outstanding** — see Handoff.

## Non-goals

- A bundler, a framework, or npm runtime dependencies. `typescript` is the only
  dev dependency.
- Typing all of `src/web/`. This ticket types contracts, not implementations —
  the rest is [T008](T008-convert-web-to-typescript.md).
- A watch mode. See [E008](../explorations/E008-typescript-and-the-build-boundary.md)'s
  open questions.

## Work log

**How the tests kept running without an install step.** Node 24 strips types
from `.ts` files itself, so `node --test 'src/web/**/*.test.ts'` runs the
sources with no build. The catch is that Node resolves the specifier it is
given: a test importing `'../session.js'` would look for a file that no longer
exists. So sources import each other as `./x.ts`, and `rewriteRelativeImportExtensions`
rewrites those to `./x.js` in the emit. One property preserved — tests need
nothing installed — at the cost of an import style that looks wrong until you
know why.

**What got converted, and what did not.** Everything but `main.js`: `fmt`,
`rpc`, `session`, `worker`, all of `shell/` and `heap/`, and the tests.
`main.js` stays JavaScript *and is type-checked* (`checkJs`), which is what
makes the protocol claim true from both ends — 89 `postMessage` sites are
checked against the same union the worker's `onmessage` switch narrows.

**The DOM is typed loosely, on purpose.** `$()` returns `any`. Typing it as
`HTMLElement` turns every `$('row-bytes').value` into an error to be silenced
with a cast, which would have buried the contract types this pass exists to
add under a few hundred casts. `shell/dom.ts` says so at the top, and T008
owns tightening it.

Three helpers absorbed the DOM query patterns rather than casting at each site:
`$$` (all matches, as an array), `$1` (first match), and the existing `$`. That
replaced 28 `querySelectorAll` call sites mechanically.

**What the types found immediately**, before any of them was aimed at anything:

- `queryTlHover(kind, e.clientX - r.left, e.clientY)` passed three arguments to
  a two-parameter function. The third was dead — tooltip positioning comes from
  the mouse tracker, as the comment right there says — so it silently did
  nothing. Removed.
- `applyMarks(obj)` was called in two places without its `quiet` argument, one
  of them a test.
- The worker's `S` state object grew `lastVirtualH` and `lastMoveLink` by
  assignment at three call sites, never declared. Now declared where the rest
  of the state is.
- The test stand-in for the worker replied with `{ reqId, tags }` — no `type`.
  Real replies carry one; the fixture was lying about the protocol and the
  types said so.

**`@types/node` is a second dev dependency.** D004 said `typescript` would be
the only one; the test files import `node:test` and `node:assert`, and
type-checking them needs the declarations. Both are types-only and neither
ships. D004 amended.

## Result

`src/web/protocol.ts` describes the protocol in one place: 30 commands and
queries out, 21 notifications and replies back, plus the settings table as a
mapped type so `{ type: 'set', key, value }` is checked per key. `rpc.ts` pairs
each query with its reply type, so `(await request('alloc-info', { e })).info`
is an `AllocInfo | null` instead of `unknown` — the two `unknown` property
errors in `analysis.ts` were exactly that.

Engine JSON — allocation info, event rows, trace metadata — stays loose and
says why: `src/core/` owns those shapes, and a second copy here would drift.

Proof the check bites, rather than a claim that it does:

```
$ # change one postMessage to { type: 'seekk', seq }
$ npx tsc -p tsconfig.json --noEmit
src/web/main.js(77,41): error TS2820: Type '"seekk"' is not assignable to type
  '"set" | "init" | "load" | ... | "tlhover"'. Did you mean '"seek"'?
$ ./build.sh web; echo $?
1
```

`cargo test` 33, `node --test` 44, both from a clean checkout with no install
step. `npx tsc -p tsconfig.json` and `npx tsc -p tsconfig.test.json` are both
clean, and `build.sh` runs both.

## Handoff

Everything an agent can check is checked. The remaining done-when item is a
person's, and it matters more than usual here: what gets served is now compiled
output rather than the files you edited.

```sh
npm install && ./build.sh && ./serve.py    # http://localhost:8630?trace=demo.heapl
```

What to look at, in rough order of what compilation could plausibly have
broken:

1. The page loads and the map renders — that is the module graph and the
   rewritten import specifiers.
2. Stepping, playback, seeking on both timelines — the protocol round trip.
3. Hover tooltips on the map and on the timeline strips; the timeline tooltip
   in particular, since a dead third argument was removed from its query.
4. Panels open, dock, and restore; a session survives reload; a `.heapa` file
   saves and loads.
5. In devtools, a breakpoint in `main.js` should land on readable source —
   source maps are emitted, and are the reason compiled debugging was judged
   acceptable in D004.

Then check the last box and set `status: done`.
