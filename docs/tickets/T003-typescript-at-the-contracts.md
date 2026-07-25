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

Adoption order, by where an untyped contract actually costs: the worker
protocol first (a typo there is a silent no-op today), then the persisted
shapes, then the panel records from T002.

**This reverses a documented decision.** [TOOL-002](../../spec/10-tooling.md#tool-002-build) records the
zero-JS-build stance — *"no bundler, no npm"* — as intentional. That spec text
must change in the same commit, saying what the stance was traded for. Leaving
the spec contradicted by the tree is not an option.

## Done when

- [ ] The worker message protocol has one type definition both sides check
      against, and a wrong message name fails the check rather than silently
      doing nothing.
- [ ] Session and `.heapa` shapes are typed, and runtime validation of files off
      disk is still present — types do not replace it.
- [ ] A single documented command builds `web/` from source to the served
      output, and `README.md` and `docs/context.md` give it.
- [ ] `node --test 'web/**/*.test.js'` and `cargo test` pass.
- [ ] [TOOL-002](../../spec/10-tooling.md#tool-002-build) states the build step and why the
      zero-toolchain stance was traded away.
- [ ] The full smoke checklist passes against the built output, not the source.

## Non-goals

- A bundler, a framework, or npm runtime dependencies.
- Typing all of `web/`. This ticket types contracts, not implementations.
