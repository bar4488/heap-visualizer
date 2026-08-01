---
id: T028
title: named() resolves an allocation by its user-given name
status: done
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

- [x] `hp_set_names` exists, parses the creator-event/name map the worker
      already sends, and holds it beside `tag_labels`. The `typeof` guard in
      `worker.ts:653` goes away, since the export now exists.
- [x] Renaming, clearing, or loading names re-checks the draft expression and
      re-applies an applied one, so a filter using `named()` cannot keep
      matching against a name that is gone.
- [x] `named("x")` type-checks as an allocation reference; `named("x").<field>`
      has the same type as the bare field. `named("x")` used as a value, or with
      a non-constant argument, is a diagnostic.
- [x] Zero matches and more than one match are both compile diagnostics naming
      the count, per E010.
- [x] Completion offers `named(` at expression position, current names as its
      argument, and the allocation fields after `named("x").`. It is offered
      only when at least one name exists.
- [x] Native tests cover: resolution to the right event, zero matches, two
      matches, a field read through the reference, and a name that changes
      between two checks.
- [x] [ANL-003](../../spec/07-analysis.md#anl-003-filter) states the `named()`
      surface and its compile-time resolution.
- [x] `cargo test` passes, `node --test 'src/web/**/*.test.ts'` passes,
      `node_modules/.bin/tsc -p tsconfig.test.json` is clean, and `./build.sh`
      emits a `dist/` that loads.

## Non-goals

- Making names a core-owned analysis object. The web layer keeps ownership and
  `.heapa` persistence; the core holds a pushed copy, exactly as it does for
  tag labels.
- Matching several allocations by name. E010 makes that an error on purpose;
  a tag is the object for a set.

## Result

The channel was the missing half, as the grounding said. `hp_set_names` now
exists beside `hp_set_tag_labels` and parses exactly what the worker has been
sending all along — `[[event, "name"], ...]`, the shape of
`JSON.stringify([...UI.names.entries()])`. `names_arrive_as_the_worker_sends_them`
asserts that against a literal of that shape, including an escaped quote, so
the two ends cannot drift apart silently again. The `typeof` guard in
`worker.ts` is gone.

`named("x")` types as `Type::Allocation`, a reference rather than a value: it
has no equality and no ordering, so the only thing that gets anything out of it
is a field read, and a bare one fails as "must produce bool". Resolution
happens in `check`, so zero matches and several matches are both diagnostics
naming the count.

Two things worth recording:

**An unresolvable name has to surface its own diagnostic.** The first cut used
`check_type(base).is_ok_and(...)` to spot an allocation-typed base, which
swallowed the real error and reported "field access is not valid here" for
every bad name. It matches on the callee first and propagates with `?`.

**`receiver_before_dot` could only ever see one token** (`completion.rs`). It
took the last token before the dot and parsed that alone, which is why
`site.contains` completes and `named("x").` produced nothing at all. It now
walks back over a balanced parenthesis to the callee. That is a fix in the
filter-dsl crate, not the core, and it is why `named("x").` offers the
allocation fields.

The same limitation explains something in T027 that was passing for the wrong
reason: after `death.field.`, the receiver parsed is just `field`, so the keys
offered are the allocation catalog rather than the death one. Both are the same
catalog, so the completions are correct either way — but they are correct by
accident, not because the receiver was understood. It is not worth a ticket
until the two catalogs can differ.

[ANL-011](../../spec/07-analysis.md#anl-011-filtering-relative-to-a-named-allocation)
is the new requirement, including the rename behavior: the draft is re-checked
and an applied `named()` filter is re-applied; if it stops resolving, filtering
turns off with the diagnostic and **the editor text is left alone**. The first
cut called `applyFilterSource('')`, which clears the input — deleting the
source the user has to fix. `filterChanged()` was factored out of
`applyFilterSource` so both paths refresh the same way.

Verified: `cargo test` (six tests new here) and the filter-dsl suite,
`node --test`, `tsc`, `./build.sh`. The rename-then-re-apply path is web wiring
and was not driven in a browser, per D001; its core half is covered by
`a_rename_invalidates_a_filter_that_used_the_old_name`.
