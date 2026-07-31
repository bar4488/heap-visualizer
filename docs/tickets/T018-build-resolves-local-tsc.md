---
id: T018
title: build.sh resolves the local tsc, not npx's package lookup
status: done
updated: 2026-07-29
---

# T018: build.sh Resolves the Local tsc, Not npx's Package Lookup

## Outcome

`./build.sh` in a checkout that has not run `npm install` fails with its own
message naming `npm install`, and never reaches the `tsc` package on the
registry.

## Reproduction

```sh
mv node_modules /tmp/node_modules.bak   # or a fresh clone
./build.sh web
```

Before the fix this prints, from a package that is not TypeScript:

```
This is not the tsc command you are looking for.
To get access to the TypeScript compiler, tsc, from the command line ...
```

`typescript` is a devDependency (`package.json`), so `npx tsc` finds nothing
locally and falls through to fetching the unrelated `tsc` package from npm,
whose whole content is that message.

## Done when

- [x] `build.sh` invokes `node_modules/.bin/tsc` directly.
- [x] With `node_modules/` absent, `./build.sh web` exits non-zero before any
      compile step and the message names `npm install`.
- [x] With `node_modules/` present, `./build.sh web` emits the same `dist/` tree
      as before the change.

## Non-goals

- Having the build run `npm install` itself. The install stays an explicit,
  documented step ([context](../context.md)).

## Result

`build.sh` now checks for and invokes `node_modules/.bin/tsc` directly before
touching `dist/`. With `node_modules/` temporarily absent, `./build.sh web`
exited 1 with `error: TypeScript compiler not found; run npm install`, and the
existing `dist/` tree was unchanged.

With dependencies restored, `./build.sh web` passed and `diff -r` reported no
difference from the tree emitted before the change. `bash -n build.sh`,
`node --test 'src/web/**/*.test.ts'`, and both Rust test suites also passed.
