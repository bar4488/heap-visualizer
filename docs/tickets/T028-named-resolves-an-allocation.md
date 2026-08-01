---
id: T028
title: named() resolves an allocation by its user-given name
status: todo
updated: 2026-08-01
---

# T028: `named()` Resolves an Allocation by Its User-Given Name

## Outcome

`abs(seq - named("request root").seq) <= 10` and
`address >= named("request root").address` compile and evaluate. Zero or
several allocations carrying the name is a diagnostic, not a silent match.

## Context

**Allocation names have never reached the core.** The worker posts them behind
a guard for an export that does not exist:

```ts
// worker.ts:651
case 'names':
  S.names = new Map(m.names);
  if (S.loaded && typeof E.hp_set_names === 'function') {
    const len = writeBuf(te.encode(JSON.stringify(m.names)));
    E.hp_set_names(len);
  }
```

`rg --no-filename 'hp_set_names' src/` matches only those two lines. The
`typeof` guard makes it a silent no-op — names are drawn as map labels from
`S.names` on the worker side (`worker.ts:229`) and the engine has never seen
them.

The channel to build is the one `hp_set_tag_labels` already is
(`lib.rs:675`, with `parse_tag_labels` under it): the web layer owns the
analysis objects, pushes them in on change, and the core holds them for
checking and evaluation. Tag labels arrive as a JSON array; names are a map of
creator event to name, so the shape differs but the lifecycle does not.

Per [E010](../explorations/E010-filter-expression-language.md), `named("x")`
resolves **at compile time**: it is a constant allocation reference, its fields
are the ordinary allocation fields, and renaming invalidates a compiled filter.
That last part is already handled by the existing flow — the Filter panel
re-checks on change — provided the core is told when names change.

## Done when

- [ ] `hp_set_names` exists, parses the creator-event/name map the worker
      already sends, and holds it beside `tag_labels`. The `typeof` guard in
      `worker.ts:653` goes away, since the export now exists.
- [ ] Renaming, clearing, or loading names re-checks the draft expression and
      re-applies an applied one, so a filter using `named()` cannot keep
      matching against a name that is gone.
- [ ] `named("x")` type-checks as an allocation reference; `named("x").<field>`
      has the same type as the bare field. `named("x")` used as a value, or with
      a non-constant argument, is a diagnostic.
- [ ] Zero matches and more than one match are both compile diagnostics naming
      the count, per E010.
- [ ] Completion offers `named(` at expression position, current names as its
      argument, and the allocation fields after `named("x").`. It is offered
      only when at least one name exists.
- [ ] Native tests cover: resolution to the right event, zero matches, two
      matches, a field read through the reference, and a name that changes
      between two checks.
- [ ] [ANL-003](../../spec/07-analysis.md#anl-003-filter) states the `named()`
      surface and its compile-time resolution.
- [ ] `cargo test` passes, `node --test 'src/web/**/*.test.ts'` passes,
      `node_modules/.bin/tsc -p tsconfig.test.json` is clean, and `./build.sh`
      emits a `dist/` that loads.

## Non-goals

- Making names a core-owned analysis object. The web layer keeps ownership and
  `.heapa` persistence; the core holds a pushed copy, exactly as it does for
  tag labels.
- Matching several allocations by name. E010 makes that an error on purpose;
  a tag is the object for a set.
