// The timeline interaction model (spec/05 TL-004), shared by everything that
// shows a stretch of the trace on an x-axis: the two strips (main.ts's
// setupTimeline, drawn by worker.ts) and the Tracks panel
// (intervals/tracks-panel.ts). Pure math plus the playhead's look, no DOM,
// so `node --test` covers it (src/web/test/timeline-interaction.test.ts).
//
// The gestures, for every such view:
//   click / drag   seek to the value under the pointer
//   wheel          zoom about the pointer      (wheelView)
//   shift+wheel    pan by a fixed step          (wheelView)
//   double-click   the whole axis               (axisBounds)
//   shift+drag     a range selection            (selectionRange)

import { clampView } from './fmt.ts';

export type Range = { lo: number; hi: number };
/** 't' — trace time (the time strip); 'seq' — event index (the events strip). */
export type TimelineAxis = 't' | 'seq';

/** Wheel zoom: the view's span is multiplied by exp(deltaY · this). */
export const WHEEL_ZOOM_RATE = 0.0015;
/** Shift+wheel pan: one notch moves the view by this fraction of its span. */
export const WHEEL_PAN_STEP = 0.15;
/** A shift+drag shorter than this (CSS px) is a click, not a selection. */
export const SELECT_MIN_PX = 3;

// --- the x-axis --------------------------------------------------------------

/** The x pixel of axis value `v` in a `width`-px view showing `view`. */
export function xOf(v: number, view: Range, width: number): number {
  const span = view.hi - view.lo;
  return span > 0 ? ((v - view.lo) / span) * width : 0;
}

/** The axis value at pixel `x` — xOf's inverse. */
export function valAt(x: number, view: Range, width: number): number {
  return width > 0 ? view.lo + (x / width) * (view.hi - view.lo) : view.lo;
}

/** The whole extent of an axis and its narrowest view, as the worker clamps it (worker.ts's tlview). */
export function axisBounds(axis: TimelineAxis, meta: { n?: number; tMin?: number; tMax?: number; [k: string]: unknown } | null): Range & { minSpan: number } {
  if (axis === 't') {
    const lo = meta?.tMin ?? 0;
    return { lo, hi: Math.max(meta?.tMax ?? lo + 1, lo + 1), minSpan: 1e-9 };
  }
  return { lo: 0, hi: Math.max(meta?.n ?? 1, 1), minSpan: 4 };
}

/** A view kept inside its axis — bit-identical to the worker's clamp (fmt.ts's clampView). */
export function clampAxis(r: Range, b: Range & { minSpan: number }): Range {
  return clampView(r, b.lo, b.hi, b.minSpan);
}

// --- zoom and pan ------------------------------------------------------------

/** Zoom by `factor` (>1 out, <1 in) about the value at pixel `x`. */
export function zoomAt(view: Range, x: number, width: number, factor: number): Range {
  const c = valAt(x, view, width);
  return { lo: c - (c - view.lo) * factor, hi: c + (view.hi - c) * factor };
}

/** Pan so the content moves `dx` px right — the view moves left. */
export function panBy(view: Range, dx: number, width: number): Range {
  const d = width > 0 ? (dx / width) * (view.hi - view.lo) : 0;
  return { lo: view.lo - d, hi: view.hi - d };
}

/**
 * The view after one wheel event at pixel `x` (unclamped; clampAxis it):
 * shift pans one step in the wheel's direction, otherwise the wheel zooms
 * about the pointer. Browsers that turn shift+wheel into a horizontal wheel
 * report it in deltaX, so a pan reads that when deltaY is 0.
 */
export function wheelView(view: Range, e: { deltaY: number; deltaX?: number; shiftKey?: boolean }, x: number, width: number): Range {
  if (e.shiftKey) {
    const delta = e.deltaY || e.deltaX || 0;
    if (!delta) return view;
    const d = (view.hi - view.lo) * (delta > 0 ? WHEEL_PAN_STEP : -WHEEL_PAN_STEP);
    return { lo: view.lo + d, hi: view.hi + d };
  }
  return zoomAt(view, x, width, Math.exp(e.deltaY * WHEEL_ZOOM_RATE));
}

/** The range a shift+drag from pixel `x0` to `x1` selects, low end first. */
export function selectionRange(view: Range, width: number, x0: number, x1: number): Range {
  return { lo: valAt(Math.min(x0, x1), view, width), hi: valAt(Math.max(x0, x1), view, width) };
}

// --- the playhead's look -----------------------------------------------------

/** The strips' playhead: a tint over the played part, a line, and a grab triangle on top. */
export const PLAYHEAD = {
  played: 'rgba(230,237,243,0.08)',
  line: '#e6edf3',
  hover: 'rgba(230,237,243,0.45)',
} as const;

type Paint = {
  fillStyle: any;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fill(): void;
};

/**
 * Paint the playhead at device pixel `x` over rows [top, bottom), in
 * device pixels, `scale` device pixels per CSS px: the played region tinted
 * from the left edge, the line, and the triangle at `top`.
 */
export function paintPlayhead(g: Paint, x: number, top: number, bottom: number, scale: number) {
  const h = bottom - top;
  g.fillStyle = PLAYHEAD.played;
  g.fillRect(0, top, Math.max(0, x), h);
  g.fillStyle = PLAYHEAD.line;
  g.fillRect(Math.round(x) - Math.round(scale / 2), top, Math.max(1, Math.round(1.5 * scale)), h);
  g.beginPath();
  g.moveTo(x - 4 * scale, top);
  g.lineTo(x + 4 * scale, top);
  g.lineTo(x, top + 5 * scale);
  g.fill();
}
