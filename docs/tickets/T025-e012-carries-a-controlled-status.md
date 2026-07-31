---
id: T025
title: E012 carries a controlled status value
status: done
updated: 2026-07-31
---

# T025: E012 Carries a Controlled Status Value

## Context

Found while closing [T023](T023-reground-e014-and-e015.md).
`docs/explorations/E012-filter-completion-matrix.md` carries `status: complete`.
`PROTOCOL.md` defines exactly two values for an exploration, `open` and
`settled`, and both of the documented queries —

```sh
rg '^status: open$' docs/explorations
rg '^status: settled$' docs/explorations
```

— miss the file entirely. An exploration invisible to the query that lists
unresolved work is indistinguishable from one that does not exist, which is the
same failure mode as the duplicated identifiers in T020: a convention that
holds everywhere except in one file, silently.

E012 is substantively finished. It already carries a dated correction from
2026-07-29 recording that T016 replaced the scalar `tag`, so the only thing
wrong is the frontmatter value and the missing section the value implies.

## Outcome

`rg --no-filename '^status:' docs/explorations | sort -u` returns `open` and
`settled` and nothing else, and E012 has the `## Outcome` section a settled
exploration is required to carry.

## Done when

- [x] E012's status is `settled`.
- [x] E012 has an `## Outcome` section saying what was decided, placed before
      the 2026-07-29 correction so the correction stays last.
- [x] `rg --no-filename '^status:' docs/explorations | sort -u` lists only
      `status: open` and `status: settled`.
- [x] The same check over `docs/tickets` lists only `todo`, `doing`, `done`.

## Non-goals

- Any other edit to E012. Its matrix, its ranking and its correction are a
  dated record and stay as written.
- A validator over frontmatter values. Two instances of a bad value have now
  been recorded (this and the T020 pair), but they are different fields and
  different failures; a mechanism needs two of the *same* one.

## Result

E012 is `settled` with an Outcome recording that the matrix was implemented and
where. Both status queries now return every exploration, and the ticket status
space was checked at the same time and was already clean.
