// Interval domain: the Tracks panel's geometry — the windows it fetches,
// the vertical stack of track groups and which of them are in view, bars
// from window rows (with sub-pixel culling), hit testing, axis ticks, and
// color picking. The x-axis mapping and the gestures' zoom and pan are the
// strips' (src/web/timeline-interaction.ts). No DOM, so `node --test` covers
// it (src/web/test/intervals-flame.test.ts); tracks-panel.ts draws with it.

import { xOf } from '../timeline-interaction.ts';
import { cpuKey, threadKey, threadLabel } from './intervals-model.ts';
import type { Axis, IntervalRow, Range, TrackCpu, TrackThread, WindowRow } from './types.ts';

// --- the x-axis ------------------------------------------------------------------
// The mapping, zoom, pan and clamp are the strips' own (timeline-interaction.ts).

/** The window a track was fetched for: an axis range at a pixel width. */
export type Fetched = { axis: Axis; lo: number; hi: number; width: number };

/** The window to fetch for a view: half a view of margin either side, at twice the width. */
export function windowFor(axis: Axis, view: Range, width: number): Fetched {
  const span = view.hi - view.lo;
  return { axis, lo: view.lo - span / 2, hi: view.hi + span / 2, width: Math.max(1, Math.round(width)) * 2 };
}

/**
 * Whether a fetched window still serves a view: same axis, the view inside
 * it, and about the same zoom (its culling was done for nearly this many
 * values per pixel). A pan within the margin asks nothing.
 */
export function windowCovers(f: Fetched | null | undefined, axis: Axis, view: Range, width: number): boolean {
  if (!f || f.axis !== axis) return false;
  const want = windowFor(axis, view, width);
  if (want.width !== f.width || view.lo < f.lo || view.hi > f.hi) return false;
  const ratio = (want.hi - want.lo) / (f.hi - f.lo);
  return ratio > 0.8 && ratio < 1.25;
}

/** Round axis ticks about `px` apart: values on a 1/2/5 × 10ⁿ grid. */
export function axisTicks(view: Range, width: number, px = 100): number[] {
  const span = view.hi - view.lo;
  if (!(span > 0) || width <= 0) return [];
  const raw = (span * px) / width;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.ceil(view.lo / step) * step; v <= view.hi && out.length < 1000; v += step) out.push(v);
  return out;
}

// --- the vertical stack -----------------------------------------------------------

/** One call, span or CPU row; a thread's head; a section heading (THREADS, CPUS). */
export const ROW_H = 18;
export const HEAD_H = 20;
export const SECTION_H = 20;
export const GROUP_GAP = 4;
/** The track-name gutter laid over the plot's left edge (CSS px). */
export const GUTTER_W = 56;

/** Rows a track needs per lane, learned from the windows it was sent. */
export type Depths = { call: number; span: number };

export type Group = {
  key: string;
  kind: 'thread' | 'cpu' | 'heading';
  label: string;
  thr?: number;
  pid?: number;
  cpu?: number;
  top: number;
  height: number;
  /** y of the first call row, the first span row, and their counts. */
  callTop: number;
  callRows: number;
  spanTop: number;
  spanRows: number;
};

/** The rows one window shows: deepest call and span depth seen, plus one. */
export function depthsOf(rows: WindowRow[]): Depths {
  let call = 0;
  let span = 0;
  for (const r of rows) {
    if (r.cpu !== undefined && r.cpu !== null) continue;
    if (r.lane === 'span') span = Math.max(span, r.depth + 1);
    else call = Math.max(call, r.depth + 1);
  }
  return { call, span };
}

/** Grow `a` by what `b` saw; never shrinks, so groups don't jump as a view moves. */
export function mergeDepths(a: Depths | undefined, b: Depths): Depths {
  return { call: Math.max(a?.call ?? 0, b.call), span: Math.max(a?.span ?? 0, b.span) };
}

/**
 * Track groups top to bottom: a `Threads` heading, per thread a head (its
 * name), its call rows by depth, then its span rows; then a `CPUs` heading
 * and one row per CPU. A lane the thread has anything in gets at least one
 * row. `threads` and `cpus` are in display order (orderTracks).
 */
export function layoutGroups(threads: TrackThread[], cpus: TrackCpu[], depths: Map<string, Depths>) {
  const groups: Group[] = [];
  let y = 0;
  const heading = (key: string, label: string) => {
    groups.push({ key, kind: 'heading', label, top: y, height: SECTION_H, callTop: y + SECTION_H, callRows: 0, spanTop: y + SECTION_H, spanRows: 0 });
    y += SECTION_H;
  };
  if (threads.length) heading('threads', 'Threads');
  for (const t of threads) {
    const key = threadKey(t);
    const d = depths.get(key);
    const callRows = t.calls > 0 ? Math.max(1, d?.call ?? 0) : 0;
    const spanRows = t.spans > 0 ? Math.max(1, d?.span ?? 0) : 0;
    const height = HEAD_H + (callRows + spanRows) * ROW_H + GROUP_GAP;
    groups.push({
      key, kind: 'thread', label: threadLabel(t), thr: t.thr, pid: t.pid, top: y, height,
      callTop: y + HEAD_H, callRows, spanTop: y + HEAD_H + callRows * ROW_H, spanRows,
    });
    y += height;
  }
  if (cpus.length) {
    heading('cpus', 'CPUs');
    for (const c of cpus) {
      groups.push({
        key: cpuKey(c.cpu), kind: 'cpu', label: `cpu ${c.cpu}`, cpu: c.cpu, top: y, height: ROW_H + 1,
        callTop: y, callRows: 1, spanTop: y + ROW_H, spanRows: 0,
      });
      y += ROW_H + 1;
    }
  }
  return { groups, height: y };
}

/** The groups overlapping [scrollTop, scrollTop + viewH): the only ones drawn and fetched. */
export function visibleGroups(groups: Group[], scrollTop: number, viewH: number): Group[] {
  // groups are sorted by top: binary-search the first that ends below scrollTop
  let lo = 0;
  let hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].top + groups[mid].height <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const out: Group[] = [];
  for (let i = lo; i < groups.length && groups[i].top < scrollTop + viewH; i++) out.push(groups[i]);
  return out;
}

/** The group at content y, or null (binary search). */
export function groupAt(groups: Group[], y: number): Group | null {
  const g = visibleGroups(groups, y, 1)[0];
  return g && y >= g.top && y < g.top + g.height ? g : null;
}

/** Which lane row of a group content y falls in, or null (the head, the gap). */
export function laneAt(g: Group, y: number): { lane: 'call' | 'span'; depth: number } | null {
  if (y >= g.callTop && y < g.callTop + g.callRows * ROW_H) return { lane: 'call', depth: Math.floor((y - g.callTop) / ROW_H) };
  if (y >= g.spanTop && y < g.spanTop + g.spanRows * ROW_H) return { lane: 'span', depth: Math.floor((y - g.spanTop) / ROW_H) };
  return null;
}

// --- bars ---------------------------------------------------------------------------

export type Bar = { row: WindowRow; lane: 'call' | 'span'; depth: number; x: number; w: number; merged: number };

/** Narrowest bar drawn, in CSS px. */
export const MIN_BAR = 1;

/**
 * Bars for one track's rows at the current view: clipped to the canvas, and
 * culled at the width — a bar under a pixel wide that starts where the last
 * bar in its row already reaches is folded into it (`merged` counts what it
 * holds), so a dense row of tiny calls draws as a few solid runs rather than
 * thousands of overlapping 1-px rectangles. The engine culls too
 * (`interval-window` answers per pixel); this keeps the picture right while
 * the view moves between replies. A CPU's slices are all `call`, depth 0.
 */
export function layoutBars(rows: WindowRow[], view: Range, width: number): { bars: Bar[]; merged: number } {
  const sorted = rows.slice().sort((a, b) => laneOf(a).localeCompare(laneOf(b)) || depthOf(a) - depthOf(b) || a.start - b.start);
  const bars: Bar[] = [];
  const lastIn = new Map<string, Bar>();
  let merged = 0;
  for (const r of sorted) {
    let x0 = xOf(r.start, view, width);
    let x1 = xOf(r.end, view, width);
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (x1 < 0 || x0 > width) continue;
    x0 = Math.max(-1, x0);
    x1 = Math.min(width + 1, x1);
    const lane = laneOf(r);
    const depth = depthOf(r);
    const k = `${lane}:${depth}`;
    const prev = lastIn.get(k);
    if (prev && x1 - x0 < MIN_BAR && x0 <= prev.x + prev.w) {
      prev.w = Math.max(prev.w, x1 - prev.x, Math.ceil(x0) + MIN_BAR - prev.x);
      prev.merged++;
      merged++;
      continue;
    }
    const b: Bar = { row: r, lane, depth, x: x0, w: Math.max(MIN_BAR, x1 - x0), merged: 0 };
    bars.push(b);
    lastIn.set(k, b);
  }
  return { bars, merged };
}

function laneOf(r: WindowRow): 'call' | 'span' {
  return r.cpu !== undefined && r.cpu !== null ? 'call' : r.lane === 'span' ? 'span' : 'call';
}

function depthOf(r: WindowRow): number {
  return r.cpu !== undefined && r.cpu !== null ? 0 : Math.max(0, r.depth | 0);
}

/** The bar under x in one lane row (the last drawn wins), with a pixel of slack. */
export function hitBar(bars: Bar[], lane: 'call' | 'span', depth: number, x: number): Bar | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.lane === lane && b.depth === depth && x >= b.x - 1 && x <= b.x + b.w + 1) return b;
  }
  return null;
}

// --- the selected interval ----------------------------------------------------------

/** Where the selected interval sits: its group, its row's content y, and its extent on the axis. */
export type SelectedBox = { key: string; y: number; lo: number; hi: number };

/**
 * The selected interval's box in the stack (IVL-UI-005), from its interval
 * document: a call in its thread's call rows at its depth, a span in the span
 * rows, a slice in its CPU's row. An open interval reaches `ends` (the axis's
 * end: the trace's last time, or its record count). Null when its track is not
 * in the stack.
 */
export function selectedBox(groups: Group[], r: IntervalRow, axis: Axis, ends: number): SelectedBox | null {
  const key = r.category === 'sched'
    ? (r.cpu === undefined || r.cpu === null ? '' : cpuKey(r.cpu))
    : (r.thr === null || r.thr === undefined ? '' : threadKey({ thr: r.thr, pid: r.pid }));
  const g = groups.find((x) => x.key === key);
  if (!g) return null;
  const depth = Math.max(0, r.depth | 0);
  const y = r.category === 'sched' ? g.callTop : r.category === 'span' ? g.spanTop + depth * ROW_H : g.callTop + depth * ROW_H;
  const lo = axis === 't' ? r.t : r.seq;
  const end = axis === 't' ? r.endT : r.end;
  return { key, y, lo, hi: end === null || end === undefined ? Math.max(lo, ends) : end };
}

/**
 * The scrollTop that brings content y (one row tall) into a viewport of
 * height viewH, or null when it is already in view: centered when it is not.
 */
export function scrollToRow(y: number, scrollTop: number, viewH: number): number | null {
  if (y >= scrollTop && y + ROW_H <= scrollTop + viewH) return null;
  return Math.max(0, Math.round(y - (viewH - ROW_H) / 2));
}

/**
 * The view that shows [lo, hi]: the same view when it overlaps its visible
 * part (from `visibleLo`, right of the name gutter, to its end), else one of
 * the same span centered on it (or fitted around [lo, hi] when wider).
 */
export function viewToShow(view: Range, lo: number, hi: number, visibleLo = view.lo): Range {
  if (hi >= visibleLo && lo <= view.hi) return view;
  const span = view.hi - view.lo;
  if (hi - lo > span) {
    const pad = (hi - lo) * 0.1;
    return { lo: lo - pad, hi: hi + pad };
  }
  const mid = (lo + hi) / 2;
  return { lo: mid - span / 2, hi: mid + span / 2 };
}

// --- colors ---------------------------------------------------------------------------

/** FNV-1a: a stable palette slot per name or thread, independent of load order. */
export function colorSlot(s: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return n > 0 ? (h >>> 0) % n : 0;
}

/** The key a bar is colored by: a call or span by name, a run slice by its thread. */
export function colorKey(r: WindowRow): string {
  if (r.cpu !== undefined && r.cpu !== null) return r.idle ? '' : `thr:${r.thr ?? r.name}`;
  return `${r.lane}:${r.name}`;
}
