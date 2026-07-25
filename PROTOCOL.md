# The Workflow Protocol

Version: 6

A text interface that lets humans and agents work on a repository across many
sessions without depending on conversation history.

**Start by reading `docs/now.md`.** It is the entry point: what to read first,
where things stand, what to do next, and the current queue.

This file is the whole protocol, and it is binding on any repository that adopts
it. When practice and this file disagree, one of them is wrong and the same
change fixes it.

It is copied verbatim into each adopting repository as `PROTOCOL.md` and imported
by that repository's `CLAUDE.md`. **Do not edit it locally**, so that adopting a
later version is a literal overwrite. Anything about *your* project — build
commands, module locations, environment quirks, identity — goes in
`docs/context.md` and `docs/README.md`.

## The shape

```text
PROTOCOL.md           this file, copied — the rules
CLAUDE.md             imports PROTOCOL.md; holds nothing else durable
docs/
  README.md           how to work here
  now.md              where the project stands — the one entry point
  context.md          how to run and test the thing (add when there is something to run)
  tickets/T001-*.md   units of work
  milestones/M001-*.md tickets bound into one assignment (add when work runs in parallel)
  explorations/E001-* ideas, research, reviews, proposals — binding on nothing
  decisions/D001-*.md rationale that would otherwise get quietly undone
spec/                 what your product must do — requirements with permanent IDs
skills/               reusable procedures (add when one is earned)
source and tests
```

`spec/` holds **your product's** requirements, not this protocol: the protocol
constrains how work is done, `spec/` states what the thing being built must do.

A repository adopting this starts with `PROTOCOL.md`, `CLAUDE.md`,
`docs/now.md`, and `docs/tickets/`. Everything else appears when there is
something to put in it.

## The repository is the state

All durable project knowledge lives in the repository. Not in conversation
history, agent memory, a scratchpad, or an external tracker. **Uncommitted work
is not repository state.**

A constraint cited but not defined in the repository is a defect in whatever
cited it.

**An agent must not write durable project knowledge to its own memory**, however
convenient that is. Everything worth keeping already has a home here:

| What was learned | Where it goes |
|---|---|
| What the project is, how to work here | `docs/README.md` |
| Where things stand, what to do next | `docs/now.md` |
| How to run it, test it, deploy it; environment quirks | `docs/context.md` |
| A rule about how work is done here, or a preference to honor | a decision record |
| Something true about the product's behavior | the spec |
| Something learned while doing a piece of work | that ticket's work log |
| An unresolved question or a half-formed idea | an exploration |

If a fact fits none of those, that is a signal it is not durable project
knowledge. There is no memory directory.

## One fact, one owner

A ticket owns its status. The spec owns expected behavior. A decision owns
rationale. `docs/now.md` owns narrative. Git owns history.

Anything derivable from those files is **rewritten from them, never patched** —
the active queue is `rg '^status: doing$' docs/tickets`, and hand-editing one
line of a written-out index writes from memory instead of from the source.
Rewriting the whole block from the query is correct whether a script or an agent
does it.

Anything hand-maintained must be something no query can answer.

## `docs/now.md`

The cold-start file. An agent with no prior context finds the work here.

Hand-written: what to read first and why, the state of each area in a sentence,
what to do next, any repository-wide warning. Generated between markers and
rewritten from ticket status: the queue.

```markdown
## State

**Engine — healthy.** 33 tests asserting real invariants.

**Web layer — works, no internal boundaries.** Future cost, and the active work.

## Next

T031 — buy JS test coverage. Nothing after it is affordable first.

<!-- generated:begin -->
## Doing
- [T031](tickets/T031-js-test-coverage.md) — buy JS test coverage
<!-- generated:end -->
```

There is **one** `now.md`, however many workers. It answers where the *project*
stands — a single fact. A worker's own position belongs in the tickets it holds.
Isolation, where needed, belongs at the worktree level.

How concurrent work is divided between several workers — assignment, write
scopes, isolation — is not specified here.

## Tickets

Every meaningful change is grounded in a ticket. One file, one ticket, flat
directory — no `docs/tickets/2026-07/`, no per-review subdirectory.

Four required keys, and `status` is `todo` `doing` `done`:

```markdown
---
id: T031
title: Buy JS test coverage before the shell split
status: todo
updated: 2026-07-24
---

# T031: Buy JS Test Coverage Before the Shell Split

## Outcome

`node --test` covers the pure functions and the session round-trips, and a
written smoke checklist covers what it cannot.

## Done when

- [ ] `node --test` runs from a clean checkout with no install step.
- [ ] Serializing and reloading an analysis file is asserted lossless.

## Non-goals

- Browser automation. Any refactor of `main.js`.
```

**Start there and add a section only when it carries content.** `Context`,
`Work log`, `Handoff`, `Reproduction`, `Result` — each earns its place by having
something to say. A blocked ticket says what it is waiting for, in a sentence; a
cancelled one becomes `done` with the reason. Add a frontmatter field when
something actually reads it.

A ticket that came from a measurement or a defect carries the commands that
reproduce it. "This is slow" is an opinion; a harness is a finding.

One ticket should fit in one or a few focused sessions. Large or uncertain work
produces smaller tickets first.

### Grounding

**This is the step that matters most, and the one most often skipped.** Before
work starts on a ticket, verify it against the repository rather than against the
idea that produced it:

1. The outcome is a **state**, not an activity — "the user service depends only
   on the storage interface", not "work on storage".
2. Done-when items are observable: each can be checked by running something or
   reading something specific.
3. **File paths, function names, and claims about the code were confirmed to
   exist as the code is now.** A ticket is not evidence about the code. It was
   true when it was written.
4. Requirement references resolve.
5. If it came from a measurement, the reproduction runs.

A ticket that fails any of these is not ready to start. Re-ground one that has
been sitting: `updated` says when it was last true, and the repository has moved
since.

## Milestones

A milestone binds tickets into one **assignment**: work a single agent can carry
to completion, and the set of paths it owns while doing so.

Optional. Add them when the grouping stops being obvious — in practice, when
work runs in parallel. One worker and six open tickets does not need them.

```markdown
---
id: M002
title: Storage layer depends only on the interface
tickets: [T014, T017, T018]
write_scope:
  - src/storage/**
  - tests/storage/**
depends_on: [M001]
updated: 2026-07-25
---

# M002: Storage Layer Depends Only on the Interface

## Outcome

No module under `src/storage/` imports a concrete driver.

## Done when

- [ ] `rg 'import .*driver' src/storage` returns nothing.
```

**A milestone has no status field.** Its state is derived from its tickets:
`done` when all are `done`, `doing` when any is, `todo` otherwise. It is *ready*
when every milestone it depends on is done.

**Concurrently running milestones must have disjoint write scopes.** Overlap is
not a merge to resolve later: either the two are one milestone, or one depends on
the other.

**Shared files are in no milestone's write scope** — `docs/now.md`, the spec,
the indexes. They are written after merge, not mid-flight.

A milestone owns membership, ordering, and scope. It does not own status,
rationale, or narrative. Tickets carry no dependency field: ordering lives at
the milestone level.

**A dependency on a milestone that is not open is already satisfied**, so reading
the graph never requires traversing it — only open milestones are ever examined.

## The spec

The declarative desired state: externally visible behavior, important internal
contracts, invariants. Binding unless a ticket explicitly changes it. No task
lists, no plans, no progress, no history.

**Product requirements carry permanent identifiers** matching
`^[A-Z]+-[0-9]{3}$`, because tickets, tests, and code cite them and those
citations must survive files being split, merged, renamed, and reordered. Never
cite a requirement by section number; `spec/10.3` breaks the first time a section
is inserted above it.

Process rules — everything in this file — carry no identifiers.

```markdown
## STORE-004: User lookup behavior

Looking up an unknown user identifier must return an explicit not-found result.

It must not return an empty user, convert the condition into a storage failure,
or create a user implicitly.
```

Declarative, testable or inspectable, independent of any plan, precise enough to
detect non-conformance. Use `must`, `must not`, `may`. Avoid "should probably",
"ideally", "where possible". Rationale belongs in a decision record, linked from
the requirement.

**When intended behavior changes, the spec changes in the same change** as the
code and the tests. A ticket must not close while code and spec knowingly
disagree — including when the change reverses a documented decision. Reversing
one is legitimate; leaving the old one standing is not.

One file until reading it in one pass stops working. Then split by topic, and
not before.

## Explorations

Non-binding material: early thoughts, open questions, alternatives, research,
experiments, code reviews, proposals, ideas that may never be built. One topic
per file. `status` is `open` or `settled`; a settled exploration carries an
`## Outcome` section saying what was decided and why, including when the answer
was no.

**Code and agents must not treat an exploration as an approved requirement,
however detailed it looks.** An accepted proposal binds nothing until the
artifacts exist — a decision for rationale, spec changes for behavior, tickets
for work. Link both directions.

Start with a thought and a question. Add sections as the idea develops:
`Summary · Why it matters · Questions · Ideas · Constraints · Evidence ·
Proposal · Risks · Outcome · Derived artifacts`.

**A code review is an exploration.** It owns the diagnosis — what was found, how
it was measured, how to reproduce it — and it does **not** own status. Each
finding worth acting on becomes a ticket, and that ticket owns whether it is
fixed. Findings not worth acting on stay in the review with the reason. A review
is written once and then left alone, as a dated record of what was true when it
was made.

In explorations, distinguish evidence from inference from suggestion, mark
uncertain claims, preserve disagreement, and let ideas stay unresolved
indefinitely.

## Closed artifacts are not updated

A `done` ticket and a `settled` exploration are dated records of what was true
when they were written. **They are not migrated to a new format, not updated to
reflect later knowledge, and not rewritten when a convention changes.**

When a convention changes, note the translation once and centrally rather than
everywhere it applies.

When something in a closed artifact is genuinely wrong, **append a dated
correction; do not edit the claim.** Later knowledge belongs in the artifact that
carries it — a new ticket, a new exploration, or the narrative in `docs/now.md`.

This does not license leaving a broken link. A citation whose target no longer
exists becomes plain text, so nothing dangles and nothing is falsified.

## Decisions

Rationale that must outlive the ticket that produced it: a persistence model, an
API compatibility policy, a rejected architecture, a security boundary — and
**every process constraint that governs how work is done.** If a plan is
justified by a rule, that rule has a file. Not for routine implementation
choices.

## Identifiers

One number space per artifact type — `T001`, `E001`, `D001`, `M001` — global and
permanent across the life of the repository. In the filename. Never reused, never
renumbered, never scoped to a date, a review, or a directory. An identifier that
encodes *when* something was found cannot survive the thing being moved.

## Sessions

**Start:** check whether anything is uncommitted. Read `docs/now.md`. Read the
ticket and everything it references. Ground it. Look at the code and tests.
Confirm the ticket's assumptions still hold. Set it to `doing`.

**During:** stay in scope with the done-when items visible. Record findings, not
narration. Update the spec when intended behavior changes. **File a new ticket
instead of expanding this one.**

**Stop** on a blocking contradiction: requirements conflict, required behavior is
undefined, an unapproved destructive migration is needed, or the work cannot
finish in scope.

**Finish, complete:** verify each done-when item, run the tests, confirm the spec
matches, write the result, regenerate the queue, file follow-up tickets, commit.

**Finish, incomplete:** leave it `doing`, log what was learned, and write a
handoff naming the next file, function, test, or decision, plus the command that
shows where things stand. Commit.

No session log. The handoff and Git history carry continuity.

## Skills

A skill is a versioned procedure telling an agent how to perform a class of work
while staying grounded in repository state. Not a task database, not a home for
current state, not a personality. `skills/<name>/SKILL.md`, declaring what it
reads, what it writes, its procedure, and when to stop.

**A skill holds no state** — not "the active ticket is T014" but "read the queue
from `docs/now.md`".

Repository-local skills win over organization, user, and built-in ones.

Add a skill when a procedure has repeated and been done wrong. The candidates,
in the order they usually earn their place: `write-ticket`, `start-session`,
`work-ticket`, `finish-session`, `regenerate-queue`.

## Searching

```sh
rg '^status: todo$' docs/tickets       # what can be started
rg '^status: doing$' docs/tickets      # what is in flight — the queue source
rg '^status: open$' docs/explorations  # what is unresolved
rg -A3 '^tickets:' docs/milestones     # membership, scope, and ordering
rg 'STORE-004' .                       # everything touching a requirement
```

These keep working only if the conventions hold: lowercase keys, ISO dates, IDs
in filenames, one entity per file, controlled status values, relative links, no
important state in prose only.

## Adding a rule

**A process rule requires two recorded instances of the failure it prevents.
Until then it is a note, not a rule.**

An instance does not have to be written down already. **A person who works in
the repository reporting that the failure has happened repeatedly counts as two
instances.** Record the report when it is accepted: who said it, when, and what
kept happening.

What does not count, in any form: an agent's own assertion that it struggled,
and anyone's expectation that a failure is likely. The distinction is tense. A
report of what has already happened is evidence; a prediction that something will
happen is not.

The same test applies to a new directory, a new status value, a new frontmatter
field, a new skill, and a new validator: name the two times its absence hurt.

## Must never be true

- Meaningful work without a ticket.
- Work started on a ticket whose claims were never checked against the code.
- A ticket closed without its done-when items verified.
- Code and spec knowingly disagreeing at close.
- Durable state outside the repository — including uncommitted files.
- A constraint cited but defined nowhere.
- Two owners for one mutable fact, or a derivable fact maintained by hand.
- A milestone carrying its own status, or two running milestones whose write
  scopes overlap.
- An identifier reused, or scoped to a date or directory.
- A requirement cited by section number.
- A skill holding project state.
- Scope expanded silently instead of becoming a new ticket.
- An exploration treated as an approved requirement.
- An unfinished session without a concrete handoff.
- A new rule or mechanism with no recorded failure behind it.
