---
id: T003
title: TypeScript over the worker protocol and the persisted shapes
status: todo
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

- [ ] The worker message protocol has one type definition both sides check
      against, and a wrong message name fails the check rather than silently
      doing nothing.
- [ ] Session and `.heapa` shapes are typed, and runtime validation of files off
      disk is still present — types do not replace it.
- [ ] `./build.sh` compiles `src/web/` into `dist/` as ordinary browser ES
      modules with source maps, and `README.md` and `docs/context.md` give the
      command.
- [ ] A type error fails the build rather than emitting silently.
- [ ] `node --test` and `cargo test` pass, and the JS suite still runs with no
      npm install.
- [ ] [TOOL-002](../../spec/10-tooling.md#tool-002-build) states the build step
      and why the zero-toolchain stance was traded away, and
      [TOOL-003](../../spec/10-tooling.md#tool-003-tests) matches how the tests
      are actually run.
- [ ] A person confirms the built output loads and behaves, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) — the
      served tree is now a build artifact, so this is the check that matters.

## Non-goals

- A bundler, a framework, or npm runtime dependencies. `typescript` is the only
  dev dependency.
- Typing all of `src/web/`. This ticket types contracts, not implementations —
  the rest is [T008](T008-convert-web-to-typescript.md).
- A watch mode. See [E008](../explorations/E008-typescript-and-the-build-boundary.md)'s
  open questions.
