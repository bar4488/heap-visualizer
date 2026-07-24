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
signal, not a palette choice (see §4.6 for the other display modes).

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

## 4.6 Overlapping allocations

Two live allocations sharing bytes means the traced program (or the trace
itself) is wrong, so the default is to make it loud rather than pretty:
shared pixels render **orange**. But an overlap is often *nesting* — a suballocator
handing out pieces of a block it still holds live — where orange hides the
structure instead of revealing it. So the display is a user choice:

| Mode | Shared pixels show |
|------|--------------------|
| flag orange (default) | Orange, wherever two allocations fully cover the same pixel. |
| ignore | The most recently created allocation — draws are creation-ordered, so the newest is always on top. |

Only pixels *fully* covered by both byte ranges count, so two allocations
merely abutting inside one pixel are never flagged. Overlap display is
independent of the load-time overlap *warning*
([03-core-model §3.5](03-core-model.md)), which always fires. The overlap
display mode (and the ghost toggle below) are **global app preferences**,
persisted across traces and runs, unlike per-trace session state
([07-analysis §7.7](07-analysis.md)).

Where several live allocations cover the same address, **picking (hover and
click) selects the most recently created one** — the allocation on top, in
both senses: allocations are also *drawn* in creation order, so what "ignore"
shows and what a click selects always agree. Address-order picking would let
an enclosing block shadow everything nested inside it, making inner
allocations unselectable.

**Freed-nested "ghosts"** (toggleable, default on): a free normally shows as
the region emptying, but an allocation freed *inside* a still-live parent
would vanish without a visible trace. Instead its range renders **recessed**
— the parent's fill darkened, with darker divider edges at its boundaries —
so an ended allocation stays readable inside its parent. Rules that make
this honest and cheap:

- Only *true nesting* ghosts: the dead allocation must have been created
  after the enclosing live one and sit fully inside it. Earlier tenants of
  reused address space (freed before the parent existed) are not ghosts.
- Candidates come from the load-time overlap index (creators that overlapped
  something live at birth), so traces without nesting pay nothing.
- Overlapping dead generations at one address darken a slot **once** (a
  coverage-buffer mark makes the fill idempotent), and a live nested
  allocation's pixels are never darkened.
- The per-frame candidate scan is budget-capped like labels, so pathological
  churn cannot stall a frame.

## 4.7 Labels

Drawn by the JS layer on top of the raster (the engine emits label geometry;
JS knows fonts, user names, and the chosen size format):

- **Row addresses** along the left edge (toggleable), thinned to every Nth row
  when rows are short.
- **Gap markers**: centered "N KiB skipped" — or "N KiB more of this
  allocation" when the collapsed rows are the middle of a single allocation
  too large to lay out row by row (§4.3), where "skipped" would read as
  "nothing here" and mean the opposite of the truth.
- **In-allocation labels** for allocations wide enough: `name · size` if it
  fits, else the name, else the size (compact or hex format, user choice).
  Multi-row allocations put the label on the middle visible row. Emission is
  capped per frame (400) so dense maps don't drown in text. Overlapping
  allocations would land their labels on the same rows, so labels are
  collision-culled at draw time: the nested (narrower) allocation's label
  wins and colliding text is skipped.

## 4.8 Hit-testing and queries

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

Hit-testing scans the address-ordered live set around the cursor address,
bounded by the largest span in the trace — no per-pixel index needed. Among
overlapping covers the newest creator event wins (§4.6).
