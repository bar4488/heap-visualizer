---
id: T006
title: Drop the fixed smoke checklist; hand-verification stays but the script goes
status: done
updated: 2026-07-25
---

# T006: Drop the Fixed Smoke Checklist

## Outcome

`docs/smoke-checklist.md` no longer exists. D001 still holds — an agent does
not verify a web change by itself, rendering and pointer interaction are
checked by a person — but there is no fixed, numbered script backing that. An
agent hands back a plain-language list of what the change touches instead of
a set of checklist step numbers. No doc references the deleted file.

## Context

D001 recorded the checklist as turning an ad-hoc smoke test into "something
repeatable — a regression shows up in a consistent place." In practice it went
unused: Bar smoke-tests by using the app and never ran the written script. The
fixed-script part of the decision cost a file and several redundant citations
across `docs/`, `spec/`, and `docs/decisions/D003` without being the thing that
actually happened. The underlying stance — no browser automation, a human
checks rendering by hand — is unaffected and is not being reopened here; see
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

This also folds in a smaller complaint: the same "web changes are hand-verified
per D001" fact was restated at length in `docs/README.md`, `docs/now.md`, and
`docs/context.md` instead of being cited once. Touching all of these to drop
the checklist is the point to also tighten that.

## Done when

- [x] `docs/smoke-checklist.md` deleted.
- [x] D001 rewritten: no fixed script, same no-agent-verification /
      no-browser-automation stance, reasoning updated to say why the script
      was dropped.
- [x] D003's "smoke checklist runs before the next slice" line no longer
      names a file that doesn't exist.
- [x] `docs/context.md`, `docs/now.md`, `docs/README.md`,
      `spec/10-tooling.md` §10.3 no longer link to the deleted file.
- [x] `rg -i smoke-checklist .` outside `docs/explorations/` and this ticket
      returns nothing.
- [x] `docs/README.md`'s repeated restatement of the D001 fact is trimmed to a
      citation.

## Non-goals

- Reopening whether an agent may drive a browser. D001's core stance stands.
- Editing `docs/explorations/E007`, which recommended the fixed script — it is
  a settled, dated record and is not migrated to reflect this reversal.
