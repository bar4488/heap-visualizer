---
id: T005
title: Give spec requirements permanent identifiers
status: todo
updated: 2026-07-25
---

# T005: Give Spec Requirements Permanent Identifiers

## Outcome

Every normative statement in `spec/` carries a permanent identifier matching
`^[A-Z]+-[0-9]{3}$`, and nothing anywhere cites a requirement by section
number.

## Context

The spec predates this repository adopting the protocol. It is organized by
numbered sections (`§8.1`, `§10.2`, `§7.7`) and everything that cites it — this
ticket set included — cites those numbers. Section numbers do not survive a
section being inserted above them, which is exactly the edit a growing spec
makes most often.

The work is mechanical but not small: ten files, and every citation in
`spec/`, `docs/tickets/`, `docs/now.md`, `README.md`, and the code comments in
`core/src/` and `web/` that name a spec section.

Citations inside `docs/explorations/` are **not** updated. Those are dated
records; a settled exploration is not migrated when a convention changes.
A citation there whose target stops resolving becomes plain text.

Prefixes, one per topic area, are chosen when the work starts — e.g. `TRACE-`,
`STORE-`, `MAP-`, `ARCH-`. Not every paragraph is a requirement: descriptive
prose and rationale stay unnumbered, and rationale that deserves to outlive the
spec moves to a decision record.

## Done when

- [ ] Every `must` / `must not` / `may` statement in `spec/` sits under an
      identified requirement.
- [ ] `rg '§[0-9]|spec/[0-9]+\.[0-9]' --glob '!docs/explorations/**'` returns
      nothing outside the spec's own table of contents.
- [ ] `spec/README.md` documents the identifier scheme and the prefix per file.
- [ ] Picking one identifier at random, `rg '<ID>' .` finds the requirement and
      everything citing it.

## Non-goals

- Changing any stated behavior. This is identifiers only; a disagreement found
  along the way becomes its own ticket.
- Editing closed explorations.
