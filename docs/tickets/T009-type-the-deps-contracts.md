---
id: T009
title: The injected deps contracts are types, not comments
status: todo
updated: 2026-07-25
---

# T009: The Injected Deps Contracts Are Types, Not Comments

## Outcome

`analysis.ts`, `session.ts` and `events-panel.ts` each declare the shape of
what `init*(deps)` takes, and hold it as a typed non-null value. A caller
passing a deps object missing a function, or passing one whose signature does
not match, is a build error.

## Context

The three modules receive everything they need from `main.ts` through one
injected object, described in a comment above each `init*`:

```js
let d = null;

// deps: { ui, post, CAT, DEFAULT_ROW_BYTES, fmtTime, buildLegend, sendFilter,
//         sendNames, rowBytesValue, setRowBytesInput, sendCollapseMin }
export function initAnalysis(deps) {
  d = deps;
  ...
}
```

That comment is the whole contract. It is also the largest single obstacle to
raising the two type-checking flags that are off
([D005](../decisions/D005-strictness-is-per-flag.md)): `d` accounts for 198 of
the 341 errors under `--strictNullChecks` and 201 of the 555 under
`--noImplicitAny`.

`main.ts` already owns `UIState`, so `deps.ui` has a type to name. The rest of
each deps object is functions that live in `main.ts`.

Retiring the pattern does not finish either flag — see D005 for what is left
underneath, which is deliberately not planned from here.

## Done when

- [ ] No `let d = null` remains under `src/web/`; each module's deps value is
      typed and non-null by construction.
- [ ] The `// deps: { … }` comments are gone, replaced by the types they
      described.
- [ ] `npx tsc -p tsconfig.test.json --strictNullChecks 2>&1 | grep -c 'error TS'`
      reports no `'d' is possibly 'null'` errors, and the same command with
      `--noImplicitAny` reports no `Variable 'd' implicitly has an 'any' type`.
- [ ] `node --test 'src/web/**/*.test.ts'` and `cargo test` pass, and
      `./build.sh` emits a `dist/` that loads.

## Non-goals

- Turning `strictNullChecks` or `noImplicitAny` on. Both need work this ticket
  does not do; D005 records why they stay off until re-measured.
- Changing what any module receives, or moving a function between modules. The
  deps objects are written down as they are, wrong ones included.
- The stub deps the tests build (`test/session.test.ts`,
  `test/analysis.test.ts`) become type-checked against the new types, but the
  tests' coverage does not change.
