---
id: T044
title: Tag scans track the tags in use, not the highest tag id
status: done
updated: 2026-08-07
---

# T044: Tag Scans Track the Tags in Use

## Outcome

`Store` answers "which tags does this event have?" without scanning every tag
bitset. A tag mutation no longer triggers two whole-trace rescans, and no tag
path's cost depends on which id a tag happened to get.

The language, the UI and `.heapa` do not change — this ticket is invisible
except in the numbers.

## Done when

- [x] `has_tags` is `O(1)`; `first_tag` and `tag_ids` scan at most the tags
      present in the event's 64-event block.
- [x] Tag counts are maintained incrementally. `tag_counts_json` serializes
      256 entries and scans no events.
- [x] `tag_free_idx` is not rebuilt by scanning: the free side is maintained
      through `death` at mutation time.
- [x] `tag_members` is written only by `add_tag`, `remove_tag`,
      `clear_event_tags`, `clear_tags`, and `Store::assert_tag_indexes`
      rebuilds every derived index from it and compares
      ([D009](../decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md)).
      A native test tags, untags, renames, deletes and clears, asserting after
      each.
- [x] [E020-bench](../explorations/E020-bench/tag_cost.rs) reruns and every
      column is flat across `H`: the `U=1 H=255` row is within 2× of the
      `U=1 H=1` row, where it is 206× today. Reported in the commit body
      against the before-table in
      [E020](../explorations/E020-tags-cost-tracks-the-highest-tag-id.md#evidence).
- [x] `cargo test` on both crates, `node --test 'src/web/**/*.test.ts'`, and
      `node_modules/.bin/tsc -p tsconfig.test.json` pass.
- [x] `./build.sh` emits, and the emitted `dist/` is diffed across the change
      ([D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)) — the
      web layer is untouched, so the bundle should be identical apart from the
      wasm blob.

## Result

The `U=1 H=255` row is now within 1.25× of `U=1 H=1` on every column, against
206× before. Enumeration on round-robin tagging is unchanged, as E020 said it
would be — `k = U` there, and `tag_ids` is ~13% slower than the old scan at
`U=32` scattered.

## Context

[E020](../explorations/E020-tags-cost-tracks-the-highest-tag-id.md) is the
measurement and the design; [D009](../decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md)
is the ownership rule.

Runs **before** [T041](T041-lower-the-filter-to-a-typed-plan.md): T041 requires
every predicate within 2× of a direct column scan, and `tags contains "x"`
cannot reach that over an `O(H)` enumeration however well the plan is lowered.
Compiling tag predicates to ids stays in T041.

## Non-goals

- Any change to the filter language, the evaluator, or the worker protocol.
- Removing the per-allocation `Vec` in `render.rs` as a goal of its own — E020
  measured it at 4% of the tag cost at `H=255`. It falls out of the `O(k)`
  enumeration or it does not; it is not a done-when.
- Re-indexing tag structures by creator ordinal (E020 §Not proposed).
- Truncating `tag_members` after deletion. The block index makes a stale high
  id cost nothing, which is the reason truncation was wanted.
