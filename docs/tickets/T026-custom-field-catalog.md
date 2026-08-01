---
id: T026
title: The core collects a catalog of custom trace fields
status: todo
updated: 2026-08-01
---

# T026: The Core Collects a Catalog of Custom Trace Fields

## Outcome

The store carries a catalog of the caller-defined top-level fields observed in
the trace — each field's name, the scalar types it was seen holding, and how
many creator events carry it — and the web layer can read it.

This is the foundation [T027](T027-custom-field-filtering.md) type-checks
against and [T029](T029-custom-fields-in-the-ui.md) displays. It changes no
user-visible behavior on its own.

## Context

Custom fields reach the store today as **raw JSON text**. `parse.rs` collects
each event's unrecognized top-level keys into one object-body fragment,
interns it, and keeps an index per event:

```rust
// store.rs:62
/// Index into `extras` of this event's caller-defined JSON fields
/// (unrecognized top-level keys), interned as a raw JSON object body
/// fragment; NONE_U32 = none. Lazy column; read via `extra_at`.
pub extra: Vec<u32>,
...
pub extras: Vec<String>,           // store.rs:98
```

Nothing parses those fragments in the core. `render.rs:1082` splices the
fragment straight into the allocation-info JSON, and the web layer is the only
thing that has ever read the keys.

[E010](../explorations/E010-filter-expression-language.md) asserts that "during
trace parsing, the core collects field names and observed scalar types" and that
"a referenced key with incompatible observed types is a compile error". **That
collection does not exist.** E010 was written before any of the language
shipped; this ticket is what makes that sentence true.

**The fragments are interned and deduplicated**, which is the property that
makes this cheap: distinct fragments are far fewer than events, so the catalog
is built by scanning each *unique* fragment once, not each event.

## Done when

- [ ] `Store` carries a catalog: for each observed key, the set of scalar
      types seen (`null`, bool, int, string), and a count of creator events
      carrying it. Nested objects and arrays are recorded as a non-scalar
      observation, not omitted — T027 needs to tell "absent" from "present but
      unfilterable".
- [ ] The catalog is built from the interned `extras` fragments, scanning each
      distinct fragment once rather than once per event.
- [ ] A native test asserts a trace with `{"pool":"gfx","refs":3}` on some
      events and `{"pool":"ui"}` on others yields `pool` (string, 2 counts) and
      `refs` (int, 1 count), and that a key holding both `3` and `"x"` is
      recorded with both types.
- [ ] A native test asserts a trace with no custom fields yields an empty
      catalog and allocates nothing for it.
- [ ] `hp_fields_json` returns the catalog, and `src/web/protocol.ts` types it.
- [ ] `cargo test` passes; `./build.sh` emits a `dist/` that loads.

## Non-goals

- Type-checking, evaluating, or completing `field.*`. That is T027.
- Any UI. That is T029.
- Materializing a per-event column. Values stay in the fragments until a filter
  references them; the resolution strategy is T027's problem.
