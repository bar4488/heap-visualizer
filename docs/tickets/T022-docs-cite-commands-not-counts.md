---
id: T022
title: Docs cite the command, not the count
status: done
updated: 2026-07-31
---

# T022: Docs Cite the Command, Not the Count

## Context

`docs/now.md` and `docs/context.md` state test counts, module line counts, and
a spec requirement count in prose. Every one of them is derivable, hand-written,
and now wrong — which is the failure `PROTOCOL.md` names as "a derivable fact
maintained by hand".

Measured 2026-07-31:

| Claim | Where | Actual |
|---|---|---|
| 40 core tests | `now.md:68`, `context.md:43` | 42 |
| 41 native tests | `now.md:26` | 42 core + 24 dsl |
| 23 dsl tests | `now.md:30`, `now.md:68`, `context.md:44` | 24 |
| 56 web tests | `now.md:69`, `context.md:45` | 60 |
| core ~5.3k lines | `now.md:24` | — |
| core ~4.9k lines | `context.md:102` | — |

The last two are the clearest evidence that the numbers are not maintained:
they describe the same crate and disagree with each other.

## Outcome

Neither file states a number a command could produce. A reader who wants the
count is given the command that prints it, and prose describes what a suite
covers rather than how many assertions it makes.

## Done when

- [x] `rg -n '\b(4[0-9]|5[0-9]|6[0-9]) (tests|engine|web|DSL)' docs/now.md
      docs/context.md` returns nothing.
- [x] No line-count claim (`~5.3k lines`, `433 lines`, `~1,750 lines`,
      `~4.9k lines`, `2,979 lines`) survives in `now.md` or `context.md` except
      where it is a historical comparison making a point, and any that survives
      says the date it was measured.
- [x] The spec requirement count in `now.md:90` is gone; the sentence makes the
      point about ids without counting them.
- [x] `context.md`'s test section still tells a reader what each suite covers
      and what it deliberately does not — losing the numbers must not lose that.
- [x] The three suites and `./build.sh web` still pass, and no source file was
      touched.

## Non-goals

- A generated block that a script rewrites with current counts. The counts are
  not load-bearing — nothing reads them, and no decision turns on them — so the
  cheaper repair is to stop asserting them. A generator would be a mechanism
  with no recorded failure behind it.
- The `<!-- generated:begin -->` queue block in `now.md`, which stays as it is.
- Closed tickets and explorations, which record what was true when written.

## Result

Every hand-written count is gone from `docs/now.md` and `docs/context.md`: the
three suite counts, the four module line counts, and the spec requirement
total. Prose now says what a suite covers; `context.md`'s Test block lists the
command beside each description, and `now.md` opens with a line saying no count
in it is hand-written and pointing at those commands.

The counts as found on 2026-07-31, for the record only — they are not written
anywhere now: core 42, filter-dsl 24, web 60 before this session's tests and 75
after.

Nothing under `src/` was touched by this ticket. All three suites, both `tsc`
configs and `./build.sh web` pass.
