---
id: E016
title: What to build next — the unqueued candidates, and an order for them
status: open
updated: 2026-07-31
---

# E016: What to Build Next

## Summary

The backlog is two tickets — [T009](../tickets/T009-type-the-deps-contracts.md)
and the deliberately blocked [T004](../tickets/T004-shell-host.md) — and
`now.md` calls that "the correct state". It is, in the sense that nothing is
half-finished. It is not a plan.

Meanwhile five candidate bodies of work are named across the repository, none
of them queued, each in a different state of readiness. This file collects
them in one place, says what is actually known about each, and proposes an
order. **It binds nothing.** No ticket exists because of this document; the
`## Proposed order` section is a suggestion, and the sections above it are the
evidence it is drawn from.

## Why it matters

The five are scattered — one in a settled exploration's §6, two in another
exploration's Outcome, one implied by a diagnostic string in the evaluator.
Reading `now.md` tells you nothing is in flight; it does not tell you what the
candidates are or which is cheapest. That gap is the whole reason for this
file. When the next session starts, the choice should be made by reading one
document, not by reassembling it.

The second reason is ordering. Two of the five are large user-facing features
that [E007 §5](E007-web-architecture-direction.md) says must be decided as
features rather than arrive as side effects of a refactor, and one of them —
multiple open traces — is a prerequisite question for T004. Deciding them in
the wrong order means designing the host against a guess, which
[D002](../decisions/D002-shell-split-before-host.md) exists to prevent.

## The candidates

### A — Finish the E010 filter language: `named()` and `field.*`

**Evidence.** [E010](E010-filter-expression-language.md) is the only
exploration still `open` besides E015, and two of the surfaces it specifies are
not built. Both fail at evaluation, not at parse:

```text
src/core/src/filter_eval.rs:201   "unknown function"
src/core/src/filter_eval.rs:203   "custom fields are not available yet"
```

`now.md` states the same thing from the UI side: `named()` and custom `field.*`
columns report direct diagnostics and are not offered as completions.

E010 specifies both in detail already. `named(string constant)` resolves at
compile time, requires exactly one allocation with that current name, makes
zero or multiple matches a compile error, and is invalidated by a rename. Custom
fields are called "required in the first version": `field.pool`,
`field["allocator-class"]`, `death.field.reason`, dot access as sugar for an
identifier-shaped key, scalar `null`/bool/int/string only, names and observed
types collected during trace parsing, an incompatible observed type a compile
error.

**Inference.** This is the cheapest of the five and the only one whose design
work is already done. It needs no new exploration; it needs grounding against
the evaluator as it stands now and then one ticket per surface. The two are
independent: `named()` is a compile-time resolution against the name table,
`field.*` is a data-model question about what the parser retains.

**Uncertain.** E010's custom-field section says fields "remain in the existing
interned raw fragments until referenced." Whether that is still an accurate
description of `parse.rs` was not checked while writing this, and it is the
first thing a ticket here must confirm — E010 was written before T016 reshaped
the language, and [T023](../tickets/T023-reground-e014-and-e015.md) is the
precedent for an exploration describing a language that had moved underneath
it.

### B — Undo/redo over analysis data

**Evidence.** [E007 §6](E007-web-architecture-direction.md) split this out
explicitly as needing its own proposal, and named the questions: which
operations are transactional, how it interacts with `marksDirty` and autosave,
whether it is per-trace. `now.md` repeats it under "Not being done,
deliberately" with the same reason — a real feature with user value, not a side
effect of a refactor, and no ticket until it has an exploration.

**Inference.** The surface it covers is now larger than when E007 was written.
T011–T016 added four filter actions that write analysis state, and
filter-to-tag in particular creates a tag over an arbitrary match set in one
gesture — the single most undo-wanting action in the product, and one that did
not exist when E007 listed this.

**Suggestion.** This is the strongest candidate for the next *exploration*, as
opposed to the next ticket. It is unblocked, it is bounded to the heap domain
(E007 says keep it heap-owned if it lands before Stage 4), and its cost is
mostly a design question rather than a research one.

### C — Multiple open traces

**Evidence.** E007 lists this in both §5 and §6: the biggest of the questions
that must have answers before the host, touching the single-engine-instance
decision in [ARCH-001](../../spec/08-architecture.md#arch-001-the-wasm-core),
session persistence, and the whole toolbar. T004's own Blocked section names it
as the largest of the open questions.

**Inference.** This is the largest of the five by a wide margin and the only
one that is a prerequisite for something else. It is also the only one whose
answer could be *no* — deciding that one trace at a time is correct is a real
outcome that unblocks T004's design just as much as deciding yes.

**Suggestion.** Not next. It is worth an exploration before it is worth a
ticket, and that exploration is worth writing when there is a reason to open two
traces, which there currently is not.

### D — The guide drawer's open questions

**Evidence.** [E015](E015-interactive-tutorial.md) stays `open` deliberately
and lists four: what persists (today nothing does), whether one highlight
treatment is enough, how wide the action vocabulary should go, and how much
content there should be plus whether prose cites or restates spec facts.

E015 says these are "answerable from use rather than argument" and that the
file "is not waiting on a decision anyone can make by reading it."

**Inference.** That is a real constraint on this list, not a hedge: none of the
four becomes a ticket by being thought about harder. The one with a cost that
accrues silently is the last — the five sections restate spec facts rather than
citing them, and E015 notes the cost of that choice is "unpaid rather than
absent". A restated fact going stale is exactly the failure class the
2026-07-31 review found five of, and none of those were caught by a suite.

**Suggestion.** No work. But if the guide is used and something in it is found
wrong against the spec, that is the second recorded instance of the
prose-drift failure, and it is worth recording as such when it happens.

### E — The overlapping-tags cost model

**Evidence.** [E014](E014-overlapping-tags-cost-model.md) is settled with
nothing selected. Its benchmark plan is written and executable as filed, minus
one row. Its own Outcome says to re-open by filing a ticket with a
reproduction, not by re-opening the file.

**Suggestion.** No work, and this list should not be read as softening that.
`PROTOCOL.md` wants a measurement before the ticket, and no trace anyone has
opened has been slow.

### F — The structural work already queued

**Evidence.** [T009](../tickets/T009-type-the-deps-contracts.md) is `todo` and
grounded: `d` accounts for 198 of 341 errors under `--strictNullChecks` and 201
of 555 under `--noImplicitAny`, per
[D005](../decisions/D005-strictness-is-per-flag.md). `now.md` calls it "next
after [the guide] and not urgent."

**Uncertain.** T009's `updated` is 2026-07-25, and the web layer has moved since
— the guide drawer, the filter panel's editor, `session.ts`. Whether its counts
and its list of three modules are still accurate is a grounding step, not an
assumption. That check is cheap and is part of starting it.

## Constraints on any answer here

**A new feature needs an exploration before a ticket.** That is not a
formality in this repository: E007 §6 declined to file tickets for B and C for
exactly this reason, and E013 is what a feature batch looks like when the
product questions were answered first. B and C each need their own file.

**Nothing here is measured.** Every cost estimate above is inference from
reading, not from running anything. The one candidate with a written
measurement plan is E, and its conclusion is to do nothing.

**Rendering, pointer interaction and the worker round trip stay uncovered.**
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) and
[E009](E009-the-hand-verification-bottleneck.md) are settled on that, and none
of A–F changes the argument. Any candidate's real verification cost is the
cheap checks plus a person using it.

## Proposed order

A suggestion, not a queue. Nothing below binds until tickets exist.

1. **A — the two E010 surfaces.** Specified, cheap, closes the only open
   exploration that is open because work is unfinished rather than because a
   question is unanswered. Two independent tickets after a grounding pass
   against `filter_eval.rs` and `parse.rs`.
2. **F — T009.** Re-ground first; its counts are six days old and the web layer
   has moved.
3. **B — an exploration for undo/redo.** The largest user-visible gap that is
   unblocked, and larger now than when E007 named it.
4. **C — an exploration for multiple open traces**, when there is a reason to
   open two. It unblocks T004 either way it lands.

D and E stay where they are: D answers itself from use, E answers itself from a
measurement nobody has needed to take.

## Questions

- Is A worth doing at all, or is the filter language complete enough in
  practice? E010 calls custom fields "required in the first version"; that was
  written before any of the language shipped, and nothing since has recorded a
  user wanting them. **This is the one question that could reorder the whole
  list**, and it is a question for the person who wanted the language.
- Does undo/redo mean the analysis operations only, or the navigation history
  too? E007 lists renaming, tag edits and mark moves. Time travel already has
  its own model, and conflating them is a design error worth naming before it
  is made rather than after.
- Is there a second domain in prospect at all? T004 is blocked on one being
  concrete. If the answer is no for the foreseeable future, C loses its
  strongest reason to be answered early and becomes an ordinary feature.

## Derived artifacts

None. This file has produced no tickets, and should not until the first
question above is answered.
