// Interval domain: what the three panels share — the loaded trace's interval
// summary (fetched once per trace), the playhead, and the DOM scaffolding of a
// panel. index.ts owns one of these and hands it to each panel.

import type { IntervalCtx, Playhead, Tracks } from './types.ts';

export type Trace = {
  /** Bumped per loaded trace; a reply for an older one is dropped. */
  gen: number;
  /** Intervals in the trace (the descriptor's `intervals`), or -1 until known. */
  total: number;
  tracks: Tracks;
};

export type Shared = {
  ctx: IntervalCtx;
  trace: Trace;
  playhead: Playhead | null;
};

/** Whether the loaded trace has intervals: from the load meta if the worker attached it, else from `domains`. */
export function present(s: Shared): boolean {
  const m = s.ctx.ui.meta?.intervals;
  if (m && typeof m.intervals === 'number') return m.intervals > 0;
  return s.trace.total > 0;
}

/** The panel is open with its tab in front — the only time it does work. */
export function shown(s: Shared, type: string): boolean {
  const l = s.ctx.layout;
  return s.ctx.ui.loaded && (l.isShown ? l.isShown(type) : l.isOpen(type));
}

/**
 * A window element in the shape the shell adopts (`.panel` with a
 * `.panel-head` holding `.ph-t`, a count, `.head-actions` and a close button).
 */
export function panelElement(id: string, extraHead = ''): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'panel ivl-panel';
  el.hidden = true;
  el.innerHTML = `<div class="panel-head"><span class="ph-t"></span> <span class="ivl-count"></span>`
    + `<span class="head-actions">${extraHead}<button class="panel-close">×</button></span></div>`;
  return el;
}

/** A CSS custom property of `el`, or `fallback` when unset. */
export function token(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
