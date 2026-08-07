---
id: T039
title: The README's build and test sections are commands
status: done
updated: 2026-08-07
---

# T039: The README's Build and Test Sections Are Commands

## Outcome

`README.md` says what the project is, how to build it, and how to test it. The
command blocks carry no inline comments and no prose restating what the command
already says. Detail that another file owns is a link, not a copy.

Asked for by the user on 2026-08-07: "how to build, how to test, without
comments and without redundant explanations."

## Done when

- [x] No `#` comment inside a `README.md` code fence.
- [x] The README type-check command is `node_modules/.bin/tsc`, not `npx tsc`
      ([T021](T021-live-docs-drop-npx-tsc.md)).
- [x] Every command in the README runs from a clean checkout.

## Non-goals

- `docs/context.md`, which owns the operational detail the README links to.
- The spec.
