---
id: T015
title: Let allocations carry overlapping tags
status: done
updated: 2026-07-25
---

# T015: Let Allocations Carry Overlapping Tags

## Outcome

Adding a tag never removes another tag from the same allocation. Filters,
counts, rendering, the allocation panel, and `.heapa` persistence all observe
the complete membership set.

## Reproduction

1. Tag an allocation `a`.
2. Apply `tag in {"a"}`.
3. Use **Tag matches** to add tag `b`.
4. Before this ticket, `a` reports zero events because the single tag id was
   replaced by `b`.

## Done when

- [x] The exact reproduction leaves the allocation in both `a` and `b`, and
  both tag predicates match it.
- [x] Counts and `.heapa` export/import preserve overlapping memberships.
- [x] The allocation panel shows and edits the complete tag set.
- [x] The map exposes every membership rather than silently hiding all but one.
- [x] Core, DSL, web, typecheck, and build checks pass.

## Compatibility

Existing `.heapa.json` files remain valid: their tag-to-event lists are already
capable of expressing overlap. Import now unions those lists instead of letting
the last list replace earlier membership.

## Result

The store now owns sparse tag-to-event membership bitsets. Range tagging,
filter-to-tag, and analysis import add membership; deleting a tag removes only
that membership. The filter evaluator treats `tag` comparisons, set membership,
and string methods as “any membership matches.” Counts and export enumerate
every membership.

Allocation payloads carry `tags: number[]`; the panel edits comma-separated
names, hover shows every tag, and overlapping memberships split the map stripe
into adjacent colors. The regression performs the reported `a` → filter →
`b` sequence and asserts both predicates, counts, and exported lists.

Verification:

```text
cargo test --manifest-path src/core/Cargo.toml              41 passed
cargo test --manifest-path src/filter-dsl/Cargo.toml        23 passed
node --test 'src/web/**/*.test.ts'                           7 files passed
npx tsc -p tsconfig.test.json                                passed
./build.sh                                                   passed
git diff --check                                             passed
```
