---
id: D009
title: Tag membership has one owner; every other tag structure is a derived index
created: 2026-08-07
---

# D009: Tag Membership Has One Owner

## Decision

`Store::tag_members` is the **sole authority** on which allocations carry which
tags. `any`, `block_tags`, `free_any` and `counts` are **derived indexes**: they
answer faster, they never answer differently, and nothing may read them as a
source of truth.

Three constraints follow:

1. **All four are written only by the tag mutation methods** — `add_tag`,
   `remove_tag`, `clear_event_tags`, `clear_tags`. That set is the write
   boundary. A new mutation path adds itself to those methods or goes through
   them; it does not touch `tag_members` directly.
2. **A debug assertion rebuilds all four from `tag_members` and compares.**
   `Store::assert_tag_indexes` exists for that and runs in the native tests.
3. **A derived index is never persisted.** `.heapa` carries tag-to-event lists
   and nothing else; the indexes are rebuilt on load like any other cache.

## Why

The measured problem ([E020](../explorations/E020-tags-cost-tracks-the-highest-tag-id.md))
is that the inverse query — "which tags does this event have?" — scans every
tag bitset, so cost tracks the highest tag id ever used rather than the tags in
use. One tag at id 255 measured 206× slower than the same tag at id 1, and one
tag click spends ~0.5 s in two `O(N·H)` rescans.

The fix is an index, and an index is a second copy of a relation. **The failure
mode of a second copy is not slowness, it is silence**: a mutation path that
updates `tag_members` and forgets `block_tags` makes tags vanish from the
address map and from filter results, with no error and nothing in the UI to
suggest the data is still there. That is strictly worse than the stall being
fixed, which is why the write boundary and the assertion are part of the
decision rather than implementation detail.

E014 considered "a second complete event-to-tags index" and declined it for
giving membership two owners. This decision is what makes the smaller indexes
admissible where that one was not: they are derivable, they are checked, and
they are written in one place.

## Rejected

**A fixed 256-bit set per event.** Constant-bounded enumeration, but 32 bytes
per event unconditionally — 320 MB at 10M events with no tags in use. The
derived indexes cost ~0.625 bytes per event, flat.

**A heap-allocated tag list per event.** Proportional to real membership, but a
`Vec` header is 24 bytes before storing one tag, and millions of small
allocations are hostile to WASM.

**Indexing tag structures by creator ordinal rather than event index.** Halves
the membership payload and changes no complexity class; declined as a constant
factor, with the reasoning and the `green_pre` mapping recorded in
[E020](../explorations/E020-tags-cost-tracks-the-highest-tag-id.md#not-proposed).
