---
id: T005
title: Give spec requirements permanent identifiers
status: done
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

- [x] Every `must` / `must not` / `may` statement in `spec/` sits under an
      identified requirement. Checked by walking each file heading by heading;
      the only hits outside one are in `spec/README.md`, which describes the
      convention rather than stating a requirement.
- [x] `rg '§[0-9]+\.[0-9]|spec/[0-9]+\.[0-9]|specs/' --glob
      '!docs/explorations/**' --glob '!PROTOCOL.md' --glob '!docs/tickets/T006*'`
      returns only this ticket's own description of the old convention.
- [x] `spec/README.md` documents the identifier scheme and the prefix per file.
- [x] Picking one identifier at random, `rg 'MAP-003' .` finds the requirement
      and its four citations.

## Non-goals

- Changing any stated behavior. This is identifiers only; a disagreement found
  along the way becomes its own ticket.
- Editing closed explorations.

## Work log

61 requirements across nine files. `spec/01-overview.md` got none: it is goals,
terminology, and a diagram, with no statement something could conform to or
violate.

The done-when regex was re-grounded before use. As written it also matched
`[E007 §3]` — exploration section numbers, which are not spec citations and are
not what the ticket is about — and the closed `T006`, which is a dated record
and must not be edited. The check run is the narrowed one above: `§N.M`,
`spec/N.M`, and the stale `specs/` path, outside explorations and closed
tickets.

Prefixes are one per file, chosen for what the file is about rather than its
number: `TRACE- MODEL- MAP- TL- NAV- ANL- ARCH- SHELL- TOOL-`. Numbers run in
document order because this was the initial assignment; `spec/README.md` says
plainly that they will not stay that way, since a new requirement takes the
next free number wherever it belongs.

Two things found along the way, both fixed here because both were citations
that no longer resolved rather than statements of behavior:

- `spec/04-address-map.md` cited "`TASKS.md` items 8–10" for why the three
  layout-stability mechanisms exist. `TASKS.md` does not exist in this
  repository. The citation became plain text: the mechanisms were added in
  response to real disorientation while using the app.
- `gen.py` still pointed at `specs/02-trace-format.md`, from before the
  directory was renamed to `spec/`.

Anchors were generated rather than typed: every citation was written as
`](file.md#ID)` and a script rewrote each to the heading's real slug, then
checked that every link into `spec/` resolves to a heading that exists. That
check reported no broken links.

## Result

Every requirement in `spec/` carries a permanent identifier in its heading —
`## MAP-003: Layout stability` — and every live citation names one. Section
numbers survive only in `docs/explorations/` and the closed `T006`, which are
dated records; `docs/README.md` says how to translate one and why they are not
migrated.

`spec/README.md` gained a "Requirement identifiers" section stating the scheme,
that identifiers are permanent and never reused, and the prefix per file, which
is now a column in the module map.
