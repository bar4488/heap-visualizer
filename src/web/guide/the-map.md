# The map

Open a trace first. Two to work from:
[sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1) has 16
allocations across a sparse address range — small enough to read whole, wide
enough that collapsing and row width visibly change it. [Demo](#do:btn-demo)
has 50,000 events across 4 threads, for how the same controls behave at scale.

The map draws the address space at the playhead, like a hex dump. It shows the
live set: allocated before the playhead and not yet freed.

- Base `B` is the lowest observed address, or `arena_base` from the header when
  that is lower, rounded down to a row boundary.
- Row width `W` is `row_bytes`, default `0x1000`. One page per row, so
  page-level fragmentation reads off the grid.
- Address `A` sits at row `floor((A - B) / W)`, column `(A - B) mod W`.
- Allocations wrap across rows. Reading order is address order.

Row width is live: [0x400](#set:row-bytes=0x400) re-buckets everything,
[0x1000](#set:row-bytes=0x1000) puts it back. Powers of two keep columns
aligned. The control is in [Layout](#show:layout-panel).

## Collapsed rows

A run of rows with nothing live collapses to a marker labeled with the bytes
skipped. The threshold takes two units:

- A bare number is a run length in rows. Default `5`.
- A byte size — `64k`, `0x10000` — is empty address space, converted to rows on
  the fly, so it tracks `row_bytes`.

Collapsing depends on the playhead position, so the map can reflow as you step.
Three things hold it still:

- **all rows** in Layout, on by default: every row any allocation ever touches
  stays laid out, so nothing reflows while stepping. Turn it
  [off](#set:show-all=false) for the densest view, [on](#set:show-all=true) to
  stop the movement.
- Address marks keep their row laid out when empty.
- Before any layout change the address at the top of the viewport is pinned and
  scroll is restored to it.

## Base colors

- Green allocated, red freed, neutral gap.
- **Orange means two live allocations share bytes**, which is a defect in the
  traced program. [overlaps: ignore](#set:overlap-mode=1) draws the newest on
  top instead; [flag orange](#set:overlap-mode=0) restores it.
- A freed allocation inside a still-live one draws recessed instead of
  disappearing, so the hole stays visible (**mark freed nested**, on by
  default).
- `usable` beyond the requested size draws as a lighter slack band.

[defects.heapl](index.html?trace=guide/traces/defects.heapl&guide=1) has all of
it: an overlap, a pool with a freed item inside it, slack, a double free, and a
free of an unknown id. The ⚠ badge counts the last two.

## Color modes

In [Appearance](#show:appearance-panel). They need a populated map to say
anything, so use
[colors.heapl](index.html?trace=guide/traces/colors.heapl&guide=1), which is
built for them: 156 allocations over 6 sites and 4 threads, sizes 16 B to
64 KiB, 125 still live at the end. Addresses ascend with size and with birth
time, so each mode resolves into a picture instead of noise.

- [size](#set:color-mode=3) — ramp over log2 size, ~16 B to 16 MiB.
- [age](#set:color-mode=4) — ramp over log age, normalized to the oldest live
  allocation at the playhead. It is relative, so a rectangle changes color as
  the trace moves on without it.
- [site](#set:color-mode=1), [thread](#set:color-mode=2) — categorical,
  assigned by index. The same color means different things in different traces.
- [tag](#set:color-mode=5) — the first tag's color, with a stripe per
  membership.
- [live](#set:color-mode=0) — uniform green.

Per-allocation highlight colors and tag stripes show in every mode.

## Zoom

- Row height is a display setting: [m](#set:row-px=12) by default,
  [xl](#set:row-px=26) at the top end.
- Ctrl or alt with the wheel zooms the byte axis around the cursor; shift-wheel
  pans it. Rectangle width stays in bytes, no longer 1:1 with pixels. The
  toolbar pill shows the factor and resets it.
