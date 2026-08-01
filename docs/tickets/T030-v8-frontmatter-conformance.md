---
id: T030
title: Live artifacts carry the frontmatter PROTOCOL v8 requires
status: todo
updated: 2026-08-01
---

# T030: Live Artifacts Carry the Frontmatter PROTOCOL v8 Requires

## Outcome

`docs/now.md` and every decision record carry the keys `PROTOCOL.md`'s
`Frontmatter` table requires, with values that are true.

## Context

`PROTOCOL.md` went from version 6 to version 8 on 2026-08-01 and added the
`Frontmatter` table. Two live artifact classes do not match it, both
conformant when they were written:

- `docs/now.md` requires `updated`; it carries `_Updated: 2026-08-01._` as
  prose in the body instead, with no frontmatter block at all.
- A decision requires `created` and D001–D006 carry `updated`. D007 already
  uses `created`.

**The decision key is not a rename.** `updated` means "last true then";
`created` never changes. At least one of the six is provably not a creation
date — D001 records an amendment on 2026-07-25 and carries that date — so
copying the value across would assert something false. Take the date from
`git log --diff-filter=A --format=%as -- <file>` and treat a disagreement with
the existing value as the thing to look at, not a rounding error.

Closed tickets and settled explorations are **out of scope**: `PROTOCOL.md`
says dated records are not migrated when a convention changes.

## Done when

- [ ] `docs/now.md` opens with a frontmatter block carrying `updated`, and the
      prose line is gone rather than duplicated.
- [ ] Each of D001–D006 carries `created` with its date established from git
      history, and any file whose recorded date disagreed with its first commit
      says so in a line of its body.
- [ ] `rg --no-filename '^(updated|created):' docs/decisions` shows `created`
      only.
- [ ] Ticket and exploration frontmatter is spot-checked against the table and
      left alone if it already matches.
