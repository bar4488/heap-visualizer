---
id: E020
title: Tag cost tracks the highest tag id ever used, not the tags in use
status: settled
updated: 2026-08-07
---

# E020: Tag Cost Tracks the Highest Tag Id Ever Used

## Summary

[E014](E014-overlapping-tags-cost-model.md) predicted that the tag paths scale
with `H`, the highest populated tag id, and settled without selecting anything
because nothing had been measured. This is the measurement.

`H` is confirmed, and the discriminating case is worse than E014 guessed: **one
tag at id 255 is slower than 255 tags**, because `Store::tag_ids` scans the
empty ids before reaching the populated one. After that, a single tag click
spends **~0.5 s** in two whole-trace rescans, native release, on a trace a
quarter the size of the one E010 gates the filter against.

Two of the costs E014 named, and two this document's author predicted, are not
real. They are listed below and dropped.

## Evidence

[E020-bench/tag_cost.rs](E020-bench/tag_cost.rs) carries the recipe. Native
release, 999,936 events / 500,000 creators, one tag per creator, median of 5.
Milliseconds:

| U tags / high id | `has_tags` | `first_tag` | `tag_ids` | counts | tl index | render | k mean / max |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| U=1 H=1 | 0.7 | 0.8 | 0.8 | 1.6 | 2.0 | 2.4 | 1.00 / 1 |
| U=8 H=8 | 2.9 | 3.0 | 5.3 | 10.3 | 7.7 | 7.4 | 1.00 / 2 |
| U=32 H=32 | 12.7 | 12.8 | 23.6 | 39.6 | 29.3 | 27.7 | 1.00 / 2 |
| U=255 H=255 | 89.5 | 89.7 | 176.8 | 269.0 | 180.0 | 184.6 | 1.01 / 2 |
| **U=1 H=255** | **144.2** | **143.8** | **143.9** | **288.7** | **289.0** | **145.5** | 1.00 / 1 |
| U=8 H=8 scattered | 3.0 | 3.0 | 5.3 | 10.6 | 7.8 | 7.7 | 8.00 / 8 |
| U=32 H=32 scattered | 12.0 | 12.1 | 23.8 | 35.9 | 25.2 | 23.1 | 32.00 / 32 |

`k` is distinct tags present per 64-event block — the quantity a per-block
occupancy index would scan in place of `H`. "Scattered" assigns tags
round-robin over creators; the other rows give each tag one contiguous run,
which is what tagging a range or a filter match set produces.

### What the rows say

**Cost is `H`, not `U`.** `U=1 H=255` and `U=1 H=1` hold one tag and the same
memberships. The first is **206× slower** on `has_tags` (144.2 ms vs 0.7 ms).
Using tag id 255 once, then deleting it, taxes every subsequent scan for the
life of the process: `add_tag` grows `tag_members` and nothing ever truncates
it.

**Sparse-high is worse than dense-full.** `U=1 H=255` beats `U=255 H=255` on
every column. With 255 populated tags the scan finds a hit at id ~127 on
average and stops; with one tag at id 255 it walks all 254 empty slots first.
The worst case is not many tags — it is one unlucky id.

**A tag click costs about half a second.** `worker.ts::tagsChanged` triggers the
count refresh, then dirties the timelines, whose next frame rebuilds the index:
289.0 + 289.0 ms at `H=255`, native, at 1M events. Both are `O(N·H)` and both
run per mutation. This is the finding with a user in front of it.

**Locality holds where it was claimed, and fails where predicted.** Clustered
tagging gives `k` mean 1.00, max 2 — a per-block index would scan one tag where
the current code scans `H`. Round-robin gives `k = U` exactly. So the block
index converts `H → ~1` on realistic tagging and `H → U` on adversarial
tagging, and is never worse than a `U`-scan. Real tagging sits between; the
guarantee is the `U` bound, and the common case is the 1.

## What the measurement killed

Four costs named in E014 or in the design that produced this document do not
survive contact with the bench, and the proposed work does not address them:

- **First membership in a new tag** — E014 called the `O(N/64)` zero-fill a
  possible visible pause. It is **0.01 ms**. It is a memset; drop it.
- **The per-allocation `Vec` in `render.rs`** — predicted as the render cost.
  Comparing `tag_ids` to `render` isolates it: 176.8 → 184.6 ms at `H=255`, a
  4% difference, and 17% at `H=32`. **The scan is the cost, not the
  allocation.** Removing the `Vec` without removing the scan buys nothing.
- **`first_tag` being cheaper than full enumeration** — it is not. Both go
  through the same scan and measure the same (89.5 vs 89.7 at `H=255`).
- **Scattered tagging being slower than clustered** — it is not, in the current
  code, because the current code has no locality to lose. The scattered rows
  matter only as the bound on the proposed index.

The render row also **overstates** what a frame pays: it enumerates all 500,000
creators, where a real frame touches only the visible `V`. Read it as an upper
bound and as the per-allocation ratio, not as a frame time.

## Proposal

Keep `tag_members` as the single owner of membership. It is already the compact
form and the right orientation for export and for known-tag tests. Add three
derived indexes, maintained `O(1)` at the four existing mutation methods:

| Index | Size | Buys |
|---|---|---|
| `any: Vec<u64>` — union of every tag | N/8 | `has_tags` in `O(1)` |
| `block_tags: Vec<[u64; 4]>` — 256-bit tag mask per 64-event block | N/2 | `tag_ids` / `first_tag` in `O(k)`, `k ≤ U` |
| `free_any: Vec<u64>` — `any` projected through `death` | N/8 | the free-lane index never rebuilds |
| `counts: [u32; 256]` | 1 KB | count refresh `O(1)` to maintain |

About **0.625 bytes per event, flat, independent of tag count** — ~6 MB at 10M
events. The membership payload is unchanged, so E014's 8-tag memory crossover
still stands.

Removal stays `O(1)`: a block bit clears only when `tag_members[t][e/64] == 0`,
one word read rather than a scan.

### Not proposed

**Indexing the tag structures by creator ordinal instead of event index.**
`tag_members` reserves a bit for every `F` and `E` record, which can never be
set, and `green_pre[e]` already gives the dense creator ordinal in `O(1)`
(`parse.rs:472`). It would halve the membership payload and change no
complexity class. Declined on 2026-08-07 as a constant factor not worth the
call-site churn while an `H`-shaped cost is on the table. The inverse direction
(ordinal → event) has no `O(1)` answer without a C-sized select table that
costs more than the saving below `U≈32`.

## Derived artifacts

- [D009](../decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md)
  — the ownership rule the three indexes live under.
- T044 — the work.
- T041 already owns
  compiling tag predicates to ids; this document does not duplicate it, and
  T044 runs first because T041's `tags contains` row cannot reach its 2× bar
  over an `O(H)` scan.

## Outcome

**Selected.** E014's cost model was right about the shape and wrong about which
costs would hurt; the half-second stall on a tag click is the one that does,
and it was invisible to static analysis because it comes from two `O(N·H)`
passes triggered by one click rather than from any single expensive call.

The bench is the acceptance harness for T044, not just its justification: every
row above is a before, and the same rows are the after.
