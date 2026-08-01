---
id: T027
title: Custom trace fields are filterable
status: todo
updated: 2026-08-01
---

# T027: Custom Trace Fields Are Filterable

## Outcome

`field.pool == "gfx"`, `field["allocator-class"] == "slab"`,
`field.refcount >= 3` and `death.field.reason == "shutdown"` check, evaluate,
and complete against the [T026](T026-custom-field-catalog.md) catalog. A key
the trace never carried is a diagnostic naming it, not a silent false.

## Context

The front end is already done. `parser.rs:218` builds `ExprKind::Field` for dot
access and `parser.rs:234` builds `ExprKind::Index` for bracket access; the
lexer has had `[`/`]` since it was written (`lexer.rs:116`). Both syntaxes
parse today and die in the semantic layer:

```rust
// filter_eval.rs:203, in check_type
ExprKind::Index { .. } => Err(EvalError::at(expr, "custom fields are not available yet")),
// filter_eval.rs:172, in check_type — `field.pool` lands here
} else { Err(EvalError::at(expr, "field access is not valid here")) }
```

with the same pair repeated in `eval` at `filter_eval.rs:869` and `:903`.

**Values live in interned raw JSON fragments**, one per distinct extras
combination, indexed per event by `store.extra_at(e)` (T026). Since fragments
are deduplicated, a referenced key resolves to one value per *fragment*, not per
event — so a filter referencing `field.pool` can resolve the key once per
distinct fragment and then index by `extra_at(e)`. Do that rather than scanning
JSON inside the per-event loop; `hp_filter_apply` (`lib.rs:607`) already walks
every creator event once and the scan must not become quadratic in fragment
size.

`evaluate` and `check` currently take `(&expr, &store, e, &labels)`. Resolved
field values are a third context value, and `named()`
([T028](T028-named-resolves-an-allocation.md)) will be a fourth. **Introduce one
context struct rather than a fourth positional argument** — call sites are
`lib.rs:600`, `lib.rs:638` and the native tests.

## Done when

- [ ] `field.<ident>` and `field["<any key>"]` type-check against the catalog:
      a key observed as one scalar type gets that type and is **optional**
      (absence and JSON `null` are both missing); a key never observed is a
      diagnostic naming it; a key observed with two scalar types, or observed
      only as an object/array, is a diagnostic saying so.
- [ ] `death.field.<ident>` and `death.field["k"]` resolve against the *death*
      event's fragment, and are missing when the allocation is never freed.
- [ ] Evaluation resolves each referenced key once per distinct interned
      fragment, not once per event.
- [ ] `is missing` / `is not missing` work on a custom field, per
      [ANL-003](../../spec/07-analysis.md#anl-003-filter)'s rule that the test
      requires an optional operand.
- [ ] Completion offers `field.` at expression position and the observed keys
      after it, with the observed type as detail; observed *values* are offered
      as operands the way `site` and `thread` already are
      (`filter_eval.rs:observed_items`). A key that failed to type is never
      offered — ANL-003 requires that completion not advertise what the
      evaluator will reject.
- [ ] `check`/`evaluate` take one context value carrying tag labels and
      resolved fields, not a growing argument list.
- [ ] Native tests cover: each of the four spellings above, a missing key, a
      mixed-type key, a null value, a non-scalar value, and `death.field`
      on a never-freed allocation.
- [ ] [ANL-003](../../spec/07-analysis.md#anl-003-filter) states the custom
      field surface and its missing/diagnostic rules.
- [ ] `cargo test` passes, `node --test 'src/web/**/*.test.ts'` passes,
      `node_modules/.bin/tsc -p tsconfig.test.json` is clean, and `./build.sh`
      emits a `dist/` that loads. Not `npx tsc`
      ([T021](T021-live-docs-drop-npx-tsc.md)).

## Non-goals

- Nested object and array access. E010 bounds the first version to scalars, and
  the Allocation panel still displays the rest.
- `named()`. That is T028.
- Any change to how custom fields are *displayed*. That is T029.
- The persisted filter language version. Adding a field surface does not
  invalidate a stored version-2 source; nothing that parsed before stops
  parsing.
