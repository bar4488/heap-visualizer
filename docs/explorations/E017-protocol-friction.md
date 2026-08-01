---
id: E017
title: Friction with the workflow protocol
status: open
updated: 2026-08-01
---

# E017: Friction With the Workflow Protocol

The log `PROTOCOL.md` asks for. One dated entry per instance of the protocol
itself being the thing that went wrong — a case it does not cover, a rule that
produced something nobody intended, a step that read as unintuitive, an
instruction that had to be guessed at.

**This file stays `open` permanently and is appended to, never settled.** An
entry is a record of what already happened, not a change request and not an
earned rule; `PROTOCOL.md`'s `Adding a rule` decides that separately, and it
wants two recorded instances. Nothing promises a response to any single entry.

Entries are written where the friction happened, by whoever hit it. They are
not edited later.

---

### 2026-08-01 — the ticket Result and the commit message say the same thing twice

Closing T026–T029 meant writing, for each ticket, a `## Result` section and
then a commit message covering the same findings. Measured across the four:
about 3,190 words of `Result` prose against about 1,450 words of commit
bodies, with most of the content common to both — the same two grounding
corrections, the same design notes, the same list of what was verified.

Expected one of them to be the owner. `PROTOCOL.md` says "Git owns history"
and "one fact, one owner", and `Sessions` says to "write the result" and
"commit" as two steps of one finish, without saying how they differ. I wrote
both in full, because a reader who runs `rg` over `docs/` and never reads
`git log` would otherwise miss the findings, and a reader doing `git log` on a
file would otherwise miss them too.

What I do not know is which reader the protocol has in mind. If the ticket is
the durable record, the commit body could be a pointer to it; if Git is, the
`Result` could be. Recording that the duplication happened, not proposing
which way to resolve it.

### 2026-08-01 — four tickets, one session

The custom-fields batch was filed as T026 (catalog), T027 (filtering), T028
(`named()`), T029 (UI) and all four were written, implemented, verified and
closed in a single session. `Tickets` says "one ticket should fit in one or a
few focused sessions", so four in one session is finer granularity than the
document targets.

T026 in particular shipped nothing user-visible: it existed only so T027 had a
catalog to check against. Splitting it out was a deliberate reading of
[D003](../decisions/D003-one-slice-per-commit.md) — with no automated coverage
of the canvas, the commit boundary is the only cheap way to localize a
regression — but it produced a ticket file, a done-when list, a `Result`
section and a commit for a change with no observable behavior.

Expected some guidance on when a prerequisite with no user-visible effect is
its own ticket versus the first commit of the ticket it serves. `Tickets` says
"large or uncertain work produces smaller tickets first", which points one way;
`Must never be true` says nothing about a ticket being too small. I split it,
and I am still not sure that was right.

### 2026-08-01 — the protocol moved to version 8 mid-session and left the repository behind

`PROTOCOL.md` went from version 6 to version 8 while this session was running.
Version 8 adds a `Frontmatter` table requiring `docs/now.md` to carry an
`updated` key; `docs/now.md` carries `_Updated: 2026-08-01._` as prose in its
body instead, which was conformant when it was written.

Expected the protocol to say who reconciles an adopting repository after a
version bump, and whether that is a ticket. `Closed artifacts are not updated`
covers closed tickets and settled explorations, and says a convention change is
noted "once and centrally" — but `docs/now.md` is neither closed nor a dated
record, and the note-once instruction does not obviously mean "leave the live
file non-conformant".

I left it alone, because sweeping it was outside the batch I was asked for, and
flagged it to the user instead. Two other v8 additions I did comply with
without difficulty: minimizing hard-coded mutable values in prose (I removed a
"46 tests" count from a `Result` after writing it), and committing each
coherent piece as it completed.
