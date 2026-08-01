---
id: E018
title: The protocol costs too much prose, and how I have been reading it
status: open
updated: 2026-08-01
---

# E018: The Protocol Costs Too Much Prose

## Summary

Written after the T026–T029 batch, at the user's instruction, to say plainly
what is wrong with how work is done here and how much of that is the protocol
versus how I have been reading it.

**The complaint, in one measurement.** That batch produced about 1,600 lines of
code and about 600 lines of tests. It also produced about **9,000 words of
prose**: four tickets, two explorations, a rewritten `Next` section, and
commit bodies. Reading and writing that prose was a large fraction of the
session, and almost none of it is the thing anyone opens this repository to
get.

The user's position, stated 2026-08-01: **most of the time should go to
writing and thinking about code, not to updating tickets and references. If
most of the time goes to servicing the protocol, it is a bad protocol.** That
is now [D007](../decisions/D007-prose-serves-the-code.md).

This file is the diagnosis. It is an exploration and binds nothing; the parts
that should bind are in D007.

**And this file is itself an instance of the problem.** Three explorations in
one day — [E016](E016-what-to-build-next.md) on what to build,
[E017](E017-protocol-friction.md) on friction, this one on the friction being
too expensive — is documents about documents. That is worth naming rather than
pretending it away, and it is an argument for making this the last one on the
subject and moving to D007.

## The measurement

From `git diff --numstat df8caa5^ HEAD` and `wc -w`, 2026-08-01:

| | |
|---|---|
| code (Rust, TS, CSS, HTML, `gen.py`) | ~1,600 lines |
| tests | ~600 lines |
| four ticket files | ~3,700 words |
| E016 | ~1,810 words |
| `now.md` `## Next` after the rewrite | ~1,380 words |
| commit bodies | ~1,450 words |

Roughly **one word of prose for every quarter-line of code.** Nothing in
`PROTOCOL.md` asks for that ratio; it is what following it carefully produced.

## Where the prose actually went

Separating what earned its place from what did not. **Evidence** where I can
point at an outcome, **inference** where I am reasoning about it.

### Earned it — do not cut

**Grounding a ticket against the code.** *Evidence.* This is the step that
found E010's field catalog had never been built and that `hp_set_names` was a
call into an export that did not exist. Both had been sitting in the
repository for days, neither was visible from the tickets or from E016, and
both would otherwise have surfaced mid-implementation as confusing failures.

I want to be exact about a distinction the user's phrasing collapses. Time
spent **grounding the ticket against the code** — reading `parse.rs`,
`store.rs`, `filter_eval.rs` before writing anything — is time spent thinking
about code, and it is the highest-value thing I did all session. Time spent
**servicing the protocol's bookkeeping** — status flips, cross-references,
re-narrating in `now.md` what a commit already said — is not. The first is not
overhead and should not be cut to make the ratio look better. Everything below
is about the second.

**Changing the spec in the same commit as the behavior.** *Evidence.* ANL-010
and ANL-011 exist because the code and spec would otherwise disagree silently,
which is the failure this repository has already had (T023, and four of the
five defects the 2026-07-31 review found). 93 lines of spec against 1,600 of
code is a fair price.

### Did not earn it — cut

**Two records of the same finish.** *Evidence.* ~3,190 words of ticket
`Result` against ~1,450 words of commit bodies, most content common to both.
`PROTOCOL.md` says "Git owns history" and "one fact, one owner", then
`Sessions` lists "write the result" and "commit" as separate steps without
saying which is the record. I wrote both in full because I could not tell which
reader was intended. This is the single largest piece of waste in the session.

**Ticket `Context` sections that re-narrate code.** *Inference.* Each of the
four tickets quoted the code it was about — T027's quoted two lines of
`filter_eval.rs` and their line numbers. Those quotes were accurate the hour
they were written and are the exact thing `PROTOCOL.md` warns goes stale ("a
ticket is not evidence about the code"). The grounding needed to happen; the
transcript of it did not.

**`now.md`'s `Next` section as a second changelog.** *Evidence.* ~1,380 words,
much of it recapping what the four commits and four tickets already say.
`PROTOCOL.md` gives `now.md` "where things stand, what to do next" and one
sentence per area. What it has become is a narrated history that every session
must read before starting.

**Status transitions on work that never spans a session.** *Inference.*
`todo` → `doing` → `done` exists so a cold-start reader can tell in-flight work
from abandoned work. For four tickets opened and closed in one sitting it
bought nothing and cost four edits and their commits.

**A ticket for a change with no observable behavior.** *Inference.* T026
shipped nothing a user can see; it existed so T027 had a catalog. It got a
file, a done-when list, a `Result` and a commit. D003's bisection argument is
satisfied by the *commit* boundary, not the ticket boundary.

## How I have been reading it, and where that was wrong

Some of the cost is my interpretation rather than the text.

**I read "record findings, not narration" as "record findings at length."** The
instruction is about *kind*, not *volume*. A finding can be one sentence. Most
of mine were paragraphs.

**I treated every artifact section as expected rather than earned.**
`PROTOCOL.md` is explicit — "start there and add a section only when it carries
content" — and I added `Context`, `Result`, `Non-goals` and `Verification` to
all four tickets by default. That is the opposite of what it says, and it is
mine, not the document's.

**I treated ticket files as the unit of thought.** They are the unit of
*assignment*. Nothing required four files for one afternoon's deliverable; I
split by implementation layer because that is how I was going to build it, and
each split multiplied the paperwork.

**I under-used the exemption I was given.** D001 was amended so an agent runs
what is cheap and says what it did not cover. I still wrote a `Verification`
paragraph per ticket restating the same four commands.

## What would actually change the ratio

**Suggestion**, not evidence. Ordered by how much prose each removes.

1. **One record per finished ticket.** The commit body owns what happened and
   why. The ticket's `Result` becomes at most two lines, or nothing. Removes
   the largest single duplication.
2. **`now.md` stops being a changelog.** State in a sentence per area, what is
   next, repository-wide warnings. History is `git log` and the closed
   tickets. This also shortens every future session's cold start, which is a
   compounding saving rather than a one-time one.
3. **One ticket per deliverable.** A prerequisite with no observable behavior
   is a commit inside it. Split only when the work genuinely spans sessions or
   two people need disjoint scopes.
4. **Ticket bodies default to `Outcome` + `Done when`.** `Context` only for a
   claim the reader cannot check by running something. No code quotes: cite
   `file.rs:fn_name` and let the reader open it, which cannot go stale the way
   a pasted snippet does.
5. **Skip `doing` for work that will not outlive the session.** Set it only
   when stopping mid-ticket, which is the case the status exists for.

Items 1, 2 and 4 need nobody's permission — they are how I write, and D007
covers them. Item 3 is a judgment call per batch. Item 5 contradicts a literal
reading of `Sessions`, so it is the one that genuinely needs a decision.

## What I would not change

Preserving the disagreement, because the user's framing would allow cutting
these and I think that would be a mistake:

- **Grounding against the code.** Argued above. Cutting it is how this batch
  would have been built on two false premises.
- **Spec changes alongside behavior.** The repository has already been burned
  by prose that stopped being true; this is the mechanism that prevents it for
  the part that matters.
- **A ticket existing at all before non-trivial work.** The done-when list is
  what stopped scope creep four times in this batch. It is cheap when it is six
  lines, which is the point of item 4.

The target is not "less process". It is **process whose output someone reads**.
The done-when list gets read. The `Result` section, in a repository with
`git log`, does not.

## Open questions

- Is `docs/now.md` for a cold-start *agent* or for the *user*? The two want
  very different lengths, and the answer decides item 2.
- Does anything actually read a ticket's `Result` after it closes? If the
  honest answer is no, item 1 is free.
- `PROTOCOL.md` is copied verbatim and must not be edited locally, but every
  item above is about how it is *applied*. Is a local decision the right
  instrument, or should these go upstream as friction entries
  ([E017](E017-protocol-friction.md)) and wait? I have done both: D007 for
  local practice, E017 for the record.

## Derived artifacts

- [D007](../decisions/D007-prose-serves-the-code.md) — the standing preference
  and the parts of this file that bind.
- [E017](E017-protocol-friction.md) — the friction log, where the instances
  behind this analysis are recorded as dated entries.
