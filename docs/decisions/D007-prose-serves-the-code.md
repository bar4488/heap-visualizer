---
id: D007
title: Prose serves the code; the code is the deliverable
created: 2026-08-01
---

# D007: Prose Serves the Code

## Decision

**Most of a session goes to writing and thinking about code.** Tickets,
`now.md` and cross-references are overhead that must earn their place against
that, every time.

Stated by the user on 2026-08-01, after the T026–T029 batch produced ~1,600
lines of code and ~9,000 words of prose: *"I want most time to be writing and
thinking about code — not updating tickets and references. If most of your
time goes to servicing the protocol, it's a bad protocol."*

Four consequences, binding here:

1. **One record per finished ticket.** The commit body owns what happened and
   why. A `Result` section is at most two lines, and only when it says
   something the commit does not.
2. **A ticket body defaults to `Outcome` and `Done when`.** Other sections are
   added only when they carry content, per `PROTOCOL.md`. Cite code as
   `file.rs:name` rather than pasting it — a quote is stale the day it is
   written.
3. **`docs/now.md` is not a changelog.** A sentence per area, what is next, and
   repository-wide warnings. What happened is `git log` and the closed tickets.
4. **One ticket per deliverable.** A prerequisite with no observable behavior
   is a commit inside that ticket, not a ticket of its own. Split when work
   spans sessions or two workers need disjoint scopes — not by implementation
   layer.

## What this does not license

**Grounding a ticket against the code is not overhead and is not cut.**
Reading the code before starting is time spent on code, and it is the step that
found, in the batch that prompted this, a field catalog `E010` claimed existed
but never did and an `hp_set_names` call into an export that was never written.
Both had been in the repository for days and neither was visible from any
document.

Nor does it license skipping a spec change when behavior changes, or closing a
ticket whose done-when items were not verified. Those produce prose someone
later depends on. The rule is not *less writing*; it is **writing that gets
read**.

## Why

`PROTOCOL.md` says "one fact, one owner" and gives history to Git, then asks
for a written result and a commit without saying which is the record. Followed
carefully, that produces both. The same is true of `now.md`, which drifts into
narrating what the commits already say, and then must be read in full at every
cold start.

The diagnosis, with the measurements behind it, is
[E018](../explorations/E018-the-protocol-costs-too-much-prose.md). The
instances are logged in [E017](../explorations/E017-protocol-friction.md), which
is what `PROTOCOL.md` asks for and is where they belong if it is ever revised.
This decision is the local practice in the meantime; `PROTOCOL.md` itself is
copied verbatim and is not edited here.
