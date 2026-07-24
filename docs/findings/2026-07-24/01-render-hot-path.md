# 01 — The render hot path

[08-architecture §8.1](../../../specs/08-architecture.md) states the rule this
section is about:

> **Nothing per frame may be O(live set).** Rendering enters the
> address-ordered live set by binary search at the first visible row (bounded
> below by the trace's largest span, exactly like hit-testing) and stops past
> the last visible one, so a frame costs O(visible + log live) no matter how
> large the live set grows.

The intent is right and the binary-search entry is really there. But the bound
is stated in terms of *the trace's largest span*, and that quantity is a global
worst case that one allocation can inflate for the whole session — so the frame
cost is not O(visible + log live) in practice. F1 and F2 are two independent
ways the rule is broken; F3 is a third per-frame cost the rule does not mention
at all.

## Measurement

Same trace, same viewport, varying only whether one large allocation exists
anywhere in the trace. The viewport shows **76 rows** containing **70 live
allocations**; 50,000 allocations are live overall.

| | ms/frame | row-loop iterations | of which off-screen | `draw[]` entries |
|---|---|---|---|---|
| no large allocation | 1.46 | 70 | 0 | 70 |
| one 16 MiB allocation | 3.39 | 6,677 | **6,530** | **3,068** |
| one 64 MiB allocation | 3.35 | 6,677 | 6,530 | 3,068 |

A single allocation, which may be nowhere near the viewport and may have been
freed long ago in playhead terms, costs **2.3× frame time** — permanently,
because `Store::max_span` only ever grows. 16 MiB and 64 MiB read the same here
only because the walk-back saturates at address 0 in this layout; with the
viewport further down the address space the 64 MiB case is worse.

The two amplifications are separable: 6,530 wasted row iterations (F1) and
3,068 allocations collected and sorted to draw 70 (F2).

---

<a id="f1"></a>

## F1 — Per-allocation row loop never clips to the visible range

**Fixed** in `2825b31` ("F1: clip per-allocation row walk to the visible
range"). Both loops now start at `j.max(vis_lo)`, exactly the fix proposed
below.

**Where** `core/src/render.rs:702` (pass 2), and the same pattern at
`core/src/render.rs:878` (the ghost pass).

**What** The loop walking an allocation's rows starts at the allocation's
*first* row and steps one row at a time until it reaches the viewport,
discarding each with `continue`:

```rust
let j = v.rows.partition_point(|&r| r < r0);   // first row of the allocation
// ...
let mut idx = j;
while idx < v.rows.len() && v.rows[idx] <= r1 {
    let y = v.row_y(idx, row_px, gap_px) as i64 - scroll as i64;
    idx += 1;
    if y + (row_px as i64) < 0 || y >= h as i64 {
        if y >= h as i64 { break; }
        continue;                               // ← every row above the viewport
    }
    // ...
}
```

The exit past the bottom is a `break`, so the *trailing* half is bounded. The
*leading* half is not: a 16 MiB allocation over 4 KiB rows costs 4,096
iterations per frame, every frame, to draw nothing.

**Why it matters** It is linear in the size of the largest allocation
overlapping the viewport, which is exactly the case the address map exists to
show. It also scales with row count, so shrinking `row_bytes` to inspect a
large buffer makes it worse in the moment the user most wants smooth panning.

**Fix** One line. The value needed is already computed ~10 lines above for
label placement:

```rust
let mut idx = j.max(vis_lo);
```

`label_target` is already clamped to `vis_lo`, and `Frame::seam` clamps its own
y-range, so nothing downstream depends on entering the loop above the viewport.
Verify against `size_label_on_middle_row`, which asserts label placement for a
multi-row allocation. Apply the same clamp to the ghost pass, which has the
identical shape.

---

<a id="f2"></a>

## F2 — Live-set walk is bounded by `max_span`, a global worst case

**Fixed** in `1fd15c5` ("F2: bound the render live-set walk by the widest
live allocation") — option 1 from the fix list below. `View` now keeps a
`span_counts` multiset (same shape as `birth_counts`) maintained in
`insert_alloc`/`remove_alloc`, exposed as `max_live_span()`, and both the
per-frame render walk and `inside_one_alloc`'s gap check use it instead of
`Store::max_span`. `pick` and `live_at_addr` were left on the conservative
bound, as the fix note suggests.

**Where** `core/src/render.rs:644`, and the identical idiom in `pick`
(`render.rs:940`), `live_at_addr` (`lib.rs:853`), `inside_one_alloc`
(`render.rs:493`) and the load-time overlap check (`parse.rs:408`).

**What**

```rust
let floor = addr_lo.saturating_sub(s.max_span.max(1));
for &(a, e) in v.live.range((floor, 0)..(addr_hi, 0)) { /* push to draw[] */ }
draw.sort_unstable();
```

`max_span` is the largest rendered span *over the entire trace*
(`parse.rs:429`), and it never decreases. So the walk starts `max_span` below
the viewport regardless of whether anything that wide is live, near, or ever
reaches these rows. Measured: 3,068 entries collected and sorted per frame to
draw 70 — a 44× amplification, from one allocation.

**Why it matters** This is the mechanism the spec cites as the reason frames
are O(visible + log live). It holds only for traces whose largest allocation is
small, which is the opposite of the interesting case. The cost is per frame and
compounds with F1 (each of those 3,068 also runs the F1 loop).

**Fix** Options, cheapest first:

1. Bound by the widest *currently live* allocation instead of the trace-wide
   maximum — a max tracked in `View` alongside `live_bytes`, which is already
   maintained incrementally on insert/remove. Removal needs a multiset (the
   same shape as `birth_counts`) to avoid a rescan.
2. Keep a per-row "widest allocation overlapping this row" summary, so the
   walk-back is bounded by what actually reaches the visible rows.

Option 1 fixes the common case (one big arena block, freed early) with
machinery that already exists in `View`. Note that `pick` and `live_at_addr`
share the bound but run once per interaction, not per frame — they can keep the
conservative version.

---

<a id="f3"></a>

## F3 — `ensure_rows()` fully rebuilds on every seek

**Fixed** in `c789075` ("F3: stop rebuilding the row layout on every seek") —
fixes 1 and 2 from the list below (not 3, which was optional). `seek` only
sets `rows_dirty` when `!show_all`; `occ` is now a `BTreeMap` so live-mode
rows come out pre-sorted; and `ensure_rows` merges the sorted pin rows into
the sorted source instead of cloning, appending, and re-sorting.

**Where** `core/src/state.rs:258` (`seek` sets `rows_dirty` unconditionally),
rebuild at `core/src/state.rs:263`.

**What** Measured cost of a **single-event step** (the playback and arrow-key
path), 65k display rows / 50k live:

| mode | ms per step |
|---|---|
| `show_all` (default) | 0.107 |
| live rows | 0.506 |

Two separate problems:

- **The invalidation is wrong in `show_all` mode.** Rows there come from
  `all_rows` (playhead-independent by construction) plus pins. A seek cannot
  change the layout, yet it marks it dirty and pays a full rebuild.
- **The rebuild redoes settled work.** It does `self.all_rows.clone()`
  (`state.rs:270`) and then `sort_unstable()` + `dedup()` (`state.rs:279`) on
  data `build_all_rows` already sorted and deduped. In live-rows mode it
  collects the `occ` HashMap and sorts 50k entries, when a single-event step
  changes at most a couple of rows.

**Why it matters** It is linear in address-space span, not in what changed. At
65k rows it is 0.1 ms/frame; an 8 GiB heap at 4 KiB rows is 2M rows ≈ 3 ms of
pure waste per frame — on top of F1 and F2, against a 16 ms budget.

**Fix**

1. In `seek`, only set `rows_dirty` when `!show_all` — the `show_all` layout is
   already invalidated by `set_row_bytes` / `set_pins` / `set_anchor_pin` /
   `set_show_all`, which is the complete set of things that can change it.
2. In `ensure_rows`, skip the sort when the source is `all_rows`; better, keep
   the pin rows in a separate sorted vec and merge the two sorted sequences
   instead of concatenating and re-sorting.
3. Optionally, maintain the live-rows list incrementally in `occ_bump`, which
   already knows exactly which rows became occupied or empty.

`collapse_min_keeps_short_runs`, `show_all_rows_stable`,
`pinned_rows_stay_laid_out` and `anchor_pin_survives_free` cover the behavior
that must not change.

---

<a id="f4"></a>

## F4 — Rasterizer inner loops are element-indexed

**Fixed** in `24eafa2` ("F4: give the rasterizer inner loops provable
bounds"). Each row is sliced once and walked with `chunks_exact_mut(4)` (`cov`
zipped alongside where it's read); `clear` writes one pixel and doubles it
with `copy_within`, as suggested below.

**Where** `core/src/render.rs:233` (`clear`), `:245` (`fill`), `:265`
(`fill_alloc`), `:315` (`fill_slack`), `:339` (`fill_ghost`).

**What** Every pixel is written through four separately bounds-checked index
expressions:

```rust
let p = (row + x) * 4;
self.px[p] = c[0];
self.px[p + 1] = c[1];
self.px[p + 2] = c[2];
self.px[p + 3] = 255;
```

`clear` is a scalar loop over the whole canvas — ~5.8 MB of stores per frame at
1600×900, ~23 MB at 4K.

**Why it matters** This is the innermost loop of the hottest function in the
project, and the bounds checks block vectorization.

**Fix** Slice the row once (`let row = &mut self.px[y*w*4 .. (y+1)*w*4];`) and
iterate with `chunks_exact_mut(4)`, which gives the optimizer a provable length.
For `clear`, write one pixel then use `copy_within` to double it, or fill from a
precomputed `[u8; 4]` pattern. `fill_alloc` also reads `self.cov[i]` per pixel
and can take the same treatment.

---

<a id="f5"></a>

## F5 — Per-frame allocation churn in `render_addr`

**Fixed** in `cb4f494` ("F5: reuse render_addr's per-frame containers").
`draw`/`seams`/`texts`/`covered` and the label string now live in a
`RenderScratch` owned by `App` (the `tl_px`/`out` pattern), cleared per frame;
labels are written in place with `write!` instead of
`push_str(&format!(..))`.

**Where** `core/src/render.rs:648` (`draw`), `:661` (`seams`), `:665`
(`texts`), `:779` (`covered`), plus 11 `format!` sites.

**What** Four containers are heap-allocated fresh every frame, and the label
list is built with `labels.push_str(&format!(...))` — a temporary `String`
allocated and dropped per label, up to 400 size labels plus row labels per
frame.

**Why it matters** Small next to F1–F3, but it is free to fix and `App` already
demonstrates the pattern: `tl_px`, `out` and `labels` are reused buffers.

**Fix** Move `draw`/`seams`/`texts` into `App` (or a `RenderScratch` struct) and
`clear()` them per frame; replace `push_str(&format!(..))` with
`write!(labels, ..)` (`std::fmt::Write`), which formats in place.

---

<a id="f6"></a>

## F6 — Timeline tag lanes are O(events in view)

**Fixed** in `1021d20` ("F6: make timeline tag lanes O(width log n) and free
for untagged traces"). `Store` now tracks a `tagged` count and lazily
rebuilds sorted `tag_alloc_idx`/`tag_free_idx` indexes (rebuilt once per tag
mutation, via `set_tag`/`clear_tags`); the lane pass returns immediately when
`tagged == 0` and binary-searches per column otherwise, restoring the O(width
log n) cost the strip was supposed to have.

**Where** `core/src/timeline.rs:119`.

**What** The green/red density bars are computed from prefix sums — O(width ·
log n), exactly as [05-timelines](../../../specs/05-timelines.md) describes. The
tag lanes underneath are not: they iterate every event in every column's bin.

```rust
for e in a..b {
    // ...
    if alloc_c.is_some() && free_c.is_some() { break; }
}
```

The early exit fires only once *both* a tagged allocation and a tagged free are
found in that column, so a trace with no tags — the common case — never breaks
early and scans every event in the view.

**Why it matters** `binCache` in `worker.js:266` keys on the view range, so this
is not paid at rest. It is paid on **every wheel tick** while zooming or panning
a timeline, which is precisely when the user expects the strips to feel
continuous.

**Fix** Skip the lane pass entirely when no tag is in use (the worker already
tracks `tagGen` and could pass a "any tags" flag; the engine can keep a count of
tagged creators, maintained where `tag` is written). For the tagged case, a
prefix-sum-style index of tagged events — or simply capping the per-column scan
— restores the strip's stated cost model.
