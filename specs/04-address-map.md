# 04 — The Address Map

The main view: the address space drawn as a grid of rows, showing the live set
at the playhead.

## 4.1 Row layout

- The viewer picks a **base** `B` (lowest observed address, or `arena_base`
  from the header if lower, rounded down to a row boundary) and a **row
  width** `row_bytes` `W` (default `0x1000`, changeable live).
- Address `A` maps to row `floor((A − B) / W)`, column offset `(A − B) mod W`.
  Bytes run left → right, rows stack top → bottom — reading order is address
  order, like a hex dump.
- An allocation fills the cells it covers, wrapping across rows.
- Changing `row_bytes` re-buckets live. Powers of two keep offsets aligned;
  the `0x1000` default matches a typical page so page-level fragmentation
  reads naturally.

## 4.2 Empty-row collapsing

Address spaces are sparse. A run of consecutive rows containing no live
allocation is **collapsed** into a thin gap marker (labeled with how many
bytes were skipped) instead of full-height empty rows, keeping the map dense
and scrollable across terabyte-wide ranges.

- The **collapse threshold** is user-set and dual-unit: a plain number is a
  run length in rows (default 5 — short gaps stay as real empty rows, which
  preserves local shape); a byte size (`64k`, `0x10000`) is empty *address
  space*, converted to rows on the fly so it tracks `row_bytes` changes.
- Collapsing is recomputed per playhead position: a row empty now may be
  occupied later.

## 4.3 Layout stability

Per-playhead collapsing means the map can reflow as the playhead moves. Three
mechanisms deliberately trade "show only what's live" for "don't yank the
view around" (each was added in response to real disorientation, see
`TASKS.md` items 8–10):

- **All-rows mode** (default on): lay out every row *any* allocation ever
  touches, playhead-independent, so the map never reflows during
  stepping/playback. Off = live-rows-only, the densest view.
- **Pinned addresses**: every user address mark
  ([07-analysis](07-analysis.md)) keeps its row laid out even when empty, so a
  marked address is always scrollable-to.
- **Scroll anchoring**: before any layout-changing operation (seek,
  `row_bytes` change, collapse change), the viewer captures the address at
  the top of the viewport, transiently pins its row through the operation,
  and restores scroll so that address stays put — even if everything in it
  was just freed.

## 4.4 Vertical and horizontal navigation

- **Vertical**: native browser scrolling over a virtual height (row height ×
  laid-out rows + gaps). Row pixel height is a user "row zoom" setting.
- **Horizontal zoom** on the byte axis of each row (ctrl/alt+wheel around the
  cursor, shift+wheel or trackpad-x to pan; toolbar shows `↔ ×N`,
  click-to-reset). Row size is untouched — this stretches bytes so tiny
  allocations become visible and clickable. All picking, overlays, marks, and
  auto-centering honor the zoom.

## 4.5 Coloring

Fixed base semantics so traces read consistently: **green** = allocation
(live region fill, `M`/`R` timeline ticks), **red** = free, neutral =
gaps/background. Overlapping live bytes render **orange** — a data-integrity
signal, not a palette choice.

The fill may instead be driven by a user-selected **color mode**:

| Mode | Palette |
|------|---------|
| live (default) | Uniform green. |
| site | Categorical palette by allocation site. |
| thread | Categorical palette by thread. |
| size | Sequential green ramp over **log₂ size** (≈16 B → 16 MiB). Log because sizes span orders of magnitude. |
| age | Ramp (young green → cyan → old blue) over **log age normalized to the oldest live allocation** at the playhead — a relative scale that stays useful whether ages span nanoseconds or minutes. |
| tag | Tag colors; untagged recedes to gray. |

Two overrides apply in every mode: a per-allocation **highlight color**
(user-set), and a **tag stripe** along the bottom edge of tagged allocations,
so tags stay visible outside tag mode. Filtered-out / cropped-out allocations
render dimmed (blended toward the row background) or hidden per the filter
mode ([07-analysis](07-analysis.md)). The selected allocation gets a white
outline. `usable` slack beyond the requested size renders as a faint band
that never covers real allocation pixels.

A legend strip below the toolbar explains the active mode's mapping.

## 4.6 Labels

Drawn by the JS layer on top of the raster (the engine emits label geometry;
JS knows fonts, user names, and the chosen size format):

- **Row addresses** along the left edge (toggleable), thinned to every Nth row
  when rows are short.
- **Gap markers**: centered "N KiB skipped".
- **In-allocation labels** for allocations wide enough: `name · size` if it
  fits, else the name, else the size (compact or hex format, user choice).
  Multi-row allocations put the label on the middle visible row. Emission is
  capped per frame (400) so dense maps don't drown in text.

## 4.7 Hit-testing and queries

All picking is engine-side (the DOM has no idea what's where):

- **Hover** → allocation info (id, range, size/usable, site, thread, birth
  seq/t, age, death seq/t or "never freed", stack, extra fields, tag) plus
  highlight rects; shown as tooltip and, on click, in the allocation panel.
- **Pixel → address** works even in gaps (used by shift+click address marks).
- **Address → live allocation** (used by "go to address" to auto-select).
- **Event → rects** for flash/ping effects, and **event → scroll offset** for
  centering. The most recently applied event also yields link geometry: an
  `R` draws an old→new move link, an `F` flashes the freed region red, an `M`
  outlines the fresh allocation — so stepping always shows *where* something
  happened.

Hit-testing scans the address-ordered live set backwards from the cursor
address, bounded by the largest span in the trace — no per-pixel index needed.
