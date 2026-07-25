# 05 — The Two Timelines

Two full-width strips above the address map, sharing one playhead.

## TL-001: Temporal vs. sequential

- **Temporal strip** — x is `t`, linearly scaled over the visible time range.
  Bursts bunch up; idle gaps show as empty stretches. Answers *"when, and how
  bursty?"*
- **Sequential strip** — x is `seq`, evenly spaced. Answers *"in what order,
  and how many?"*

Same events, two projections; the divergence between them is information (see
[01-overview](01-overview.md)).

## TL-002: Density rendering

Each strip is a two-sided density histogram: per pixel column, allocation
events (`M`/`R`) draw green bars up from a baseline, free events (`F`/`R`)
draw red bars down. Two rendering decisions worth keeping:

- **Binning uses the load-time prefix sums** ([MODEL-006](03-core-model.md#model-006-derived-load-time-indexes)): a column's count is two array lookups, so a full
  re-bin is O(width · log n) and never scans events — million-event traces
  re-render at interaction speed.
- **Bar height is √-scaled** relative to the visible maximum, so a
  1000× denser column doesn't flatten every other column into invisibility.

Rendered strips are cached and only re-binned when the view range, size, or
tag state changes; the playhead (cursor line + dimmed "played" region) is
drawn over the cached image every frame.

## TL-003: Tag lanes

Thin lanes along the strip edges mark tagged activity in the tag's color:
top edge = columns where tagged allocations are *created*, bottom edge =
columns where they are *freed*. This keeps an analysis visible at trace scale
even when the tagged allocations are a tiny fraction of events.

## TL-004: Interaction

| Gesture | Effect |
|---------|--------|
| Click / drag | Seek the playhead (by `t` on temporal, by `seq` on sequential). |
| Wheel | Zoom the strip around the cursor. |
| Shift+wheel | Pan. |
| Double-click | Reset to the full range. |
| Shift+drag | Range selection → popover with Zoom / Crop / Tag actions ([07-analysis](07-analysis.md)). |
| Hover | Tooltip: alloc/free counts and the `t`/`seq` range under the column. |

Zoom/pan state is clamped engine-consistently on both sides (the main thread
mirrors the worker's clamp so optimistic local updates agree with it, keeping
wheel zoom responsive without waiting a round-trip).

**View mirroring:** zooming or selecting on one strip mirrors the equivalent
range onto the other (and onto the Events panel's gutter band) via a
time↔seq conversion round-trip to the engine. Mirror updates are marked so
they don't bounce back and forth between the strips.

## TL-005: Overlays

Both strips carry, in strip-local coordinates: the selection band and its
mirrored echo, the crop band, bookmark flags (⚑, click = jump in time;
shift+click also centers the place), and a hover line. These are DOM/SVG
overlays owned by the main thread, positioned from the current view range —
the canvas below them only ever contains density pixels.
