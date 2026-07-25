// Heap domain: the Events panel — a virtualized list of the trace's
// sequential events, with click-to-jump, keyboard stepping, and drag
// selection over a seq range.
//
// Virtualization detail worth keeping in mind: browsers cap element height,
// so past EV_MAX_SPACER the spacer stops being 1:1 with the event count and
// scroll position becomes index-mapped and approximate. Both the scroll math
// and `yToSeq` inherit that approximation.
//
// What it needs from main.js arrives through initEventsPanel(deps).

import { $, $$, toCss } from '../shell/dom.ts';
import { raisePanel } from '../shell/panels.ts';
import { refreshDrawerDividers } from '../shell/drawers.ts';
import { esc, fmtNum } from '../fmt.ts';

let d = null;

const EV_ROW = 18;            // px per row
// Browsers cap how tall an element may be, so beyond this the spacer stops
// being 1:1 with the event count (~700 k events at EV_ROW) and scroll
// position is index-mapped instead. Two things degrade past that point and
// must keep working when this is touched: the scroll position is approximate
// (a given scrollTop maps to a proportional event index, not an exact row),
// and drag-selection in the list (`yToSeq`) inherits the same approximation.
const EV_MAX_SPACER = 12e6;
// total = row count in filtered mode (engine-reported, -1 until known);
// seqs = the seq of each currently loaded row, needed because filtered rows
// are no longer 1:1 with event indices
export const evState = { from: 0, count: 0, reqId: 0, lastSeq: -1, total: -1, seqs: [], posReqId: 0 };

const evFiltered = () => $('ev-filtered').checked;

// deps: { ui, post, fmtAllocSize, updateSelOverlay, requestSelMirror,
//         openSelPopover }
export function initEventsPanel(deps) {
  d = deps;
  wireEventsPanel();
}

function evLayout() {
  const all = d.ui.meta ? d.ui.meta.n : 0;
  const n = evFiltered() && evState.total >= 0 ? evState.total : all;
  const viewH = $('events-scroll').clientHeight;
  const spacerH = Math.min(n * EV_ROW, EV_MAX_SPACER);
  const visN = Math.max(1, Math.ceil(viewH / EV_ROW) + 1);
  const maxFrom = Math.max(0, n - visN + 1);
  return { n, viewH, spacerH, visN, maxFrom };
}

export function refreshEventsPanel() {
  if (!d.ui.loaded || $('events-panel').hidden) return;
  const L = evLayout();
  $('events-spacer').style.height = `${L.spacerH}px`;
  const sc = $('events-scroll');
  const denom = Math.max(1, L.spacerH - L.viewH);
  const from = Math.min(L.maxFrom, Math.round((sc.scrollTop / denom) * L.maxFrom));
  $('events-rows').style.top = `${sc.scrollTop}px`;
  evState.from = from;
  evState.count = L.visN;
  evState.reqId = d.ui.reqId++;
  d.post({ type: 'events', from, count: L.visN, reqId: evState.reqId, filtered: evFiltered() });
  updateEventsSelBand();
}

export function onEventsSlice(m) {
  if (m.reqId !== evState.reqId) return;
  if (evFiltered() && m.total !== undefined && m.total !== evState.total) {
    // filtered count (re)learned: re-lay out the virtual list once — the
    // follow-up reply carries the same total, so this converges immediately
    evState.total = m.total;
    refreshEventsPanel();
  }
  evState.seqs = m.events.map((ev) => ev.seq);
  const curSeq = d.ui.state ? d.ui.state.seq - 1 : -1;
  $('events-rows').innerHTML = m.events.map((ev) => `
    <div class="ev-row${ev.seq === curSeq ? ' cur' : ''}" data-seq="${ev.seq}" title="click: seek here and select the allocation">
      <span class="ev-seq">${fmtNum(ev.seq)}</span>
      <span class="ev-op ${['m', 'f', 'r'][ev.op]}">${['M', 'F', 'R'][ev.op]}</span>
      <span class="ev-addr">${ev.addr}</span>
      <span class="ev-size">${d.fmtAllocSize(ev.size)}</span>
      <span class="ev-site">${ev.site ? esc(ev.site) : ''}</span>
    </div>`).join('');
  $$('.ev-row', $('events-rows')).forEach((row) => {
    row.onclick = () => {
      const seq = +row.dataset.seq;
      if (d.ui.state && seq === d.ui.state.seq - 1) {
        // already the current event: flash exactly where it is on the map
        d.post({ type: 'flash-event', seq });
      } else {
        d.post({ type: 'jump', seq: seq + 1, select: true });
      }
    };
  });
}

// pulse overlay marking the exact location of an allocation (from the event
// list); a ping ring makes even sub-pixel allocations findable
export function flashRects(rects) {
  const view = $('addr-view');
  for (const r of (rects || []).slice(0, 16)) {
    const { x, y, w, h } = toCss(r, 3);
    const el = document.createElement('div');
    el.className = 'rect-flash';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    view.appendChild(el);
    const ping = document.createElement('div');
    ping.className = 'rect-ping';
    ping.style.left = `${x + w / 2}px`;
    ping.style.top = `${y + h / 2}px`;
    view.appendChild(ping);
    setTimeout(() => { el.remove(); ping.remove(); }, 1500);
  }
}

// keep the highlight (and, with follow on, the scroll position) on the
// current event as the playhead moves
export function updateEventsPanel() {
  if (!d.ui.loaded || $('events-panel').hidden || !d.ui.state) return;
  const cur = d.ui.state.seq - 1;
  if (cur === evState.lastSeq) return;
  evState.lastSeq = cur;
  // filtered rows are not 1:1 with seq, so visibility is judged from the
  // loaded rows' actual seq span instead of index arithmetic
  const visible = evFiltered()
    ? evState.seqs.length > 0 && cur >= evState.seqs[0] && cur <= evState.seqs[evState.seqs.length - 1]
    : cur >= evState.from && cur < evState.from + evState.count - 1;
  if ($('ev-follow').checked && !visible) {
    evScrollToSeq(cur);
    return;
  }
  $$('.ev-row', $('events-rows')).forEach((row) => {
    row.classList.toggle('cur', +row.dataset.seq === cur);
  });
}

function evScrollToSeq(seq) {
  if (evFiltered()) {
    // seq -> row index in the filtered list is an engine query
    evState.posReqId = d.ui.reqId++;
    d.post({ type: 'ev-pos', seq, reqId: evState.posReqId });
    return;
  }
  evScrollToIndex(seq);
}

export function onEvPos(m) {
  if (m.reqId !== evState.posReqId) return;
  evState.total = m.total;
  evScrollToIndex(m.pos);
}

function evScrollToIndex(idx) {
  const L = evLayout();
  const target = Math.max(0, Math.min(L.maxFrom, idx - Math.floor(L.visN / 2)));
  const y = (target / Math.max(1, L.maxFrom)) * Math.max(0, L.spacerH - L.viewH);
  $('events-scroll').scrollTop = y;
  refreshEventsPanel();
}

function stepEventsSelection(delta) {
  if (!d.ui.loaded || !d.ui.state || !d.ui.state.n) return;
  const cur = d.ui.state.seq - 1;
  let target = cur + delta;
  if (evFiltered() && evState.seqs.length) {
    // step along the filtered rows, not raw seq
    const i = evState.seqs.indexOf(cur);
    if (i >= 0) {
      const j = i + delta;
      if (j < 0 || j >= evState.seqs.length) return; // edge of the loaded slice
      target = evState.seqs[j];
    } else {
      const next = delta > 0
        ? evState.seqs.find((s) => s > cur)
        : [...evState.seqs].reverse().find((s) => s < cur);
      if (next === undefined) return;
      target = next;
    }
  }
  target = Math.max(0, Math.min(d.ui.state.n - 1, target));
  d.post({ type: 'jump', seq: target + 1, select: true });
}

// thin band in the Events panel's scroll gutter spanning the seq range of
// the current selection (direct if kind is seq, mirrored if kind is time)
export function updateEventsSelBand() {
  const band = $('events-sel-band');
  if (!d.ui.sel) { band.hidden = true; return; }
  const seqRange = d.ui.sel.kind === 1 ? d.ui.sel : d.ui.selMirror;
  if (!seqRange || $('events-panel').hidden) { band.hidden = true; return; }
  const L = evLayout();
  const sc = $('events-scroll');
  // viewport-relative y, from the currently-visible row window (evState.from)
  // — what refreshEventsPanel keeps accurate even once the spacer height is
  // capped for very long traces (EV_MAX_SPACER); #events-sel-band is a plain
  // sibling of the scroll content (unlike #events-rows, which self-cancels
  // scrollTop via its own `top` style), so re-add scrollTop to place it in
  // the scroll container's coordinate space
  let y0, y1;
  if (evFiltered()) {
    // filtered rows: the band covers the loaded rows whose seq is in range
    // (rows filtered out in between simply collapse)
    const seqs = evState.seqs;
    y0 = seqs.filter((s) => s < seqRange.lo).length * EV_ROW;
    y1 = seqs.filter((s) => s < seqRange.hi).length * EV_ROW;
  } else {
    y0 = (seqRange.lo - evState.from) * EV_ROW;
    y1 = (seqRange.hi - evState.from) * EV_ROW;
  }
  band.hidden = y1 <= 0 || y0 >= L.viewH;
  if (!band.hidden) {
    const top = Math.max(0, Math.min(L.viewH, y0));
    const bot = Math.max(0, Math.min(L.viewH, y1));
    band.style.top = `${top + sc.scrollTop}px`;
    band.style.height = `${Math.max(2, bot - top)}px`;
  }
}

export function resetEventsPanel() {
  evState.lastSeq = -1;
  evState.total = -1;
  evState.seqs = [];
  $('events-scroll').scrollTop = 0;
  $('events-rows').innerHTML = '';
  if (!$('events-panel').hidden) refreshEventsPanel();
}

function wireEventsPanel() {
  $('ev-filtered').onchange = () => {
    resetEventsPanel();
    updateEventsPanel();
  };

  {
    const scEl = $('events-scroll');
    scEl.addEventListener('scroll', refreshEventsPanel);
    scEl.addEventListener('pointerdown', () => scEl.focus({ preventScroll: true }));
    scEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      stepEventsSelection(e.key === 'ArrowDown' ? 1 : -1);
    });
  }
  new ResizeObserver(() => refreshEventsPanel()).observe($('events-scroll'));

  // drag a seq range directly in the Events list — feeds the same UI.sel path
  // as shift-dragging the events (strip-s) timeline, so zoom/tag/crop from the
  // selection popover and the mirrored band on both strips all just work
  {
    const scEl = $('events-scroll');
    let dragFromY = null;
    let dragFromSeq = 0;
    let dragCaptured = false;
    const yToSeq = (y) => {
      const row = (y - scEl.getBoundingClientRect().top) / EV_ROW;
      if (evFiltered()) {
        // filtered rows carry arbitrary seqs: read the nearest loaded row
        const seqs = evState.seqs;
        if (!seqs.length) return 0;
        return seqs[Math.max(0, Math.min(seqs.length - 1, Math.floor(row)))];
      }
      return evState.from + row;
    };
    scEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !d.ui.loaded) return;
      dragFromY = e.clientY;
      dragFromSeq = yToSeq(e.clientY);
      dragCaptured = false;
      // don't capture yet: setPointerCapture re-targets the eventual click to
      // this element too, which would swallow plain row clicks (jump-to-event)
    });
    scEl.addEventListener('pointermove', (e) => {
      if (dragFromY === null || Math.abs(e.clientY - dragFromY) < 3) return;
      if (!dragCaptured) { scEl.setPointerCapture(e.pointerId); dragCaptured = true; }
      const n = d.ui.state ? d.ui.state.n : (d.ui.meta ? d.ui.meta.n : 0);
      const b = yToSeq(e.clientY);
      d.ui.sel = { kind: 1, lo: Math.max(0, Math.min(dragFromSeq, b)), hi: Math.min(n, Math.max(dragFromSeq, b)) };
      d.updateSelOverlay();
      d.requestSelMirror();
    });
    scEl.addEventListener('pointerup', (e) => {
      if (dragFromY === null) return;
      const moved = dragCaptured;
      dragFromY = null;
      dragCaptured = false;
      if (moved && d.ui.sel && d.ui.sel.kind === 1) d.openSelPopover(e.clientX, e.clientY);
    });
  }

  $('btn-events').onclick = () => {
    const p = $('events-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) {
      raisePanel(p);
      evState.lastSeq = -1;
      refreshEventsPanel();
      updateEventsPanel();
    }
    if (p.dataset.dockSide) refreshDrawerDividers(p.dataset.dockSide);
  };
  $('ev-follow').onchange = () => {
    evState.lastSeq = -1;
    updateEventsPanel();
  };
}
