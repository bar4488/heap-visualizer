---
id: T021
title: Live docs invoke the local tsc, not npx
status: done
updated: 2026-07-31
---

# T021: Live Docs Invoke the Local tsc, Not npx

## Context

`T018` (then numbered T016) established that `npx tsc` does not run TypeScript
in this repository: `typescript` is a devDependency, so with `node_modules/`
absent npx falls through to an unrelated package on the registry whose entire
content is a message saying it is not the compiler. It fixed `build.sh` and
left every other recipe alone.

Four live files still instruct a reader to run exactly that, and one of them is
the done-when of a ticket nobody has started yet.

## Reproduction

```sh
mv node_modules /tmp/node_modules.bak    # or a fresh clone
npx tsc -p tsconfig.test.json            # prints the wrong package's message
```

Confirmed on 2026-07-31 with `node_modules/` absent: the command reached the
network, installed the unrelated `tsc` package, printed "This is not the tsc
command you are looking for", and exited 1.

With `node_modules/` **present**, `npx tsc` resolves the local binary and is
correct — which is why the recipes have worked for everyone who ran
`npm install` first, and why D005's measured error counts are not in doubt.

The failure is the no-install path only, and there it is quiet in the way that
matters: the message names neither this repository nor `npm install`, the fix
it suggests (`npm install typescript`) installs a dependency `package.json`
already declares, and a piped check like
`npx tsc … 2>&1 | grep -c 'error TS'` — which is how D005 and T009 phrase it —
reads **0 errors** from a compiler that never ran.

## Outcome

Every runnable `tsc` recipe outside a closed artifact invokes
`node_modules/.bin/tsc`, and a reader who has not run `npm install` gets a
failure that names `npm install` rather than a success that means nothing.

## Done when

- [x] `rg -n 'npx tsc' docs/context.md docs/README.md docs/now.md docs/decisions
      docs/tickets/T004-shell-host.md docs/tickets/T009-type-the-deps-contracts.md`
      returns nothing.
- [x] `docs/context.md` names `npm install` as the prerequisite at each place
      the compiler is invoked, and `./build.sh` is given as the recipe that
      checks the prerequisite for you.
- [x] `T009`'s done-when commands invoke the local compiler, so that a session
      starting the ticket without `npm install` is told what is missing instead
      of reading `grep -c 'error TS'` as 0 against a package that is not the
      compiler.
- [x] Closed tickets are untouched: `rg -l 'npx tsc' docs/tickets` lists only
      tickets whose `status` is `done`.

## Non-goals

- Adding a wrapper script or an npm script for the compiler. `build.sh` already
  resolves it and already fails with the right message.
- Making the build install dependencies (a non-goal of T018 as well).

## Result

Four live recipes now invoke `node_modules/.bin/tsc`: `docs/context.md` (the
Test block and the Verify-a-web-change block), `D001`'s "what is cheap" list,
`D005`'s two flag-count commands, and `T009`'s done-when. `docs/context.md` and
`docs/now.md` each carry a short paragraph saying why, so the next person to
type `npx tsc` from memory has the reason in front of them.

Every remaining occurrence of the string `npx tsc` in `docs/` is either inside a
`status: done` ticket — dated records, untouched — or prose explaining not to
use it.

**One correction to this ticket's own Context, made before it closed.** The
first draft claimed `npx tsc` exits 0 on the failure, which would have made it
invisible to scripted callers; that reading came from `$?` after a pipe into
`tail`. Re-run cleanly it exits 1. The real hazard is narrower and is what the
ticket now describes: the piped `2>&1 | grep -c 'error TS'` form that D005 and
T009 both use reads **0 errors** from a compiler that never ran. D005's own
measured counts were checked and stand, because npx resolves the local binary
whenever `node_modules/` is present.

With dependencies installed, both `tsc` configs exit 0, all three suites pass,
and `./build.sh web` emits.
