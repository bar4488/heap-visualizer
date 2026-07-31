---
id: D006
title: A duplicated identifier is repaired by renumbering the later file
updated: 2026-07-31
---

# D006: A Duplicated Identifier Is Repaired by Renumbering the Later File

## Context

By 2026-07-30 this repository had issued `T010` twice and `T016` three times.
The protocol forbids both halves of the situation: identifiers are "never
reused, never renumbered". Reuse had already happened, so the repository was
going to violate one of those two clauses whichever way the repair went.

The collisions were not theoretical. `docs/now.md` carried two links labelled
`[T010]` pointing at different files and two labelled `[T016]` pointing at
different files, `rg 'T016'` returned three unrelated tickets, and `src/web/`
comments cited `T016` without saying which one.

## Decision

**When one identifier names two artifacts, the file that was created first
keeps the number and every later file is renumbered to a fresh one.** Creation
order comes from `git log --diff-filter=A`, not from the `updated` field, which
moves.

The renumbering repairs the identifier inside the file, its filename, and every
citation of it anywhere in the repository — including citations inside closed
tickets and settled explorations, which are otherwise not edited.

A repair is recorded twice: here, and as a translation line in
[README](../README.md#a-note-on-the-identifier-spaces) mapping the old number
to the new one.

## Why renumbering, and not living with the collision

"Never renumbered" exists so that a citation written once keeps resolving. A
duplicated identifier defeats that outcome directly: `T016` resolves to three
things, so every citation of it is ambiguous forever and every future one has
to be qualified by filename. Renumbering costs a one-time sweep of citations
and restores the property the rule was protecting.

Applying "never renumbered" to preserve a collision would enforce the letter of
the rule against its own purpose.

## Why closed artifacts are edited here

`PROTOCOL.md` says a closed artifact is a dated record and is not migrated when
a convention changes. That is not what this is. The protocol also says a
citation whose target no longer exists must not be left dangling, and after a
renumbering an unrepaired `T016` link in a closed ticket points at the wrong
ticket — which is worse than dangling, because it resolves and lies.

The edit permitted is **only** the identifier in a citation. No claim, date,
finding, or verification note in a closed artifact is touched.

## Consequences

- Git history still contains commits whose messages say `T016` when they mean
  what is now `T018` or `T019`. Git owns history and is not rewritten; the
  translation table in `README` is how those are read.
- The next identifier to issue is found with
  `rg --no-filename '^id: T' docs/tickets | sort -u | tail -1`, which is also
  the check that would have prevented this. Use the long flag: `rg -h` is
  ripgrep's help output, and the short form makes the check pass silently
  whatever the state of the directory — it did exactly that once while this
  repair was being carried out. Nothing enforces the check automatically, and
  nothing is going to until the failure recurs.

## Recorded instances

1. `T010` issued twice on 2026-07-25 (`T010-standalone-filter-dsl-parser` at
   16:04, `T010-default-docked-layout` at 16:27).
2. `T016` issued three times, on 2026-07-29 (twice) and 2026-07-30.

Both were found on 2026-07-31 by Bar Tzadok reviewing the merged batch, after
the ambiguous links had already been written into `docs/now.md`.
