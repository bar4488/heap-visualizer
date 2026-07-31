---
id: T020
title: Every ticket identifier names exactly one ticket
status: done
updated: 2026-07-31
---

# T020: Every Ticket Identifier Names Exactly One Ticket

## Context

`T010` was issued twice and `T016` three times. Both collisions reached
`docs/now.md`, which carries two links labelled `[T010]` and two labelled
`[T016]` resolving to different files, and `src/web/guide.ts` and
`src/web/session.ts` both cite a bare `T016` meaning different tickets.

The repair rule, and why renumbering rather than living with it, is
[D006](../decisions/D006-a-duplicated-identifier-is-repaired-by-renumbering.md).
Creation order from `git log --diff-filter=A` decides which file keeps the
number:

| Keeps | Renumbered to | File |
|---|---|---|
| `T010` | — | `T010-standalone-filter-dsl-parser.md` (2026-07-25 16:04) |
| — | `T017` | `T010-default-docked-layout.md` (2026-07-25 16:27) |
| `T016` | — | `T016-tags-is-a-string-set.md` (2026-07-29 23:52) |
| — | `T018` | `T016-build-resolves-local-tsc.md` (2026-07-29 23:55) |
| — | `T019` | `T016-guide-drawer-prototype.md` (2026-07-30 09:38) |

## Outcome

No two ticket files share an `id`, every citation in the repository resolves to
the ticket its author meant, and `README` carries the old-number-to-new-number
translation.

## Done when

- [x] `rg --no-filename '^id: T' docs/tickets | sort | uniq -d` returns nothing.
      Note the long flag: `rg -h` is ripgrep's help, and the short form
      silently turns this check into a no-op that always looks clean.
- [x] For every renumbered file, the `id`, the filename, and the `# T0NN:`
      heading all carry the new number.
- [x] No citation of `T010` or `T016` anywhere in `docs/`, `spec/` or `src/`
      refers to a renumbered ticket. Both remaining ones are the files in the
      "Keeps" column.
- [x] `docs/README.md` §"A note on the identifier spaces" states the three
      translations and links D006.
- [x] `node --test 'src/web/**/*.test.ts'`, both `cargo test` suites and
      `./build.sh web` pass — the source citations are in comments, so this
      establishes only that the sweep broke nothing.

## Non-goals

- Rewriting git history. Commit messages keep saying `T016`; the translation
  table is how they are read (D006).
- Any automated uniqueness check. The failure has happened twice and is now
  repaired; a validator needs its own two instances (`PROTOCOL.md`, "Adding a
  rule").
- Touching anything in a closed artifact other than the identifier inside a
  citation.

## Result

Three files renamed with `git mv` and their `id` and heading updated:
`T010-default-docked-layout` → **T017**, `T016-build-resolves-local-tsc` →
**T018**, `T016-guide-drawer-prototype` → **T019**.

Five citations repaired: two in `docs/now.md`, two in
`docs/explorations/E015-interactive-tutorial.md`, and one comment in
`src/web/guide.ts`. The citations that were already correct — `T016` in
`src/web/session.ts`, `src/web/test/session.test.ts` and
`E012-filter-completion-matrix.md`, `T010` in
`E010-filter-expression-language.md` — were left alone after checking each
resolved to the file in the "Keeps" column.

`rg --no-filename '^id: T' docs/tickets | sort | uniq -d` is empty and the
space is T001–T025 with no gaps. The `E` and `D` spaces were checked at the
same time and were already clean. A link sweep over `docs/` and `spec/` found
no dangling relative link.

**One thing worth recording, because it nearly hid the defect it was meant to
find.** The duplicate check was first run as `rg -h '^id: T' …`, and `-h` is
ripgrep's *help* flag — the command printed usage, `uniq -d` found nothing in
it, and the check reported clean while three duplicates were still on disk. The
long form is now written into the done-when, into `README`, and into D006.

`node --test 'src/web/**/*.test.ts'`, both `cargo test` suites, both `tsc`
configs and `./build.sh web` pass.
