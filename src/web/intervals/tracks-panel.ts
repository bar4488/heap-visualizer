// Interval domain: the Tracks panel (IVL-UI-003) — a flame chart drawn on the
// main thread. One group per thread (its calls by depth, then its span lane)
// and one row per CPU (run slices colored by thread), on the timeline's
// x-axis: the strips' time or seq view range, by the head's axis toggle.
//
// Nothing is fetched whole. Each *visible* track asks `interval-window` for
// the view (with half a view of margin either side, so a short pan needs no
// round trip), under its own requestLatest key, so a fast zoom keeps at most
// one request in flight per track. Rows come back in axis units and are
// re-laid out on every draw, so a pan or zoom redraws at once from what is
// held and the fresh window replaces it when it lands.
//
// Vertically the groups are virtualized: a transparent scroller carries a
// spacer as tall as the whole stack, and the canvas behind it draws only the
// groups in view. A group grows as deeper calls arrive (never shrinks), so
// the stack does not jump while the view moves.
//
// Wheel: ctrl/⌘ zooms about the pointer, shift (or a horizontal wheel) pans,
// a plain wheel scrolls the tracks; a drag pans. These drive the strips' own
// view through ctx.setView when main.ts provides it, else a local view that
// yields to the strips again as soon as they move. The geometry is
// flame-model.ts and tested there; this file is the canvas and the events.

import { esc } from '../fmt.ts';
import { dpr } from '../shell/dom.ts';
import { hideTooltip, positionTooltipNearMouse, showTooltip } from '../shell/tooltip.ts';
import {
  HEAD_H, ROW_H, axisBounds, axisTicks, clampAxis, colorKey, colorSlot, depthsOf, groupAt, hitBar,
  laneAt, layoutBars, layoutGroups, mergeDepths, panBy, valAt, visibleGroups, windowCovers, windowFor, xOf, zoomAt,
  type Bar, type Depths, type Fetched, type Group,
} from './flame-model.ts';
import { fmtDur, fmtRecords, orderTracks, seekSeqFor } from './intervals-model.ts';
import { panelElement, present, shown, token, type Shared } from './shared.ts';
import type { Axis, Range, Views, WindowQuery, WindowRow } from './types.ts';

const TYPE = 'intervals-tracks';
const AXIS_H = 18;
const PALETTE_N = 12;
const OWNER = 'intervals-tracks';

type Held = { win: Fetched; rows: WindowRow[]; truncated: boolean; culled: number };

export function createTracksPanel(sh: Shared) {
  const el = panelElement('intervals-tracks-panel',
    '<select class="ivl-axis" title="The x-axis: trace time, or event index (one step per record)">'
    + '<option value="t">time</option><option value="seq">events</option></select>');
  el.insertAdjacentHTML('beforeend',
    '<div class="ivl-tbody"><canvas class="ivl-canvas"></canvas>'
    + '<div class="ivl-tscroll"><div class="ivl-spacer"></div></div><div class="ivl-empty" hidden></div></div>');
  const body = el.querySelector('.ivl-tbody') as HTMLElement;
  const canvas = el.querySelector('.ivl-canvas') as HTMLCanvasElement;
  const sc = el.querySelector('.ivl-tscroll') as HTMLElement;
  const spacer = el.querySelector('.ivl-spacer') as HTMLElement;
  const axisSel = el.querySelector('.ivl-axis') as HTMLSelectElement;
  const g2 = canvas.getContext('2d');

  let axis: Axis = 't';
  /** The strips' views, as last reported, and a local view per axis while ours leads. */
  const strips: Record<Axis, Range | null> = { t: null, seq: null };
  const local: Record<Axis, Range | null> = { t: null, seq: null };
  let threads = [] as ReturnType<typeof orderTracks>['threads'];
  let cpus = [] as ReturnType<typeof orderTracks>['cpus'];
  const depths = new Map<string, Depths>();
  let groups: Group[] = [];
  let contentH = 0;
  const held = new Map<string, Held>();
  const bars = new Map<string, Bar[]>();
  let colors: { [k: string]: any } | null = null;
  let frame = 0;

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;
  const meta = () => sh.ctx.ui.meta;

  function view(): Range {
    const v = local[axis] ?? strips[axis];
    return v ?? axisBounds(axis, meta());
  }

  function relayout() {
    const L = layoutGroups(threads, cpus, depths);
    groups = L.groups;
    contentH = L.height;
    spacer.style.height = `${contentH + AXIS_H}px`;
  }

  function readColors() {
    const pal: string[] = [];
    for (let i = 0; i < PALETTE_N; i++) pal.push(token(el, `--ivl-c${i}`, `hsl(${(i * 360) / PALETTE_N} 45% 45%)`));
    colors = {
      pal,
      bg: token(el, '--ivl-bg', '#0d1117'),
      fg: token(el, '--ivl-fg', '#e6edf3'),
      dim: token(el, '--ivl-dim', '#8b949e'),
      grid: token(el, '--ivl-grid', '#30363d'),
      head: token(el, '--ivl-head', '#161b22'),
      idle: token(el, '--ivl-idle', '#30363d'),
      playhead: token(el, '--ivl-playhead', '#f85149'),
      text: token(el, '--ivl-bar-fg', '#0d1117'),
    };
  }

  // --- fetching -----------------------------------------------------------

  /** Asked per track and not yet answered, so a still view asks once. */
  const asked = new Map<string, Fetched>();

  /** Ask a window for every visible track whose held one does not serve this view. */
  function fetch() {
    if (!shown(sh, TYPE) || !present(sh)) return;
    const v = view();
    const w = W();
    const win = windowFor(axis, v, w);
    const gen = sh.trace.gen;
    for (const g of visibleGroups(groups, sc.scrollTop, H() - AXIS_H)) {
      if (g.kind === 'heading') continue;
      const key = g.key;
      // a held window that covers the view is still good to draw; so is one
      // in flight that will
      if (windowCovers(held.get(key)?.win, axis, v, w) || windowCovers(asked.get(key), axis, v, w)) continue;
      asked.set(key, win);
      const track: WindowQuery['track'] = g.kind === 'cpu' ? { cpu: g.cpu } : (g.pid === undefined ? { thr: g.thr } : { thr: g.thr, pid: g.pid });
      const query: WindowQuery = { track, axis: win.axis, lo: win.lo, hi: win.hi, width: win.width };
      sh.ctx.requestLatest(`intervals-win-${key}`, 'interval-window', { query }).then((m) => {
        if (gen !== sh.trace.gen) return;
        if (asked.get(key) === win) asked.delete(key);
        if (!m.available || !m.result || win.axis !== axis) return; // the axis flipped meanwhile
        held.set(key, { win, rows: m.result.rows, truncated: m.result.truncated, culled: m.result.culled });
        if (g.kind === 'thread') {
          const before = depths.get(key);
          const after = mergeDepths(before, depthsOf(m.result.rows));
          if (!before || after.call !== before.call || after.span !== before.span) {
            depths.set(key, after);
            relayout();
            scheduleFetch(); // groups below moved: others may have come into view
          }
        }
        draw();
      });
    }
  }

  let fetchQueued = false;
  function scheduleFetch() {
    if (fetchQueued) return;
    fetchQueued = true;
    requestAnimationFrame(() => { fetchQueued = false; fetch(); });
  }

  // --- drawing ------------------------------------------------------------

  function draw() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }

  function paint() {
    const w = W();
    const h = H();
    if (w <= 0 || h <= 0) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    if (!colors) readColors();
    const c = colors;
    const g = g2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);
    const v = view();
    const top = sc.scrollTop;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';

    // the tracks, clipped below the axis
    g.save();
    g.beginPath();
    g.rect(0, AXIS_H, w, h - AXIS_H);
    g.clip();
    bars.clear();
    for (const gr of visibleGroups(groups, top, h - AXIS_H)) {
      const y0 = gr.top - top + AXIS_H;
      if (gr.kind === 'heading' || gr.kind === 'thread') {
        g.fillStyle = c.head;
        g.fillRect(0, y0, w, HEAD_H);
        g.fillStyle = gr.kind === 'heading' ? c.dim : c.fg;
        g.fillText(gr.label, 6, y0 + HEAD_H / 2);
        if (gr.kind === 'heading') continue;
      }
      const hd = held.get(gr.key);
      if (!hd) continue;
      const laid = layoutBars(hd.rows, v, w).bars;
      bars.set(gr.key, laid);
      for (const b of laid) {
        const by = (b.lane === 'span' ? gr.spanTop : gr.callTop) + b.depth * ROW_H - top + AXIS_H;
        if (by + ROW_H < AXIS_H || by > h) continue;
        const idle = b.row.idle;
        const ck = colorKey(b.row);
        g.fillStyle = idle ? c.idle : c.pal[colorSlot(ck, PALETTE_N)];
        g.globalAlpha = b.lane === 'span' ? 0.75 : 1;
        g.fillRect(b.x, by + 1, Math.max(1, b.w - (b.w > 3 ? 1 : 0)), ROW_H - 2);
        g.globalAlpha = 1;
        if (b.row.open && b.w > 6) { // an open interval: a notch at its right end
          g.fillStyle = c.bg;
          g.fillRect(b.x + b.w - 3, by + 1, 2, ROW_H - 2);
        }
        if (b.w > 28 && !idle) {
          const x = Math.max(b.x, 0) + 3;
          const room = Math.min(b.x + b.w, w) - x - 3;
          if (room > 12) {
            g.fillStyle = c.text;
            g.fillText(fit(g, b.row.name ?? '', room), x, by + ROW_H / 2);
          }
        }
      }
      if (gr.kind === 'cpu') { // the CPU's name over its row, legible on any bar
        const y = gr.callTop - top + AXIS_H;
        const tw = g.measureText(gr.label).width + 8;
        g.fillStyle = c.head;
        g.globalAlpha = 0.85;
        g.fillRect(0, y, tw, ROW_H);
        g.globalAlpha = 1;
        g.fillStyle = c.dim;
        g.fillText(gr.label, 4, y + ROW_H / 2);
      }
    }
    g.restore();

    // the axis
    g.fillStyle = c.head;
    g.fillRect(0, 0, w, AXIS_H);
    g.fillStyle = c.grid;
    g.fillRect(0, AXIS_H - 1, w, 1);
    const unit = meta()?.unit;
    const t0 = meta()?.tMin ?? 0;
    for (const tv of axisTicks(v, w)) {
      const x = Math.round(xOf(tv, v, w)) + 0.5;
      g.fillStyle = c.grid;
      g.fillRect(x, AXIS_H - 5, 1, 5);
      g.fillStyle = c.dim;
      g.fillText(axis === 't' ? fmtDur(tv - t0, unit) : Math.round(tv).toLocaleString('en-US'), x + 3, AXIS_H / 2);
    }

    // the playhead: records applied on the seq axis, its time on the t axis
    const p = sh.playhead;
    if (p) {
      const pv = axis === 't' ? p.t : p.seq;
      if (Number.isFinite(pv)) {
        const x = Math.round(xOf(pv, v, w)) + 0.5;
        if (x >= 0 && x <= w) {
          g.fillStyle = c.playhead;
          g.fillRect(x - 0.5, 0, 1, h);
        }
      }
    }
  }

  // --- interaction ---------------------------------------------------------

  function setView(r: Range) {
    const v = clampAxis(r, axisBounds(axis, meta()));
    local[axis] = v;
    sh.ctx.setView?.(axis, v);
    draw();
    scheduleFetch();
  }

  /** The bar under a pointer at client (x, y), with its group. */
  function hit(cx: number, cy: number): { bar: Bar; group: Group } | null {
    const r = body.getBoundingClientRect();
    const x = cx - r.left;
    const y = cy - r.top - AXIS_H;
    if (y < 0) return null;
    const gr = groupAt(groups, y + sc.scrollTop);
    if (!gr) return null;
    const lane = laneAt(gr, y + sc.scrollTop);
    if (!lane) return null;
    const b = hitBar(bars.get(gr.key) || [], lane.lane, lane.depth, x);
    return b ? { bar: b, group: gr } : null;
  }

  function tooltip(cx: number, cy: number) {
    const h = hit(cx, cy);
    if (!h) { hideTooltip(OWNER); return; }
    const r = h.bar.row;
    const span = r.end - r.start;
    const dur = axis === 't' ? fmtDur(span, meta()?.unit) : fmtRecords(span);
    const kind = r.cpu !== undefined && r.cpu !== null ? `cpu ${r.cpu}` : r.lane;
    const who = r.cpu !== undefined && r.cpu !== null
      ? (r.idle ? 'idle' : `thread ${r.thr ?? '?'}`)
      : h.group.label;
    const more = h.bar.merged ? `\n<span class="dim">+${h.bar.merged} more in this pixel</span>` : '';
    showTooltip(OWNER, `<b>${esc(r.name ?? '?')}</b>  <span class="dim">${esc(kind)}</span>`
      + `\n${r.open ? '≥ ' : ''}${esc(dur)}${r.open ? ' <span class="dim">(open)</span>' : ''}`
      + `\n<span class="dim">${esc(who)}</span>${more}`);
    positionTooltipNearMouse();
  }

  function seekAt(cx: number, cy: number) {
    const h = hit(cx, cy);
    if (h) {
      const r = h.bar.row;
      if (typeof r.seq === 'number') sh.ctx.post({ type: 'jump', seq: seekSeqFor(r.seq) });
      else if (axis === 'seq') sh.ctx.post({ type: 'jump', seq: seekSeqFor(r.start) });
      else sh.ctx.post({ type: 'jump', t: r.start });
      return;
    }
    // empty space seeks to the value under the pointer, as a strip does
    const x = cx - body.getBoundingClientRect().left;
    const val = valAt(x, view(), W());
    sh.ctx.post(axis === 't' ? { type: 'seek', t: val } : { type: 'seek', seq: val });
  }

  sc.addEventListener('scroll', () => { draw(); scheduleFetch(); });
  sc.addEventListener('wheel', (e: WheelEvent) => {
    const r = body.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setView(zoomAt(view(), e.clientX - r.left, W(), Math.exp(e.deltaY * 0.0015)));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      setView(panBy(view(), -d, W()));
    }
    // a plain wheel scrolls the tracks (the scroller's own behavior)
  }, { passive: false });

  let drag: { x: number; v: Range; moved: boolean; id: number } | null = null;
  sc.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    // the scrollbar: leave it to the scroller
    if (e.clientX - sc.getBoundingClientRect().left > sc.clientWidth) return;
    drag = { x: e.clientX, v: view(), moved: false, id: e.pointerId };
    sc.setPointerCapture?.(e.pointerId);
  });
  sc.addEventListener('pointermove', (e: PointerEvent) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) { hideTooltip(OWNER); setView(panBy(drag.v, dx, W())); return; }
    }
    tooltip(e.clientX, e.clientY);
  });
  sc.addEventListener('pointerup', (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (d && !d.moved) seekAt(e.clientX, e.clientY);
  });
  sc.addEventListener('pointercancel', () => { drag = null; });
  sc.addEventListener('pointerleave', () => hideTooltip(OWNER));
  sc.addEventListener('dblclick', () => setView(axisBounds(axis, meta())));

  axisSel.onchange = () => {
    axis = axisSel.value === 'seq' ? 'seq' : 't';
    held.clear();
    asked.clear();
    draw();
    scheduleFetch();
  };

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { draw(); scheduleFetch(); }).observe(body);
  }

  function emptyMessage() {
    const m = el.querySelector('.ivl-empty') as HTMLElement;
    const msg = sh.ctx.ui.loaded && sh.trace.total === 0 ? 'this trace has no intervals'
      : sh.trace.total > 0 && !groups.length ? 'no thread or CPU tracks' : '';
    m.textContent = msg;
    m.hidden = !msg;
  }

  return {
    el,
    refresh() { colors = null; draw(); scheduleFetch(); },
    reset() {
      threads = [];
      cpus = [];
      depths.clear();
      held.clear();
      asked.clear();
      bars.clear();
      local.t = local.seq = null;
      relayout();
      emptyMessage();
      draw();
    },
    traceReady() {
      const o = orderTracks(sh.trace.tracks.threads, sh.trace.tracks.cpus);
      threads = o.threads;
      cpus = o.cpus;
      relayout();
      emptyMessage();
      draw();
      scheduleFetch();
    },
    playhead() { if (shown(sh, TYPE)) draw(); },
    view(v: Views) {
      for (const a of ['t', 'seq'] as Axis[]) {
        const r = v[a];
        if (!r) continue;
        const prev = strips[a];
        if (prev && prev.lo === r.lo && prev.hi === r.hi) continue;
        strips[a] = { lo: r.lo, hi: r.hi };
        local[a] = null; // the strips moved: follow them again
      }
      if (shown(sh, TYPE)) { draw(); scheduleFetch(); }
    },
  };
}

/** `s` cut with an ellipsis to fit `room` px. */
function fit(g: CanvasRenderingContext2D, s: string, room: number): string {
  if (g.measureText(s).width <= room) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${s.slice(0, mid)}…`).width <= room) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${s.slice(0, lo)}…` : '';
}
