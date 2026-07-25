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

- [x] No `.js` remains under `src/web/`, and `allowJs` is removed from
      `tsconfig.json`.
- [x] The strictness decision is recorded: either `strict: true` over the whole
      layer, or the per-file exemptions with a reason each.
      → [D005](../decisions/D005-strictness-is-per-flag.md): per-flag, ten on,
      two off with counts and [T009](T009-type-the-deps-contracts.md) behind
      them.
- [x] `node --test` and `cargo test` pass, and `./build.sh` emits a `dist/` that
      loads.
- [ ] A person hand-verifies each slice, per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

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

## Handoff

Everything is done and committed except the one thing an agent cannot do: the
hand-verification in the last done-when.

Two commits, each independently revertable, per
[D003](../decisions/D003-one-slice-per-commit.md):

- `b32e5d1` — the conversion. The one with any behavioral risk at all.
- `c892602` — the strictness flags. Config, four catch expressions, two dead
  imports.

```sh
./build.sh web && ./serve.py     # http://localhost:8630?trace=demo.heapl
```

What to check, in the order the risk sits — everything here is `main.ts`'s
code, since that is the file that moved:

1. **The app boots and paints.** Address map, both timeline strips, the status
   line. A blank page or a console error means the module graph broke, which
   is the only way a rename fails.
2. **Playback and stepping.** Play/pause, the step buttons, arrow keys,
   Home/End, and the lock toggle (`l`).
3. **`collapseMin`** — the Layout panel's collapse threshold. Its return type
   was the one annotation that carried meaning, so try all three forms: a bare
   number (rows), `0x2000` (bytes), and `4k` (bytes). An unparseable value
   should turn the input red and change nothing.
4. **Loading a `.heapa` file**, which is the `applyMarks` arity change: save an
   analysis, reload the page, load it back. Then load something that is not a
   marks file and confirm the "not a heap-visualizer marks file" message still
   appears rather than nothing.
5. **The error paths**, which are the four catch rewrites: load a URL that
   404s (`?trace=nope.heapl`) and confirm the status line names the failure
   instead of saying `undefined`.
6. **The allocation panel**: click an allocation, name it, tag it, color it,
   pin it, unpin it. This exercises the largest untouched block in the file.
7. **Search (`g`)**, the jump box, shift-drag selection on a strip, and crop.

If something is wrong, `git revert` the first commit — the second does not
depend on it beyond the two dead imports.

## Non-goals

- Restructuring anything while translating. A module that is wrong stays wrong
  in TypeScript, and gets its own ticket.
- Typing the shell host API — that is [T004](T004-shell-host.md)'s, and it does
  not exist yet.
