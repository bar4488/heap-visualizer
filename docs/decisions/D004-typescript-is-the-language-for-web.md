---
id: D004
title: TypeScript is the language for the web layer, and a build step is accepted
updated: 2026-07-25
---

# D004: TypeScript Is the Language for the Web Layer

## Decision

`web/` is written in TypeScript. `tsc` emits ordinary browser ES modules into a
build output directory, and that output — not the source tree — is what is
served.

The runtime is otherwise unchanged: native HTML, CSS, ES modules, Web Workers,
`OffscreenCanvas`, WASM. No bundler, no framework, no npm packages in anything
that ships. `typescript` is a dev dependency and the only one.

This reverses the zero-JS-build stance recorded in
[TOOL-002](../../spec/10-tooling.md#tool-002-build), which said "no bundler, no
npm" and "`web/` is served as-is". That spec text changes with the code, in the
same commit as the toolchain.

## Why

Types are the only automated checking most of this code will ever get. There is
no browser automation ([D001](D001-web-changes-are-hand-smoke-tested.md)) and
there will not be; the JS suite covers pure functions and the two persisted
round-trips, and stops there by design. A typo in one of the 89 `postMessage`
sites is currently a silent no-op that a person discovers by noticing the app
did nothing.

The destination is a shell hosting several analysis domains
([E007](../explorations/E007-web-architecture-direction.md),
[T004](../tickets/T004-shell-host.md)). A host API is an agreement between
pieces of code that do not know about each other — exactly what types keep
honest and comments do not.

The zero-toolchain stance was worth less than it appeared. `build.sh` already
had to run before a fresh checkout could serve anything, because the wasm is a
build product, and both build products (`heap_visualizer_core.wasm`,
`demo.heapl`) already sat gitignored inside the served tree. What the stance
actually bought was an edit-refresh loop with no watch process, and source maps
make that loop survive compilation.

Checking JavaScript in place instead (`// @ts-check` with JSDoc, `tsc
--noEmit`) was considered and rejected. It gets the same checker with no build
step, but it is a halfway house: the declaration files would be real
TypeScript while every implementation stayed in a syntax that makes generics
and assertions tedious enough that people write fewer types. The cost it avoids
— a compile step in a repo that already compiles Rust — is not worth carrying a
second-class dialect indefinitely.

## What would reverse it

TypeScript stopping being maintainable as a plain `tsc` invocation — a version
that requires a bundler, or a type system change that makes the emit
non-obvious. The measure to watch is whether `build.sh` stays readable in one
screen.

If the emitted output ever needs anything other than "these ES modules, minus
the types", that is a bundler arriving by the back door, and this decision
should be re-argued rather than extended.
