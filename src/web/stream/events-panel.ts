// The Events panel — a virtualized list of the trace's spine records, of
// every domain (DOM-001), with click-to-jump, keyboard stepping, drag
// selection over a seq range, and a chip per domain to leave its records out.
// Rows are rendered in stream/stream-model.ts: what the record is first (a
// heap record's size and site, a function's name, a log's message), then where
// (thread, short address), with a columns menu for the optional fields.
//
// Virtualization detail worth keeping in mind: browsers cap element height,
// so past EV_MAX_SPACER the spacer stops being 1:1 with the event count and
// scroll position becomes index-mapped and approximate. Both the scroll math
// and `yToSeq` inherit that approximation.
//
// What it needs from main.ts arrives through initEventsPanel(deps).

import { $, $$, toCss } from '../shell/dom.ts';
import { layout } from '../shell/layout.ts';
import { hoverTips } from '../shell/tooltip.ts';
import { edgeSelection, selectedEdges } from '../intervals/selection.ts';
import { esc, fmtNum } from '../fmt.ts';
import { revealLogSeq } from '../logs/logs-panel.ts';
import {
  domainChips, includedDomains, parseColumns, renderRow, threadNames, toggleColumn,
  type DomainChip, type EventColumn, type ThreadNames,
} from './stream-model.ts';

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

// the domain toggles: one chip per domain the trace has records of, and the
// ids of those left out. Per trace — a new trace lists everything again.
const domainState = { chips: [] as DomainChip[], excluded: new Set<string>(), names: new Map() as ThreadNames };

// which optional fields a row shows (the header's columns menu): a viewer's
// preference, kept across traces and reloads
const COLUMNS_KEY = 'heapviz:events-columns';
let columns = parseColumns(readStored(COLUMNS_KEY));

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

const evFiltered = () => $('ev-filtered').checked;
/** The domains the list includes, or undefined when it is the whole spine. */
const evDomains = () => includedDomains(domainState.chips, domainState.excluded);
// the list is indexed (not 1:1 with seq) when filtered or a domain is left out
const evIndexed = () => evFiltered() || evDomains() !== undefined;

// deps: { ui, post, fmtAllocSize, updateSelOverlay, requestSelMirror,
//         openSelPopover, selectInterval }
export function initEventsPanel(deps) {
  d = deps;
  wireEventsPanel();
}

function evLayout() {
  const all = d.ui.meta ? d.ui.meta.n : 0;
  const n = evIndexed() && evState.total >= 0 ? evState.total : all;
  const viewH = $('events-scroll').clientHeight;
  const spacerH = Math.min(n * EV_ROW, EV_MAX_SPACER);
  const visN = Math.max(1, Math.ceil(viewH / EV_ROW) + 1);
  const maxFrom = Math.max(0, n - visN + 1);
  return { n, viewH, spacerH, visN, maxFrom };
}

export function refreshEventsPanel() {
  if (!d.ui.loaded || !layout.isOpen('events-panel')) return;
  const L = evLayout();
  $('events-spacer').style.height = `${L.spacerH}px`;
  const sc = $('events-scroll');
  const denom = Math.max(1, L.spacerH - L.viewH);
  const from = Math.min(L.maxFrom, Math.round((sc.scrollTop / denom) * L.maxFrom));
  $('events-rows').style.top = `${sc.scrollTop}px`;
  evState.from = from;
  evState.count = L.visN;
  evState.reqId = d.ui.reqId++;
  d.post({ type: 'events', from, count: L.visN, reqId: evState.reqId, filtered: evFiltered(), domains: evDomains() });
  updateEventsSelBand();
}

export function onEventsSlice(m) {
  if (m.reqId !== evState.reqId) return;
  if (evIndexed() && m.total !== undefined && m.total !== evState.total) {
    // indexed count (re)learned: re-lay out the virtual list once — the
    // follow-up reply carries the same total, so this converges immediately
    evState.total = m.total;
    refreshEventsPanel();
  }
  evState.seqs = m.events.map((ev) => ev.seq);
  const ctx = {
    domains: d.ui.meta?.domains, names: domainState.names,
    fmtAllocSize: d.fmtAllocSize, curSeq: d.ui.state ? d.ui.state.seq - 1 : -1, columns,
    pickedSeqs: selectedEdges(d.ui.intervalSel ?? null),
  };
  $('events-rows').innerHTML = m.events.map((ev) => renderRow(ev, ctx)).join('');
  $$('.ev-row', $('events-rows')).forEach((row) => {
    row.onclick = (e) => {
      const seq = +row.dataset.seq;
      if (row.dataset.edge) {
        // an interval edge: seek there, and select (and open) its interval
        d.post({ type: 'jump', seq: seq + 1, select: true });
        // the window opens beside the list, not over it
        d.selectInterval?.(edgeSelection(seq, { x: row.getBoundingClientRect().right, y: e.clientY }));
      } else if (row.dataset.log) {
        d.post({ type: 'jump', seq: seq + 1, select: true });
        revealLogSeq(seq);
      } else if (d.ui.state && seq === d.ui.state.seq - 1 && !row.dataset.custom) {
        // already the current event: flash exactly where it is on the map
        d.post({ type: 'flash-event', seq });
      } else {
        // a record of another domain is nowhere on the map, so re-clicking it
        // seeks (and reopens a custom event's window) instead of flashing
        d.post({ type: 'jump', seq: seq + 1, select: true });
      }
    };
  });
}

/** The interval selection changed: mark the rows of its edges (IVL-UI-005). */
export function markIntervalSelection() {
  const picked = selectedEdges(d.ui.intervalSel ?? null);
  $$('.ev-row', $('events-rows')).forEach((row) => {
    row.classList.toggle('picked', !!row.dataset.edge && picked.has(+row.dataset.seq));
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
  if (!d.ui.loaded || !layout.isOpen('events-panel') || !d.ui.state) return;
  const cur = d.ui.state.seq - 1;
  if (cur === evState.lastSeq) return;
  evState.lastSeq = cur;
  // filtered rows are not 1:1 with seq, so visibility is judged from the
  // loaded rows' actual seq span instead of index arithmetic
  const visible = evIndexed()
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
  if (evIndexed()) {
    // seq -> row index in an indexed list is an engine query
    evState.posReqId = d.ui.reqId++;
    d.post({ type: 'ev-pos', seq, reqId: evState.posReqId, filtered: evFiltered(), domains: evDomains() });
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
  if (evIndexed() && evState.seqs.length) {
    // step along the listed rows, not raw seq
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
  if (!seqRange || !layout.isOpen('events-panel')) { band.hidden = true; return; }
  const L = evLayout();
  const sc = $('events-scroll');
  // viewport-relative y, from the currently-visible row window (evState.from)
  // — what refreshEventsPanel keeps accurate even once the spacer height is
  // capped for very long traces (EV_MAX_SPACER); #events-sel-band is a plain
  // sibling of the scroll content (unlike #events-rows, which self-cancels
  // scrollTop via its own `top` style), so re-add scrollTop to place it in
  // the scroll container's coordinate space
  let y0, y1;
  if (evIndexed()) {
    // indexed rows: the band covers the loaded rows whose seq is in range
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

/** A freshly loaded trace (the panel table's refill): every domain listed again. */
export function resetEventsPanel() {
  domainState.chips = domainChips(d.ui.meta?.domains);
  domainState.excluded.clear();
  domainState.names = threadNames(d.ui.meta?.domains);
  renderDomainChips();
  relistEvents();
}

// one chip per domain with records; a trace of one domain needs none
function renderDomainChips() {
  const bar = $('ev-domains');
  const chips = domainState.chips;
  bar.hidden = chips.length < 2;
  bar.innerHTML = chips.map((c) => {
    const on = !domainState.excluded.has(c.id);
    return `<button type="button" class="ev-chip d-${esc(c.id)}${on ? ' on' : ''}" data-domain="${esc(c.id)}" aria-pressed="${on}"`
      + ` title="${esc(`${on ? 'Hide' : 'Show'} ${c.name} records (${fmtNum(c.count)})`)}">${esc(c.name)}</button>`;
  }).join('');
}

function relistEvents() {
  evState.lastSeq = -1;
  evState.total = -1;
  evState.seqs = [];
  $('events-scroll').scrollTop = 0;
  $('events-rows').innerHTML = '';
  if (layout.isOpen('events-panel')) refreshEventsPanel();
}

function renderColumnsMenu() {
  $$('#ev-cols-menu input[data-col]').forEach((box) => { box.checked = !!columns[box.dataset.col]; });
}

function wireColumnsMenu() {
  const btn = $('ev-cols-btn');
  const menu = $('ev-cols-menu');
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  renderColumnsMenu();
  btn.onclick = (e) => { e.stopPropagation(); setOpen(menu.hidden); };
  menu.addEventListener('change', (e) => {
    const col = e.target?.dataset?.col as EventColumn | undefined;
    if (!col) return;
    columns = toggleColumn(columns, col);
    try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns)); } catch { /* storage unavailable: this session only */ }
    renderColumnsMenu();
    refreshEventsPanel();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !(e.target as Element | null)?.closest?.('.ev-cols')) setOpen(false);
  });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btn.focus(); } });
}

function wireEventsPanel() {
  wireColumnsMenu();
  // the kind chip's and the row's words, in the app's tooltip (NAV-005)
  hoverTips($('events-scroll'), 'events');
  $('ev-filtered').onchange = () => {
    relistEvents();
    updateEventsPanel();
  };
  $('ev-domains').addEventListener('click', (e) => {
    const chip = e.target?.closest?.('.ev-chip');
    if (!chip) return;
    const id = chip.dataset.domain;
    if (domainState.excluded.has(id)) domainState.excluded.delete(id);
    else domainState.excluded.add(id);
    renderDomainChips();
    relistEvents();
    updateEventsPanel();
  });

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
      if (evIndexed()) {
        // indexed rows carry arbitrary seqs: read the nearest loaded row
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

  // the shell shows the window (its toolbar toggle is in the panel table);
  // the list was not kept current while closed, so it catches up on opening
  layout.onOpen('events-panel', () => {
    evState.lastSeq = -1;
    refreshEventsPanel();
    updateEventsPanel();
  });
  $('ev-follow').onchange = () => {
    evState.lastSeq = -1;
    updateEventsPanel();
  };
}
