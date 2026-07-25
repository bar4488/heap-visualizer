# How to work here

This repository runs [the Workflow Protocol](../PROTOCOL.md), imported by
`CLAUDE.md`. That file is the binding process rules and is a verbatim copy — do
not edit it locally. This file is the project-specific part.

**Start at [now.md](now.md).** It says where things stand and what to do next.

## The map

| Path | Owns |
|---|---|
| [now.md](now.md) | Where the project stands, and the queue. The one entry point. |
| [context.md](context.md) | How to build, run, test, and verify. |
| [tickets/](tickets/) | Units of work. A ticket owns its own status. |
| [decisions/](decisions/) | Rationale that must outlive the ticket that produced it. |
| [explorations/](explorations/) | Reviews, proposals, open questions. Binding on nothing. |
| [../spec/](../spec/README.md) | What the product must do. Authoritative. |

## The three things worth knowing before you touch anything

**The spec is authoritative.** When behavior and `spec/` disagree, one of them
is wrong and the same change fixes both. This holds when the change reverses a
documented decision — reversing one is legitimate, leaving the old one standing
is not. [TOOL-003](../spec/10-tooling.md#tool-003-tests) is an example of a stance being
reversed in place, and [T003](tickets/T003-typescript-at-the-contracts.md) will
do it again to [TOOL-002](../spec/10-tooling.md#tool-002-build).

**Run every check that is cheap; build nothing that drives a browser.** An
agent establishes what it can — the suites, the type-checker, the build, and a
diff of the emitted `dist/` when a change is meant to preserve behavior — and
then says plainly what that did *not* cover. It does not hand a cheap check
back to a person, and a person's pass is not a gate on closing a ticket. The
recipes are in [context.md](context.md#verify-a-web-change); the reasoning is
[D001](decisions/D001-web-changes-are-hand-smoke-tested.md).

**One finding or one refactor slice per commit** — see
[D003](decisions/D003-one-slice-per-commit.md). With no automated coverage of
the canvas, the commit boundary is the only cheap way to localize a regression.

## Finding things

```sh
rg '^status: todo$' docs/tickets        # what can be started
rg '^status: doing$' docs/tickets       # the queue source for now.md
rg '^status: open$' docs/explorations   # what is unresolved
rg 'F10' docs/explorations              # a review finding by its id
rg 'MAP-003' .                          # a requirement and everything citing it
```

Review findings carry `F<n>` ids inside the 2026-07-24 review only. They are not
a second ticket space: a finding worth acting on became a ticket, and the ticket
owns whether it is fixed.

## A note on the identifier spaces

`T`/`E`/`D` numbers are global and permanent. `F<n>` predates the protocol and
is local to [E002](explorations/E002-review-2026-07-24.md). Spec requirements
carry per-file prefixes (`TRACE-`, `MAP-`, `ANL-`, …) listed in
[spec/README](../spec/README.md#requirement-identifiers); cite one by its
identifier, never by a section number.

Citations written before [T005](tickets/T005-spec-requirement-ids.md) landed on
2026-07-25 name spec sections (`§7.7`, `§10.2`). Those survive only in closed
explorations and closed tickets, which are dated records and are not migrated;
translate one by opening the file and finding the identifier on that heading.

Explorations and closed tickets are dated records. They are not updated when a
convention changes, and a wrong claim in one gets a dated correction appended
rather than an edit.
