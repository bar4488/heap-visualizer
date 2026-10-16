// Interval domain: the Tracks panel (IVL-UI-003) — a flame chart drawn on the
// main thread. A `Threads` section with one group per thread (its calls by
// depth, then its span lane) and a `CPUs` section with one row per CPU (run
// slices colored by thread), on the timeline's x-axis: the strips' time or
// seq view range, by the head's axis toggle. The plot spans the panel's full
// width with no inset, as the strips do, so a time lines up with them; the
// track names sit in a translucent gutter laid over its left edge.
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
// Input is the strips' (TL-004, timeline-interaction.ts): click or drag
// seeks, wheel zooms about the pointer, shift+wheel pans, double-click shows
// the whole axis, shift+drag selects a range (the strips' own selection and
// popover, through ctx.select). The tracks scroll vertically by the
// scrollbar or a wheel over the name gutter. Zoom and pan drive the strips'
// view through ctx.setView when main.ts provides it, else a local view that
// yields to the strips again as soon as they move. The geometry is
// flame-model.ts and tested there; this file is the canvas and the events.

import { esc } from '../fmt.ts';
import { dpr } from '../shell/dom.ts';
import { hideTooltip, positionTooltipNearMouse, showTooltip } from '../shell/tooltip.ts';
import {
  PLAYHEAD, SELECT_MIN_PX, axisBounds, clampAxis, paintPlayhead, selectionRange, valAt, wheelView, xOf,
} from '../timeline-interaction.ts';
import {
  GROUP_GAP, GUTTER_W, HEAD_H, ROW_H, axisTicks, colorKey, colorSlot, depthsOf, groupAt, hitBar,
  laneAt, layoutBars, layoutGroups, mergeDepths, scrollToRow, selectedBox, viewToShow, visibleGroups, windowCovers,
  windowFor, type Bar, type Depths, type Fetched, type Group,
} from './flame-model.ts';
import { intervalSelection } from './selection.ts';
import { fmtDur, fmtRecords, orderTracks } from './intervals-model.ts';
import { panelElement, present, shown, token, type Shared } from './shared.ts';
import type { Axis, Range, Views, WindowQuery, WindowRow } from './types.ts';

const TYPE = 'intervals-tracks';
const AXIS_H = 20;
const PALETTE_N = 12;
const OWNER = 'intervals-tracks';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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
  /** The pointer's x while it is over the panel (the hover line), else null. */
  let hoverX: number | null = null;

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
      bg: token(el, '--ivl-track-bg', '#0d1117'),
      fg: token(el, '--ivl-fg', '#e6edf3'),
      dim: token(el, '--ivl-dim', '#8b949e'),
      grid: token(el, '--ivl-grid', '#30363d'),
      tick: token(el, '--ivl-tick', '#ffffff0a'),
      head: token(el, '--ivl-head', '#161b22'),
      section: token(el, '--ivl-section', '#161b22'),
      gutter: token(el, '--ivl-gutter', '#0d1117d0'),
      idle: token(el, '--ivl-idle', '#8b949e'),
      text: token(el, '--ivl-bar-fg', '#0d1117'),
      sel: token(el, '--ivl-sel', '#58a6ff2e'),
      picked: token(el, '--ivl-picked', '#ffffff'),
      accent: token(el, '--accent', '#58a6ff'),
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
            if (performance.now() < followSelUntil) scrollToSelected();
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
    const ticks = axisTicks(v, w);
    g.textBaseline = 'middle';

    // faint tick lines down the plot, under everything
    g.fillStyle = c.tick;
    for (const tv of ticks) g.fillRect(Math.round(xOf(tv, v, w)), AXIS_H, 1, h - AXIS_H);

    // the tracks, clipped below the axis
    g.save();
    g.beginPath();
    g.rect(0, AXIS_H, w, h - AXIS_H);
    g.clip();
    bars.clear();
    const shownGroups = visibleGroups(groups, top, h - AXIS_H);
    g.font = `11px ${MONO}`;
    for (const gr of shownGroups) {
      if (gr.kind === 'heading') continue;
      const hd = held.get(gr.key);
      if (!hd) continue;
      const laid = layoutBars(hd.rows, v, w).bars;
      bars.set(gr.key, laid);
      for (const b of laid) {
        const by = (b.lane === 'span' ? gr.spanTop : gr.callTop) + b.depth * ROW_H - top + AXIS_H;
        if (by + ROW_H < AXIS_H || by > h) continue;
        paintBar(g, b, by, w);
      }
    }

    paintSelected(g, v, top, w, h);

    // the name gutter over the plot's left edge, then the heads across it
    for (const gr of shownGroups) paintGutter(g, gr, gr.top - top + AXIS_H, w);
    // the thread scrolled into keeps its head pinned on top, pushed up by the next
    const first = shownGroups[0];
    if (first?.kind === 'thread' && first.top < top) {
      paintHead(g, first, Math.min(AXIS_H, first.top + first.height - GROUP_GAP - HEAD_H - top + AXIS_H), w);
    }
    g.restore();

    // the selection: the strips' own, or its mirror, on this axis
    const want = axis === 't' ? 0 : 1;
    const ui = sh.ctx.ui;
    const sel = ui.sel?.kind === want ? ui.sel : ui.selMirror?.kind === want ? ui.selMirror : null;
    if (sel) {
      const x0 = xOf(sel.lo, v, w);
      const x1 = xOf(sel.hi, v, w);
      if (x1 >= 0 && x0 <= w) {
        g.fillStyle = c.sel;
        g.fillRect(x0, AXIS_H, x1 - x0, h - AXIS_H);
        g.fillStyle = c.accent;
        g.fillRect(x0, AXIS_H, 1, h - AXIS_H);
        g.fillRect(x1 - 1, AXIS_H, 1, h - AXIS_H);
      }
    }

    // the axis
    g.fillStyle = c.section;
    g.fillRect(0, 0, w, AXIS_H);
    g.fillStyle = c.grid;
    g.fillRect(0, AXIS_H - 1, w, 1);
    g.font = `10px ${MONO}`;
    const unit = meta()?.unit;
    const t0 = meta()?.tMin ?? 0;
    for (const tv of ticks) {
      const x = Math.round(xOf(tv, v, w));
      g.fillStyle = c.grid;
      g.fillRect(x, AXIS_H - 5, 1, 5);
      g.fillStyle = c.dim;
      g.fillText(axis === 't' ? fmtDur(tv - t0, unit) : Math.round(tv).toLocaleString('en-US'), x + 3, AXIS_H / 2);
    }

    // the hover line, then the playhead (records applied on the seq axis,
    // its time on the t axis) in the strips' own look
    if (hoverX !== null) {
      g.fillStyle = PLAYHEAD.hover;
      g.fillRect(Math.round(hoverX), 0, 1, h);
    }
    const p = sh.playhead;
    const pv = p ? (axis === 't' ? p.t : p.seq) : NaN;
    if (Number.isFinite(pv)) {
      const x = xOf(pv, v, w);
      if (x >= -2 && x <= w + 2) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        paintPlayhead(g, x * dpr, 0, ph, dpr);
      }
    }
  }

  /** The selected interval's box on the axis: where it ends when still open. */
  function selBox() {
    const r = sh.selRow;
    if (!r) return null;
    const m = meta();
    return selectedBox(groups, r, axis, axis === 't' ? (m?.tMax ?? r.t) : (m?.n ?? r.seq));
  }

  /** The selected interval (IVL-UI-005): its bar outlined, at least a few px wide. */
  function paintSelected(g: CanvasRenderingContext2D, v: Range, top: number, w: number, h: number) {
    const box = selBox();
    if (!box) return;
    const by = box.y - top + AXIS_H;
    if (by + ROW_H < AXIS_H || by > h) return;
    let x0 = xOf(box.lo, v, w);
    let x1 = xOf(box.hi, v, w);
    if (x1 - x0 < 8) { const m = (x0 + x1) / 2; x0 = m - 4; x1 = m + 4; }
    if (x1 < 0 || x0 > w) return;
    x0 = Math.max(-3, x0);
    x1 = Math.min(w + 3, x1);
    const c = colors;
    g.fillStyle = c.accent;
    g.globalAlpha = 0.22;
    g.fillRect(x0, by, x1 - x0, ROW_H);
    g.globalAlpha = 1;
    g.lineWidth = 2;
    g.strokeStyle = c.picked;
    g.strokeRect(x0 + 1, by + 1, x1 - x0 - 2, ROW_H - 2);
    g.lineWidth = 1;
    g.strokeStyle = c.accent;
    g.strokeRect(x0 - 0.5, by - 0.5, x1 - x0 + 1, ROW_H + 1);
  }

  /**
   * Until this time (ms), the selected interval's row is kept scrolled into
   * view as tracks above it grow (their deeper calls arrive after the
   * selection), unless the user scrolls or presses first.
   */
  let followSelUntil = 0;

  /** Scroll the selected interval's row into view, when it is out of it. */
  function scrollToSelected() {
    const box = selBox();
    if (!box) return;
    const top = scrollToRow(box.y, sc.scrollTop, H() - AXIS_H);
    if (top !== null) sc.scrollTop = top;
  }

  /** Bring the selected interval into view: its row scrolled to, the axis panned to it if it is off-screen. */
  function revealSelected() {
    const box = selBox();
    if (!box) return;
    followSelUntil = performance.now() + 2000;
    scrollToSelected();
    const v = view();
    // the name gutter covers the plot's left edge: a bar under it is not in view
    const nv = viewToShow(v, box.lo, box.hi, valAt(GUTTER_W + 4, v, W()));
    if (nv !== v) setView(nv);
  }

  /** A section heading (THREADS, CPUS) across the panel. */
  function paintSection(g: CanvasRenderingContext2D, label: string, y: number, w: number) {
    const c = colors;
    g.fillStyle = c.section;
    g.fillRect(0, y, w, HEAD_H);
    g.fillStyle = c.grid;
    g.fillRect(0, y + HEAD_H - 1, w, 1);
    g.font = `600 10px ${MONO}`;
    g.fillStyle = c.dim;
    g.fillText(label.toUpperCase(), 9, y + HEAD_H / 2 + 0.5);
    g.font = `11px ${MONO}`;
  }

  /** One bar: a call or span colored by name, a CPU's slice by thread; idle slices muted. */
  function paintBar(g: CanvasRenderingContext2D, b: Bar, by: number, w: number) {
    const c = colors;
    const bw = Math.max(1, b.w - (b.w > 3 ? 1 : 0));
    if (b.row.idle) { // a thin, dim stroke: the CPU ran nothing
      g.fillStyle = c.idle;
      g.globalAlpha = 0.35;
      g.fillRect(b.x, by + ROW_H / 2 - 1, bw, 2);
      g.globalAlpha = 1;
      return;
    }
    g.fillStyle = c.pal[colorSlot(colorKey(b.row), PALETTE_N)];
    g.globalAlpha = b.lane === 'span' ? 0.7 : 0.92;
    g.fillRect(b.x, by + 1, bw, ROW_H - 2);
    g.globalAlpha = 1;
    if (b.row.open && b.w > 6) { // an open interval: a notch at its right end
      g.fillStyle = c.bg;
      g.fillRect(b.x + b.w - 3, by + 1, 2, ROW_H - 2);
    }
    // the name, where the bar is out from under the gutter and has room for a few letters
    const x = Math.max(b.x, GUTTER_W) + 4;
    const room = Math.min(b.x + b.w, w) - x - 3;
    if (room >= 26) {
      g.fillStyle = c.text;
      g.fillText(fit(g, b.row.name ?? '', room), x, by + ROW_H / 2 + 0.5);
    }
  }

  /**
   * A group's gutter and names: a section heading or a thread's head across
   * the panel (the thread's color and name), then a translucent gutter over
   * its rows with their lane names, or a CPU's number.
   */
  function paintGutter(g: CanvasRenderingContext2D, gr: Group, y0: number, w: number) {
    const c = colors;
    if (gr.kind === 'heading') { paintSection(g, gr.label, y0, w); return; }
    const rowsTop = gr.kind === 'thread' ? y0 + HEAD_H : y0;
    const rowsH = (gr.callRows + gr.spanRows) * ROW_H;
    g.fillStyle = c.gutter;
    g.fillRect(0, rowsTop, GUTTER_W, rowsH);
    g.fillStyle = c.grid;
    g.fillRect(GUTTER_W, rowsTop, 1, rowsH);
    if (gr.kind === 'thread') {
      paintHead(g, gr, y0, w);
      g.font = `10px ${MONO}`;
      g.fillStyle = c.dim;
      if (gr.callRows) g.fillText('calls', 9, gr.callTop - gr.top + y0 + ROW_H / 2);
      if (gr.spanRows) g.fillText('spans', 9, gr.spanTop - gr.top + y0 + ROW_H / 2);
    } else {
      g.fillStyle = c.fg;
      g.fillText(fit(g, gr.label, GUTTER_W - 16), 9, y0 + ROW_H / 2 + 0.5);
    }
    g.font = `11px ${MONO}`;
  }

  /** A thread's head across the panel: its color and its name. */
  function paintHead(g: CanvasRenderingContext2D, gr: Group, y: number, w: number) {
    const c = colors;
    g.fillStyle = c.head;
    g.fillRect(0, y, w, HEAD_H);
    g.fillStyle = c.grid;
    g.fillRect(0, y, w, 1);
    g.fillRect(0, y + HEAD_H - 1, w, 1);
    g.fillStyle = c.pal[colorSlot(`thr:${gr.thr}`, PALETTE_N)];
    g.fillRect(0, y + 1, 3, HEAD_H - 2);
    g.font = `600 11px ${MONO}`;
    g.fillStyle = c.fg;
    g.fillText(fit(g, gr.label, w - 16), 9, y + HEAD_H / 2 + 0.5);
  }

  // --- interaction: the strips' gestures (TL-004) ---------------------------

  function setView(r: Range) {
    const v = clampAxis(r, axisBounds(axis, meta()));
    local[axis] = v;
    sh.ctx.setView?.(axis, v);
    draw();
    scheduleFetch();
  }

  /** The pointer's x and content y in the plot, from client coordinates. */
  function at(cx: number, cy: number) {
    const r = body.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top - AXIS_H + sc.scrollTop, inBody: cy - r.top >= AXIS_H };
  }

  /** The bar under a pointer at client (x, y), with its group. */
  function hit(cx: number, cy: number): { bar: Bar; group: Group } | null {
    const p = at(cx, cy);
    if (!p.inBody) return null;
    const gr = groupAt(groups, p.y);
    if (!gr) return null;
    const lane = laneAt(gr, p.y);
    if (!lane) return null;
    const b = hitBar(bars.get(gr.key) || [], lane.lane, lane.depth, p.x);
    return b ? { bar: b, group: gr } : null;
  }

  function tooltip(cx: number, cy: number) {
    const p = at(cx, cy);
    const h = hit(cx, cy);
    if (!h) {
      // over the gutter: the track's whole name; over the plot: where the pointer is
      const gr = p.inBody && p.x < GUTTER_W ? groupAt(groups, p.y) : null;
      if (gr) {
        showTooltip(OWNER, `<b>${esc(gr.label)}</b>`);
      } else {
        const val = valAt(p.x, view(), W());
        showTooltip(OWNER, axis === 't'
          ? `<span class="dim">t</span> ${esc(fmtDur(val - (meta()?.tMin ?? 0), meta()?.unit))}`
          : `<span class="dim">seq</span> ${Math.floor(val).toLocaleString('en-US')}`);
      }
      positionTooltipNearMouse();
      return;
    }
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

  /** Seek to the value under pixel x, as a strip does. */
  function seekTo(x: number) {
    const val = valAt(x, view(), W());
    sh.ctx.post(axis === 't' ? { type: 'seek', t: val } : { type: 'seek', seq: val });
  }

  function select(x0: number, x1: number, end?: { x: number; y: number }) {
    sh.ctx.select?.(axis, selectionRange(view(), W(), x0, x1), end);
    draw();
  }

  function clearSelection() {
    sh.ctx.select?.(axis, null);
    draw();
  }

  /** Whether client x is on the scroller's own scrollbar. */
  const onScrollbar = (cx: number) => cx - sc.getBoundingClientRect().left > sc.clientWidth;

  let dragging = false;
  let selecting: number | null = null; // the anchor x while shift-dragging a range

  sc.addEventListener('scroll', () => { hideTooltip(OWNER); draw(); scheduleFetch(); });
  sc.addEventListener('wheel', (e: WheelEvent) => {
    followSelUntil = 0;
    const p = at(e.clientX, e.clientY);
    // over the name gutter a plain wheel scrolls the tracks (the scroller's own behavior)
    if (p.x < GUTTER_W && !e.shiftKey) return;
    e.preventDefault();
    setView(wheelView(view(), e, p.x, W()));
  }, { passive: false });

  sc.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || onScrollbar(e.clientX)) return;
    sc.setPointerCapture?.(e.pointerId);
    followSelUntil = 0;
    const x = at(e.clientX, e.clientY).x;
    clearSelection();
    if (e.shiftKey) {
      selecting = x;
      select(x, x);
    } else {
      dragging = true;
      seekTo(x);
      // a bar also selects its interval, which opens the Interval window
      const h = hit(e.clientX, e.clientY);
      if (h) sh.ctx.selectInterval?.(intervalSelection(h.bar.row.ivl, { x: e.clientX, y: e.clientY }));
    }
  });
  sc.addEventListener('pointermove', (e: PointerEvent) => {
    const x = at(e.clientX, e.clientY).x;
    hoverX = onScrollbar(e.clientX) ? null : x;
    draw();
    if (selecting !== null) select(selecting, x);
    else if (dragging) seekTo(x);
    tooltip(e.clientX, e.clientY);
  });
  sc.addEventListener('pointerup', (e: PointerEvent) => {
    dragging = false;
    if (selecting === null) return;
    const x = at(e.clientX, e.clientY).x;
    const a = selecting;
    selecting = null;
    if (Math.abs(x - a) > SELECT_MIN_PX) select(a, x, { x: e.clientX, y: e.clientY });
    else clearSelection();
  });
  sc.addEventListener('pointercancel', () => {
    dragging = false;
    if (selecting !== null) {
      selecting = null;
      clearSelection();
    }
  });
  sc.addEventListener('pointerleave', () => {
    hoverX = null;
    draw();
    hideTooltip(OWNER);
  });
  sc.addEventListener('dblclick', (e: MouseEvent) => {
    if (!onScrollbar(e.clientX)) setView(axisBounds(axis, meta()));
  });

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
    /** The interval selection changed: outline it, and with `reveal` bring it into view. */
    selected(reveal: boolean) {
      if (!shown(sh, TYPE)) return;
      if (reveal) revealSelected();
      draw();
    },
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
