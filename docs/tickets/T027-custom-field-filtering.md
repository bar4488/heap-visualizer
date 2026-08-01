---
id: T027
title: Custom trace fields are filterable
status: done
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

- [x] `field.<ident>` and `field["<any key>"]` type-check against the catalog:
      a key observed as one scalar type gets that type and is **optional**
      (absence and JSON `null` are both missing); a key never observed is a
      diagnostic naming it; a key observed with two scalar types, or observed
      only as an object/array, is a diagnostic saying so.
- [x] `death.field.<ident>` and `death.field["k"]` resolve against the *death*
      event's fragment, and are missing when the allocation is never freed.
- [x] Evaluation resolves each referenced key once per distinct interned
      fragment, not once per event.
- [x] `is missing` / `is not missing` work on a custom field, per
      [ANL-003](../../spec/07-analysis.md#anl-003-filter)'s rule that the test
      requires an optional operand.
- [x] Completion offers `field.` at expression position and the observed keys
      after it, with the observed type as detail; observed *values* are offered
      as operands the way `site` and `thread` already are
      (`filter_eval.rs:observed_items`). A key that failed to type is never
      offered — ANL-003 requires that completion not advertise what the
      evaluator will reject.
- [x] `check`/`evaluate` take one context value carrying tag labels and
      resolved fields, not a growing argument list.
- [x] Native tests cover: each of the four spellings above, a missing key, a
      mixed-type key, a null value, a non-scalar value, and `death.field`
      on a never-freed allocation.
- [x] [ANL-003](../../spec/07-analysis.md#anl-003-filter) states the custom
      field surface and its missing/diagnostic rules.
- [x] `cargo test` passes, `node --test 'src/web/**/*.test.ts'` passes,
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

## Result

The whole change is in the semantic layer, as the grounding predicted: no
lexer or parser change was needed, and the two "not available yet" arms became
real ones.

**`Ctx` replaced the argument list.** `check(expr, ctx)` and
`evaluate(expr, ctx, e)` now carry the store, the tag labels, and the resolved
field values as one value. `Ctx::new` is enough to check or complete —
checking never reads a value — and `with_fields` adds what evaluation needs.
T028 adds names to the same struct rather than a fifth parameter.

**Resolution is per fragment.** `FieldValues::resolve` walks the expression for
referenced keys, then scans each distinct interned fragment once, reading every
wanted key in that one pass. `hp_filter_apply` builds it before the scan, so
the per-event loop does no JSON parsing at all.
`custom_field_values_resolve_once_per_fragment` pins the property: two hundred
events over two distinct fragments resolve two rows.

**`null` is missingness, not a type.** A key seen holding `null` and integers
is a filterable optional integer; only two *scalar* types, or an object or
array, make it untypable. The diagnostic names the shapes it actually saw
rather than saying "unsupported".

Two things the ticket did not anticipate, both now spec'd in
[ANL-010](../../spec/07-analysis.md#anl-010-filtering-on-custom-trace-fields):

- **A bare `field` or `death.field` had to say something useful.** Both used to
  fall through to "unknown field" or "unknown death field `field`", which is
  wrong — the user has started a reference, not misspelled a field. Each now
  names the spelling it wants.
- **Bracket keys cannot be completed after a `.`.** `field.` offers only
  identifier-shaped keys, because that is what can legally follow the dot the
  user already typed. A key like `allocator-class` is filterable, checked, and
  evaluated, but is discoverable through the Filter panel's catalog listing
  (T029) rather than through completion. `completion_offers_custom_fields_and_their_values`
  asserts the exclusion so it stays deliberate.

Not covered: the `hp_filter_apply` and `hp_filter_check` externs themselves.
They read the `app()` global and no test in this repository drives an `hp_`
export directly, so the tests exercise `check`/`evaluate`/`push_completions_json`
under them. What that leaves unverified is the wiring inside those two
functions, which is where `FieldValues::resolve` is called.

Verified: `cargo test` (seven tests new here), `node --test`, `tsc`,
`./build.sh`. Not driven in a browser, and there is no trace in the repository
carrying custom fields to drive it with — `gen.py` does not emit any. T029
needs one and will write it.
