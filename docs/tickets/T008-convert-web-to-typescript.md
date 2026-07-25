---
id: T008
title: Convert the rest of the web layer to TypeScript
status: done
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

- [x] No `.js` remains under `src/web/`, and `allowJs` is removed from
      `tsconfig.json`.
- [x] The strictness decision is recorded: either `strict: true` over the whole
      layer, or the per-file exemptions with a reason each.
      → [D005](../decisions/D005-strictness-is-per-flag.md): per-flag, ten on,
      two off with counts and [T009](T009-type-the-deps-contracts.md) behind
      them.
- [x] `node --test` and `cargo test` pass, and `./build.sh` emits a `dist/` that
      loads.
- [x] Each slice is verified as far as a cheap check reaches, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) — see
      Result. *(This item read "a person hand-verifies each slice" when the
      ticket was written; D001 was amended mid-ticket, on this ticket's
      evidence.)*

## Work log

**It was two slices, not the several this ticket braced for.** `main.js` was
already type-checked in place under `checkJs`, so the conversion was a rename
plus 20 errors, and none of them was a finding about the code:

- 17 were the `UI` literal's lazily-assigned fields (`worker`, `seek`,
  `drawers`, `fileName`, `detailInfo`, `tlLocalAt`, `detailWasPinned`). They
  are optional in the new `UIState` type, which is what the code already
  assumed. `UIState` is the one thing the conversion added that the comments
  only described.
- `applyMarks(obj, quiet)` is called with one argument. TypeScript treats
  trailing parameters of a `.js` function as optional and a `.ts` one's as
  required, so this was invisible until the rename; `quiet?` says it.
- `parseCollapseMin`'s JSDoc `@returns` was load-bearing — it carried the
  `'rows' | 'bytes'` literal type the `collapseMin` setting requires, and
  dropping it into a plain TS function widened it to `string`. It is a return
  annotation now.

The three coordinated views this ticket expected to be the hard part needed no
changes at all.

**The emitted `dist/` is unchanged**, comments aside, except for one
equivalent rewrite in `worker.ts` (`err && err.message` → `err?.message`,
forced by `useUnknownInCatchVariables`). Verified by diffing the tree built
before the change against the one built after — which is the cheapest evidence
available that a translation was a translation.

**Strictness went per-flag rather than `strict: true`** — the reasoning, the
measurements, and what reverses it are in
[D005](../decisions/D005-strictness-is-per-flag.md). Ten flags were free and
are on; they found four unsafe catch variables and two dead imports. Two flags
are off with roughly 200 errors each attributable to one pattern, which is now
[T009](T009-type-the-deps-contracts.md).

`shell/dom.ts`'s note promising that T008 would tighten `El` was corrected in
place: the looseness stayed, deliberately, and the comment says so.

## Result

Two commits, each independently revertable per
[D003](../decisions/D003-one-slice-per-commit.md): `b32e5d1` the conversion,
`c892602` the strictness flags.

`cargo test` 33, `node --test` 44, `tsc` clean over both configs, `./build.sh
web` emits a `dist/` whose entry points all answer 200.

**The evidence that the translation is a translation is the emit.** The served
tree was built at `f20f427` — the commit before this ticket — and diffed
against the tree built after both slices. Ignoring comments, the whole
difference is:

| File | Difference |
|---|---|
| `main.js` | Import specifiers requoted `'` → `"` (tsc emits them now instead of passing the file through); two dead imports dropped (`request`, `applySession`); the two JSDoc casts erased |
| `worker.js` | `String(err && err.message \|\| err)` → `String(err?.message \|\| err)` |
| everything else | byte-identical |

```sh
git worktree add /tmp/pre f20f427 && (cd /tmp/pre && ./build.sh web)
./build.sh web && diff -r --exclude='*.map' /tmp/pre/dist dist
```

The `worker.js` line is the one behavioral claim in the ticket, forced by
`useUnknownInCatchVariables`, and it holds for every input: for a thrown
`Error` both yield the message; for `null`, `undefined`, `''`, or an object
with an empty `message`, `err && err.message` and `err?.message` are both falsy
and both fall through to `|| err`.

**What that does not cover**, stated rather than implied: nothing here proves a
browser executes the page. The diff proves the emitted program is the same
program. Rendering, pointer gestures and the real worker round trip are
unverified as always, per
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) — and this
ticket changed nothing they touch, which is what the diff establishes.

**D001 was amended over this ticket.** It was written to close with "a person
hand-verifies each slice", and the work sat finished and green waiting on that.
Bar's objection: cheap checks and expensive ones had been on the same side of
the line, so an agent was handing back a smoke checklist instead of running the
`diff` above. The amended decision says an agent runs everything cheap itself
and a person's pass is not a gate. [E009](../explorations/E009-the-hand-verification-bottleneck.md),
which had settled that D001 stood unamended, carries a dated correction. No new
tooling was built, and E009's outcome on that is unchanged.

## Non-goals

- Restructuring anything while translating. A module that is wrong stays wrong
  in TypeScript, and gets its own ticket.
- Typing the shell host API — that is [T004](T004-shell-host.md)'s, and it does
  not exist yet.
