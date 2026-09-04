---
id: E014
title: Overlapping tags — cost model, semantics, and optimization options
status: settled
updated: 2026-07-31
---

# E014: Overlapping Tags — Cost Model, Semantics, and Optimization Options

## Summary

T015 changed tags from one `u8` per
event to overlapping memberships. The behavior is correct: adding tag `b` to
allocations selected by tag `a` preserves both memberships, both predicates
match, and `.heapa` persists both.

The new representation is a tag-indexed bitset:

```text
tag id -> one bit per event
```

This is compact and gives constant-time membership testing for a *known* tag.
The current consumers usually ask the inverse question — “which tags does this
event have?” — by scanning every tag bitset. That makes several whole-trace and
per-frame paths proportional to the highest populated tag id. With a few tags
this is unlikely to matter. With large traces and dozens or hundreds of tags,
it can.

This exploration records that cost and the non-performance implications. It
does not create a ticket or choose an optimization.

## Evidence boundary

This is a static cost analysis of commit `c9d76cb` plus the existing correctness
tests. No performance benchmark was run, so every latency claim below is an
inference from the loops and allocations in the current code, not a measured
regression.

Terms used below:

- `N` — total trace events, including non-creators;
- `C` — creator events (`M` and `R`);
- `H` — highest tag id represented by the outer membership vector;
- `U` — tags with at least one membership;
- `M` — total tag memberships across all allocations;
- `V` — allocations considered by one visible address-map frame.

`H` and `U` differ. Assigning tag 200 makes `H = 200` even if it is the only
populated tag. Deletion compacts user-facing ids through `hp_retag`, but the
outer vector is not currently truncated after its trailing bitsets become
empty.

## Current representation

`Store::tag_members` is `Vec<Vec<u64>>`, indexed by tag id. The inner vector is
allocated on the first membership in that tag and contains one bit per event
([store.rs](../../src/core/src/store.rs#L73-L76),
[store.rs](../../src/core/src/store.rs#L220-L239)).

This orientation has useful properties:

- `has_tag(event, known_tag)` is constant time;
- one populated tag costs one bit per event rather than one byte;
- an unused named tag has only an empty `Vec` header, not an event-sized bitset;
- export already wants tag-to-events lists, so the representation matches the
  `.heapa` shape;
- overlapping membership does not require a fixed 255-bit payload on every
  event.

The inverse operation, `tag_ids(event)`, scans `1..tag_members.len()` and checks
the event's bit in every tag
([store.rs](../../src/core/src/store.rs#L204-L217)). `has_tags(event)` and
`first_tag(event)` are both implemented through that scan.

## Memory cost

The membership payload is approximately:

```text
8 * ceil(N / 64) * U bytes
≈ N * U / 8 bytes
```

The old exclusive representation was approximately `N` bytes. The new payload
is therefore smaller through seven populated tags, equal at eight, and larger
above eight.

For a ten-million-event trace:

| Populated tags | Membership payload |
|---:|---:|
| 1 | 1.25 MB |
| 8 | 10 MB |
| 32 | 40 MB |
| 255 | 318.75 MB |

These figures exclude allocator capacity, the outer `Vec` headers, tag labels
and colors, timeline indexes, and serialized output. The outer headers are
small (at most roughly 6 KiB on a 64-bit target); the event-sized bitsets
dominate.

Creating the first membership in a tag resizes and zero-fills its entire
event-sized bitset. That first assignment is `O(N / 64)` in time and may visibly
pause on a very large trace even when only one allocation receives the tag.

`.heapa` size and export peak memory now scale with `M`, because an event id is
legitimately present in every tag list it belongs to. Export first builds 256
`Vec<u32>` lists and then writes JSON
([lib.rs](../../src/core/src/lib.rs#L907-L943)).

## Time cost by path

| Path | Current cost attributable to tags | When it runs |
|---|---:|---|
| Test a known membership | `O(1)` | `has_tag(e, id)` |
| Enumerate one event's tags | `O(H)` | details, rendering, tag expressions |
| Add membership to an already allocated tag | up to `O(H)` | `has_tags` before incrementing the tagged-event count |
| First membership in a tag | `O(H + N/64)` | bitset allocation and zero-fill |
| Clear all tags on one event | `O(H)` | allocation-panel replacement |
| Refresh all tag counts | `O(N * H)` | after every tag mutation |
| Rebuild timeline tag indexes | `O(N * H)` | lazily on the next timeline render after mutation |
| Export memberships | `O(N * H + M)` | save/autosave |
| Evaluate a filter that reads `tag` | `O(C * H)` plus string allocation | Apply |
| Draw the address map | `O(V * H)` plus temporary vectors | every dirty frame while tags exist |

Two costs compound after a mutation. `worker.ts::tagsChanged` immediately asks
the core to recompute counts, then marks the timelines dirty. Their next render
rebuilds the tag indexes. One click can therefore trigger two whole-trace
`O(N * H)` passes.

### Filter allocation

The expression evaluator exposes `tag` as an optional string to the type
checker, but constructs a fresh `Vec<String>` by cloning every matching label
for every creator event that evaluates the field
([filter_eval.rs](../../src/core/src/filter_eval.rs#L694-L703)). Equality, set
membership and string methods then apply “any member matches” semantics.

The semantics are useful, but the representation is expensive: the evaluator
already has numeric tag ids and constant labels, yet converts both sides to
owned strings inside the scan.

### Rendering allocation

Every considered allocation collects its tag ids into a fresh `Vec<u8>`, even
outside tag color mode, so the stripe can be painted
([render.rs](../../src/core/src/render.rs#L725-L744)). This is limited to the
frame's allocations rather than all `N`, but it puts both an `O(H)` scan and a
heap allocation on a render path.

The timelines preserve their width-bounded binary-search design after their
index is built. The expensive part is the lazy index rebuild, not every
subsequent column. Each lane pixel still uses only `first_tag`, so the lane does
not represent every overlapping membership
([timeline.rs](../../src/core/src/timeline.rs#L113-L136)).

## Semantic and UI implications

### Counts are memberships

The sum of per-tag counts may exceed the allocation count. That is correct for
overlapping groups, but the UI does not currently explain it. “Tagged
allocations” and “tag memberships” are now different quantities.

The status after **Tag matches** reports the number of filter matches processed,
not how many memberships were newly added. Repeating the same action can report
“tagged 100 allocations” while changing nothing.

### One body color cannot express a set

Tag color mode uses the lowest tag id as the allocation body color. The map's
stripe divides its width among every membership, but a stripe narrower than its
tag count cannot give each membership a distinct pixel; later fills can cover
earlier ones. Timeline lanes use only the lowest tag id. Hover and the allocation
panel do show the complete set.

This is not a data-loss bug, but “every tag is visible” is stronger than the
raster can guarantee at small sizes. The product needs a stated convention for
which surfaces summarize and which enumerate.

### The DSL has set semantics behind a scalar type

`tag` remains typed as `missing string`, while runtime evaluation may hold
several strings. Current behavior is:

- `tag == "a"` — true if any membership equals `a`;
- `tag != "a"` — true only if no membership equals `a`;
- `tag in {"a", "b"}` — true if any membership occurs in the set;
- string methods — true if any membership satisfies the method;
- ordering comparisons — true if any membership satisfies the ordering.

Equality and membership read naturally. Ordering a set of tag labels does not.
A future language version may want an explicit collection field or may want to
reject ordering on tags, but changing the requested `tag in {...}` surface is
not implied by this exploration.

### Comma-separated editing is ambiguous

The allocation panel joins tag names with `", "` and parses them with
`split(',')` ([main.ts](../../src/web/main.ts#L1800-L1808),
[main.ts](../../src/web/main.ts#L1843-L1853)). A tag name containing a comma can
still be created elsewhere but cannot be represented or edited correctly in
that field. The datalist also completes the whole input rather than an
individual membership after a comma.

This is a concrete UX regression, independent of performance. A chip/token
editor or a checkbox/popover list avoids inventing an escaping syntax.

### Compatibility

The `.heapa` schema needs no version change. Its tag-to-event map already
expresses overlap, and import now unions each list
([analysis.ts](../../src/web/heap/analysis.ts#L329-L333)).

The internal WASM ABI did change: `hp_tag_event(e, tag)` became
`hp_set_event_tags(e, count)`, and allocation info changed from `tag` to
`tags[]`. The bundled worker and web app move with the core, so the repository
is consistent. An external consumer of the C ABI would need to migrate.

Applied filter bits remain snapshots until Apply runs again. Adding or removing
a tag used by the visible filter source does not live-recompute that filter.
This predates overlapping tags, but overlap makes the distinction easier to
notice.

## Optimization options

These are separable changes, roughly ordered by expected leverage.

### 1. Add an any-tag union bitset

Maintain one event-indexed bitset containing the union of every tag. Then
`has_tags(event)` becomes `O(1)`, which removes the `H` scan from:

- tagged/untagged checks;
- first membership addition;
- tagged-event count maintenance;
- timeline index rebuild's yes/no decision;
- the tag-0 legacy filter path.

The cost is another `N/8` bytes and one bit update when the first membership is
added or the last is removed. A per-event membership count (`Vec<u8>`) would
also make the query constant time but costs `N` bytes; the union bitset matches
the existing representation better.

### 2. Maintain counts incrementally

Keep a 256-entry membership count array and update it in `add_tag`,
`remove_tag`, `clear_event_tags`, `clear_tags`, and retagging. The untagged
creator count can be updated when an event crosses between zero and one
memberships.

This turns every post-mutation count refresh from `O(N * H)` into `O(256)` JSON
serialization. The mutation methods are already the single write boundary, so
the invariant has one owner.

### 3. Compile tag predicates to ids

Resolve tag-label constants once when the filter is applied. Common expressions
such as equality and `in` can then test one or several known tag bitsets without
constructing `Vec<String>` values per creator.

String methods can first resolve which labels satisfy the constant method, then
test the corresponding ids per event. This keeps current “any membership”
semantics while removing owned strings from the scan.

### 4. Remove per-allocation render allocation

Render single-tag and untagged allocations without collecting. Only collect or
make a second iterator pass when an event actually has multiple memberships.
This still leaves an `O(H)` enumeration for overlapping stripes, but removes
the heap allocation in the common zero/one-tag case.

An auxiliary compact event-to-tags index could remove the scan too, but dynamic
updates make it a second authoritative membership structure. It should not be
added without measuring that the preceding changes are insufficient.

### 5. Compact trailing tag storage

After deletion/retag, drop empty trailing bitsets so `H` follows the actual
highest membership. This is small and safe, but it does not help when many
low-numbered tags are genuinely populated.

### 6. Replace comma-separated editing

Use tokens/chips or a selectable tag list in the allocation panel. This is a UX
fix, not an engine optimization, and should remain a separate ticket if chosen.

## Alternatives not preferred without measurement

**A fixed 256-bit set per event** makes enumeration constant-bounded and keeps
all membership state together, but costs 32 bytes per event unconditionally:
320 MB at ten million events even when no tags exist.

**A heap-allocated list per event** is proportional to actual membership, but a
`Vec` header per event is about 24 bytes before storing one tag, and millions of
small allocations are hostile to both memory and WASM allocation behavior.

**A second complete event-to-tags index** accelerates inverse queries but gives
membership two owners. It may be warranted after measurement, but the union
bitset, cached counts, compiled predicates, and render fast path address the
largest identified costs without duplicating the full relation.

The present tag-indexed bitsets are therefore a reasonable base. The question
is which small auxiliary indexes they earn.

## Benchmark plan

A useful benchmark must separate trace size, number of tags, and membership
density.

Matrix:

| Dimension | Values |
|---|---|
| Events | 1M, 10M |
| Populated tags | 1, 8, 32, 255 |
| Membership | sparse (1K/tag), dense (10% creators/tag), overlapping |

Measure:

1. first assignment into a new tag;
2. **Tag matches** over 1%, 10%, and 100% of creators;
3. the immediate count refresh;
4. the first timeline frame after mutation and the next cached frame;
5. Apply for `tag in {"a"}` and a multi-value set;
6. address rendering with no visible tagged allocation, one tag per visible
   allocation, and eight overlapping tags;
7. `.heapa` export time, output size, and peak WASM memory.

The benchmark should use release-native core code for repeatable CPU
measurements and one WASM/browser memory observation only if the native result
shows a problem. Per D001,
this exploration does not itself authorize building a browser harness.

## Open questions

- What trace size and tag count are representative of real use, rather than
  merely permitted by the 255-tag ceiling?
- Is tag creation latency already observable on the user's largest trace?
- Should the UI say “memberships” anywhere, or is overlapping count behavior
  obvious enough from the tag model?
- In tag color mode and timeline lanes, should lowest-id color remain the
  summary convention, should colors blend, or should overlap get a distinct
  visual treatment?
- ~~Should ordering operators be rejected for `tag` now that it is a set-valued
  field?~~ **Answered by T016** — see the correction below. Ordering on tags is
  gone, along with the scalar field it was defined on.
- Is the comma-name regression worth fixing immediately even if no performance
  work is selected?

## Correction, 2026-07-31

**The DSL sections of this document describe a language that no longer exists.**
They are left standing above as the analysis that was true on 2026-07-25;
T016 replaced it four days later.

Three claims are now wrong:

- **"The expression evaluator exposes `tag` as an optional string to the type
  checker"** (§Filter allocation) and **"`tag` remains typed as `missing
  string`"** (§The DSL has set semantics behind a scalar type). The field is
  `tags`, and `filter_eval.rs:99` types it
  `CheckedType::required(Type::Set(ValueKind::String))` — a required set, not an
  optional scalar. `is missing` now requires an optional operand rather than
  answering a constant for this field.
- **The behavior table** — `tag == "a"` meaning "any membership equals `a`",
  `tag != "a"`, `tag in {…}`, and string methods and ordering comparisons
  distributing over memberships. All of it is gone. `tags == {"a", "aa"}` is
  exact set equality, `tags contains "a"` is membership, and `tags == {}` is
  untagged. `Value::Strings` and its equality, ordering and string-method
  overloads were deleted with the scalar; `filter_eval.rs:758` builds a
  `Value::Set`.
- **The cost row "Evaluate a filter that reads `tag` — `O(C * H)` plus string
  allocation"** measured the `Vec<String>` clone-per-event path this document
  objected to. That path is the one T016 removed, so the row does not describe
  any code that runs. It has not been re-measured.

The rule the language now follows is
[ANL-009](../../spec/07-analysis.md#anl-009-filtering-by-tag).

**Nothing else in this document is corrected.** The storage cost model, the
`O(N * H)` refresh and rebuild passes, the rendering allocation, the counts-are-
memberships point, the one-body-color problem, and the comma-name ambiguity were
all about the engine and the UI rather than the language, and none of them was
touched by T016. They stand unmeasured.

## Outcome

**Settled: nothing was selected.** The overlapping model is correct and remains
in place. No optimization, benchmark, or UI ticket came out of this document,
and none is queued — the costs it identifies are real but were never observed
to hurt on a trace anyone actually opened, and `PROTOCOL.md` asks for a
measurement rather than an expectation before work is filed.

The one question here that did get answered was answered elsewhere and for a
different reason: T016 removed ordering on tags as a consequence of making
`tags` a set, not because this document asked.

What remains, if the cost ever shows up in use: the benchmark plan in
§Measurement is written and can be executed as filed, minus the `tag in {"a"}`
row, which no longer names a real expression. Re-open by filing a ticket with a
reproduction, not by re-opening this file.
