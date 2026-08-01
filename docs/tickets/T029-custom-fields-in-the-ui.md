---
id: T029
title: Custom trace fields are a first-class surface in the UI
status: done
updated: 2026-08-01
---

# T029: Custom Trace Fields Are a First-Class Surface in the UI

## Outcome

An allocation's custom fields are their own labelled, type-aware section of the
allocation panel, and each one can be turned into a filter predicate in one
click. The Filter panel lists the trace's whole field catalog, so a user can see
what is filterable without clicking an allocation first.

## Context

Custom fields are displayed today, and that is all. `buildDetailBody` appends
them as bare rows after the stack:

```ts
// main.ts:1817
if (info.extra) {
  for (const [k, v] of Object.entries(info.extra)) {
    html += `<div class="row"><span class="k">${esc(k)}</span><span>${esc(
      typeof v === 'string' ? v : JSON.stringify(v))}</span></div>`;
  }
}
```

They use the same `.row`/`.k` styling as `id`, `size` and `site`
(`style.css:544`), so a producer's `pool` is indistinguishable from a built-in
field, and `.k` is a fixed 64px, which a key like `allocator-class` overruns.
Values are `JSON.stringify`'d without regard to type.

The data arrives as `info.extra`, spliced into the pick JSON by
`render.rs:1082` straight from the interned fragment.
[ANL-006](../../spec/07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows)
already requires "extra wire-format fields" in the panel; it does not say how.

**Click-to-filter is an established gesture here, not a new one.** The legend
chips already write a predicate and apply it
([ANL-003](../../spec/07-analysis.md#anl-003-filter),
[E013](../explorations/E013-filter-actions.md)), and `filter-actions.ts` owns
the pure source rewrites with tests behind them. A field chip is the same
action with a different predicate, and it must escape its value as a DSL
literal the way the existing ones do.

The catalog to list in the Filter panel is [T026](T026-custom-field-catalog.md)'s,
read through `hp_fields_json`.

## Design, decided 2026-08-01

The panel section, as chosen:

```text
  born   seq 1,204 · t 2.10ms
  dies   seq 3,110 · t 5.02ms
  stack  main ‹ run ‹ alloc
 ── trace fields ─────────────
  pool             "gfx"   ⊙
  refcount             3   ⊙
  allocator-class  "slab"  ⊙
        ⊙ = filter by this value
```

- Separated from the built-in rows by a labelled rule, so a producer's data is
  never mistaken for the engine's.
- Values styled by observed type: numbers accented, strings quoted and plain,
  bool and null dim. Non-scalar values (objects, arrays) render as compact JSON
  and carry **no** filter affordance — T027 cannot filter them.
- The key column sizes to the widest key in this allocation rather than the
  built-in fixed 64px.
- The filter action writes `field.<key> == <literal>` for an identifier-shaped
  key and `field["<key>"] == <literal>` otherwise, then applies — one gesture,
  as E013 settled for chips.

## Done when

- [x] The allocation panel renders custom fields as the section above, in both
      the detail panel and pinned windows (`buildDetailBody` serves both).
- [x] A key that is not identifier-shaped, a value that is a string containing
      `"` or `\`, and a non-scalar value each render and behave correctly; the
      generated predicate is escaped as a DSL literal.
- [x] Clicking a field's action sets and applies a filter matching that field
      and value, using the same apply path as the legend chips.
- [x] The Filter panel lists the trace's field catalog — name, observed type,
      event count — and a field there can be inserted into the expression.
      A trace with no custom fields shows no empty section anywhere.
- [x] The predicate-writing functions are pure and covered in
      `src/web/test/filter-actions.test.ts`, including the escaping and
      bracket-key cases.
- [x] [ANL-006](../../spec/07-analysis.md#anl-006-the-allocation-panel-and-pinned-windows)
      states the section and the click-to-filter action;
      [ANL-003](../../spec/07-analysis.md#anl-003-filter) states the catalog
      listing.
- [x] `node --test 'src/web/**/*.test.ts'` passes,
      `node_modules/.bin/tsc -p tsconfig.test.json` is clean, `cargo test`
      passes, and `./build.sh` emits a `dist/` that loads.

## Non-goals

- A dedicated Fields panel. The catalog lives in the Filter panel, where
  expressions are written; a new panel would touch SHELL-006 and the default
  layout for data that is most useful next to the editor.
- Editing custom fields. They are trace data, not analysis.
- A custom-field column in the Events panel, or coloring the map by a custom
  field. Both are real ideas and neither is this ticket.

## Verification

Per [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) the cheap
checks are run by an agent and the rendered result is not driven in a browser.
`traces/` needs a trace carrying custom fields to look at; check whether one
exists before writing one.

## Result

The section is as designed, with the type styling and the per-field action.
Three things are worth recording.

**The render function moved out of `main.ts`.** `customFieldsSection` is pure —
allocation info in, HTML out — and its escaping and type rules are exactly the
parts worth asserting, but nothing can import `main.ts`. It lives in
`src/web/heap/custom-fields.ts` with its own test file, which is what covers
the bracket key, the string carrying `"` and `\`, and the object and array
cases. Without the move those three would have been claimed and not checked.

**A fractional number is shown and not filterable.** JSON has one number type
and the language has integers, so `1.5` has no literal to compare against.
`customFieldPredicate` returns null for it and the row gets the same inert
marker as an object. This was not in the design and is not a limitation worth
lifting until someone has such a trace.

**`--fields` was added to `gen.py` rather than a trace file being committed.**
There was no trace with custom fields, as the ticket suspected. A flag on the
existing generator gives a reproducible one at any size, and the field set is
deliberately varied — string, integer, non-identifier key, sometimes-null,
nested object — so it exercises every branch of the section and of ANL-010.
It is off by default and output without it is byte-identical to output from
before the flag existed, verified by generating the same seed from
`git show HEAD:gen.py` and `cmp`. [TOOL-001](../../spec/10-tooling.md#tool-001-genpy--synthetic-trace-generator)
records the knob.

The catalog reaches the Filter panel on the `loaded` notification, since it is
a per-trace fact the load pass settles. A field the language cannot address is
listed and **disabled** rather than hidden: it explains why completion does not
offer a key the user can see in the allocation panel.

Verified: `node --test` (six tests new here plus four in `filter-actions`),
`tsc`, `cargo test`, `./build.sh`, the emitted `dist/` carries the new module,
markup and styles, and `grep -ric heap src/web/shell/` is still 0 for every
file. Per D001 the rendered geometry and the click paths were not driven in a
browser; `python3 gen.py --fields` produces a trace to look at.
