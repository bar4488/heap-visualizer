---
id: D005
title: Strictness is a named list of flags, not `strict: true`
updated: 2026-07-25
---

# D005: Strictness Is a Named List of Flags

## Decision

`tsconfig.json` turns on every type-checking flag the web layer passes, one by
one, and leaves `strict` itself off. The flags it does *not* turn on are listed
in the same file with the reason and the ticket that would let them come on.

On today: `strictFunctionTypes`, `strictBindCallApply`, `noImplicitThis`,
`alwaysStrict`, `useUnknownInCatchVariables`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`.

Off, both for one reason: `noImplicitAny` and `strictNullChecks`.

**A flag that is on is not turned off to land a change.** Adding to the off
list requires the same thing as any other rule here — the failure, written
down.

## Why

`strict: true` is an alias whose membership changes between TypeScript
releases. Turning it on means agreeing in advance to checks that do not exist
yet, and the first upgrade that adds one produces a wall of errors in a layer
whose only other automated coverage is 44 unit tests
([D001](D001-web-changes-are-hand-smoke-tested.md)). Listing the flags means an
upgrade changes nothing until someone chooses.

The list is also the honest form of the answer. "Strictness is low" says
nothing a reader can act on; ten flags on and two off, each with a number and a
ticket, says exactly what is left. Measured on 2026-07-25, from a clean
`src/web/`:

| Flag | Errors | Largest single cause |
|---|---|---|
| `strictNullChecks` | 341 | 198 × `'d' is possibly 'null'` |
| `noImplicitAny` | 555 | 201 × `Variable 'd' implicitly has an 'any' type` |
| both | 645 | |

```sh
npx tsc -p tsconfig.test.json --strictNullChecks 2>&1 | grep -c 'error TS'
npx tsc -p tsconfig.test.json --noImplicitAny 2>&1 | grep -c 'error TS'
```

`d` is `analysis.ts`, `session.ts` and `events-panel.ts` holding their injected
dependencies as module state:

```js
let d = null;
export function initAnalysis(deps) { d = deps; ... }
```

`deps` is untyped, so every `d.ui.tags` reads a property off an implicit `any`;
`d` starts as `null`, so every one of them is also a possibly-null read. One
pattern, roughly 200 errors under each flag, and
[T009](../tickets/T009-type-the-deps-contracts.md) is what retires it.

T009 does **not** finish either flag — it is the largest single cause, not the
majority. The ~350 that remain under `noImplicitAny` are unannotated function
parameters spread across every module, and the ~140 that remain under
`strictNullChecks` are genuine unchecked nulls worth reading one at a time.
Neither has a ticket yet, and neither should get one before T009 has moved the
count, because both are re-measured from the code rather than planned from
here.

Turning a flag on ahead of the work it names would mean several hundred casts
written to silence a checker, which is the opposite of what the types are for.

## What would reverse it

`strict` becoming stable — no longer gaining members across releases — or the
off list reaching zero, at which point `strict: true` and the explicit list say
the same thing and the alias is shorter.
