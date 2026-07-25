---
id: T008
title: Convert the rest of the web layer to TypeScript
status: doing
updated: 2026-07-25
---

# T008: Convert the Rest of the Web Layer to TypeScript

## Outcome

Every module under `src/web/` is TypeScript. `allowJs` is off, and the
strictness the contracts are checked at holds over the whole layer — or the
exceptions are named, with a reason each.

## Context

[T003](T003-typescript-at-the-contracts.md) sets up the toolchain and converts
the contract-bearing modules, leaving the rest compiling as JavaScript under
`allowJs`. This ticket finishes the job. The decision that this is where the
web layer is going is [D004](../decisions/D004-typescript-is-the-language-for-web.md);
the sequencing argument is in
[E008](../explorations/E008-typescript-and-the-build-boundary.md).

**Deferred deliberately.** It is the largest remaining body of JS change with
no browser automation behind it, and every slice of it is hand-verified. It
should be picked up when there is appetite for repeated smoke-testing, not
because it is next in a list.

Not one session. `main.js` alone is ~1.7k lines and the three coordinated views
inside it are where the trickiest DOM and coordinate code lives. One slice per
commit, per [D003](../decisions/D003-one-slice-per-commit.md); re-ground this
ticket before starting, since T003 will have moved the ground.

## Done when

- [ ] No `.js` remains under `src/web/`, and `allowJs` is removed from
      `tsconfig.json`.
- [ ] The strictness decision is recorded: either `strict: true` over the whole
      layer, or the per-file exemptions with a reason each.
- [ ] `node --test` and `cargo test` pass, and `./build.sh` emits a `dist/` that
      loads.
- [ ] A person hand-verifies each slice, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

## Non-goals

- Restructuring anything while translating. A module that is wrong stays wrong
  in TypeScript, and gets its own ticket.
- Typing the shell host API — that is [T004](T004-shell-host.md)'s, and it does
  not exist yet.
