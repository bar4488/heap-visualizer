// heap-visualizer main thread: DOM chrome and input. All heavy lifting (parse, seek,
// raster) happens in the worker; this file forwards input and paints overlays.

import {
  fmtBytes, fmtHexSize, fmtAllocSize as fmtAllocSizeMode, fmtNum, parseSize,
  esc, clampView,
} from './fmt.ts';
import {
  initRpc, request, requestLatest, cancelLatest, handleReply,
} from './rpc.ts';
import {
  $, $$, $1, dpr, setHtml, toCss, toCssLen,
} from './shell/dom.ts';
import { raisePanel, showPanel, makePanelWindow } from './shell/panels.ts';
import { showTooltip, hideTooltip, positionTooltipNearMouse } from './shell/tooltip.ts';
import { heapPanels } from './heap/panels.ts';
import {
  initAnalysis, markDirty, tagIdFor, syncTagDatalist, buildMarksPanel,
  buildTagsSection, buildNamesSection, sendAddrMarks, gotoAddr, addAddrMark,
  renderAddrMarkLines, setAddrMarkYs, addBookmark, updateMarkers,
  requestAllocInfo, buildMarks, applyMarks,
} from './heap/analysis.ts';
import {
  initEventsPanel, evState, refreshEventsPanel, onEventsSlice, flashRects,
  updateEventsPanel, onEvPos, resetEventsPanel, updateEventsSelBand,
} from './heap/events-panel.ts';
import {
  initSession, restoreSession,
  restoreMarksAutosave, resetSessionSnapshot,
} from './session.ts';
import {
  applyFilterCompletion, utf8Offset,
} from './filter-completion.ts';
import {
  hasTopLevelPredicate, quoteFilterString, toggleFilterPredicate,
} from './filter-actions.ts';
import {
  drawersState, dock, initDrawers, drawerEl, refreshDrawerDividers,
} from './shell/drawers.ts';
import type {
  AllocInfo, Domain, FilterCompletions, FromWorker, Range, TraceMeta,
} from './protocol.ts';

/** A user-authored tag. Its id is its index here + 1; id 0 means untagged. */
type Tag = { name: string; color: string };
type SavedFilter = { name: string; source: string };

/** A range selection or its mirror, in whichever domain `kind` names. */
type Selection = { kind: Domain; lo: number; hi: number };

/**
 * The shared main-thread state. Every other module receives it as `deps.ui`
 * (see initAnalysis / initSession / initEventsPanel) instead of importing it,
 * so this file stays its one owner.
 *
 * The optional fields are the ones filled in after the literal below — either
 * at startup (`worker`, `seek`, `drawers`) or when a trace loads and the user
 * starts working (`fileName`, `detailInfo`, `tlLocalAt`, `detailWasPinned`).
 */
type UIState = {
  meta: TraceMeta | null;
  warnings: any[];
  /** The last `state` message from the worker. */
  state: Extract<FromWorker, { type: 'state' }> | null;
  playing: boolean;
  /** The two strips' current views: time and sequence. */
  tlT: Range;
  tlS: Range;
  selected: number | null;
  reqId: number;
  loaded: boolean;
  tags: Tag[];
  /** Tag id -> tagged creator-event count; 0 counts the untagged. */
  tagCounts: Record<number, number>;
  /** Creator event -> the name the user gave that allocation. */
  names: Map<number, { name: string; id: number; addr: string }>;
  /** Creator event -> a `#rrggbb` override for every color mode. */
  allocColors: Map<number, string>;
  /** Time marks. */
  bookmarks: { name: string; seq: number; t: number }[];
  /** Address marks; `addr` is a `0x…` string. */
  addrMarks: { name: string; addr: string }[];
  /** Named filter source saved with the authored analysis. */
  savedFilters: SavedFilter[];
  /** The active range selection, and the same range in the other domain. */
  sel: Selection | null;
  selMirror: Selection | null;
  /** Tags/bookmarks/addr marks/names/colors changed since the last save or load. */
  marksDirty: boolean;
  /** The crop window in the seq domain, or null; see setCrop/clearCrop. */
  crop: Range | null;
  /** Filter text visible in the editor and the last source accepted by core. */
  filterDraft: string;
  filterApplied: string;
  filterMode: 1 | 2;
  /** Per-strip view setters, keyed by domain; filled by setupTimeline. */
  setView: Record<number, (v: Range, mirror?: boolean) => void>;
  /** Locked viewport: stepping never auto-scrolls. */
  locked: boolean;
  /** Horizontal zoom/pan on the address line. */
  xview: { zoom: number; pan: number };
  worker?: TypedWorker;
  seek?: (seq: number) => void;
  fileName?: string;
  detailInfo?: AllocInfo | null;
  /** When the user last zoomed a strip locally; see onState. */
  tlLocalAt?: number;
  drawers?: typeof drawersState;
  detailWasPinned?: boolean;
};

// Mirrored from src/core/src/render.rs (CAT / RAMP): the engine paints
// allocations, this file paints the matching legend chips and filter
// swatches. Keep the two in sync by hand.
const CAT = ['#58a6ff', '#3fb950', '#f2cc60', '#ff7b72', '#bc8cff', '#39c5cf',
  '#f778ba', '#d29922', '#7ee787', '#ffa657', '#79c0ff', '#d2a8ff'];
const RAMP = ['#0e4429', '#006d32', '#26a641', '#39d353'];
const OPS = ['malloc', 'free', 'realloc'];

const worker = new Worker('worker.js', { type: 'module' }) as TypedWorker;
initRpc(worker);

const UI: UIState = {
  meta: null,
  warnings: [],
  state: null,
  playing: false,
  tlT: { lo: 0, hi: 1 },
  tlS: { lo: 0, hi: 1 },
  selected: null,
  reqId: 1,
  loaded: false,
  tags: [],
  tagCounts: {},
  names: new Map(),
  allocColors: new Map(),
  bookmarks: [],
  addrMarks: [],
  savedFilters: [],
  sel: null,
  selMirror: null,
  marksDirty: false,
  crop: null,
  filterDraft: '',
  filterApplied: '',
  filterMode: 1,
  setView: {},
  locked: false,
  xview: { zoom: 1, pan: 0 },
};

// expose for tests / console poking
window.__heap_visualizer = UI;
UI.worker = worker;
UI.seek = (seq) => worker.postMessage({ type: 'seek', seq });

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function allocSizeFormat() {
  return $('alloc-size-format')?.value === 'hex' ? 'hex' : 'human';
}

function fmtAllocSize(b) {
  return fmtAllocSizeMode(b, allocSizeFormat());
}

function fmtAllocSizeDetail(b) {
  if (allocSizeFormat() !== 'hex') return `${fmtBytes(b)} (${fmtNum(b)} B)`;
  return `${fmtHexSize(b)} (${fmtBytes(b)}, ${fmtNum(b)} B)`;
}

const NS_PER_UNIT = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 };

function fmtTime(t) {
  const unit = UI.meta ? UI.meta.unit : 'ns';
  const f = NS_PER_UNIT[unit];
  if (!f) return `${Math.round(t)} ${unit || 'ticks'}`;
  const ns = t * f;
  if (ns < 1e3) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(3)} s`;
}

// ---------------------------------------------------------------------------
// worker bootstrap
// ---------------------------------------------------------------------------

const addrCanvas = $('addr');
const tltCanvas = $('tlt');
const tlsCanvas = $('tls');
const addrScroll = $('addr-scroll');
const overlay = $('addr-overlay');

{
  const a = addrCanvas.transferControlToOffscreen();
  const t = tltCanvas.transferControlToOffscreen();
  const s = tlsCanvas.transferControlToOffscreen();
  worker.postMessage(
    { type: 'init', wasmURL: new URL('heap_visualizer_core.wasm', location.href).href, addr: a, tlt: t, tls: s, dpr },
    [a, t, s],
  );
}

function sendResizes() {
  const send = (which, el) => {
    const r = el.getBoundingClientRect();
    worker.postMessage({ type: 'resize', which, w: r.width * dpr, h: r.height * dpr, dpr });
  };
  // measure the addr canvas box itself (addr-view), not the scroll container:
  // the container's rect includes the scrollbar, which would squeeze the
  // raster and shift it against the overlay highlights
  send('addr', $('addr-view'));
  send('tlt', $('strip-t'));
  send('tls', $('strip-s'));
}
new ResizeObserver(sendResizes).observe($('addr-view'));
new ResizeObserver(sendResizes).observe($('strip-t'));

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

async function loadBuffer(buf, name) {
  $('progress').hidden = false;
  $('progress-pct').textContent = '0%';
  UI.fileName = name;
  worker.postMessage({ type: 'load', buffer: buf }, [buf]);
}

async function loadURL(url) {
  try {
    // always revalidate: a stale cached trace (e.g. an old demo.heapl)
    // would resurface warnings that were fixed in the file
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    loadBuffer(await resp.arrayBuffer(), url.split('/').pop());
  } catch (e) {
    $('st-trace').textContent = `failed to load ${url}: ${(e as Error).message}`;
  }
}

// Route an incoming file: a saved analysis (single JSON object with the
// heapVisualizerAnalysis marker) or a trace stream.
async function handleFile(f) {
  const head = await f.slice(0, 300).text();
  if (head.includes('"heapVisualizerAnalysis"')) {
    try {
      applyMarks(JSON.parse(await f.text()));
    } catch (e) {
      $('st-trace').textContent = `analysis load failed: ${(e as Error).message}`;
    }
  } else {
    loadBuffer(await f.arrayBuffer(), f.name);
  }
}

$('btn-open').onclick = () => $('file-input').click();
$('file-input').onchange = (ev) => {
  const f = ev.target.files[0];
  if (f) handleFile(f);
  ev.target.value = '';
};
$('btn-demo').onclick = () => loadURL('demo.heapl');

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('drop-overlay').hidden = false;
});
// hide when the drag leaves the window or is cancelled (the overlay itself is
// pointer-events: none, so it never swallows these events)
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) $('drop-overlay').hidden = true;
});
document.addEventListener('dragend', () => { $('drop-overlay').hidden = true; });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop-overlay').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// ---------------------------------------------------------------------------
// worker messages
// ---------------------------------------------------------------------------

worker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'ready': {
      sendResizes();
      worker.postMessage({ type: 'set', key: 'rowPx', value: +$('row-px').value });
      const url = new URLSearchParams(location.search).get('trace');
      if (url) loadURL(url);
      break;
    }
    case 'progress':
      $('progress-pct').textContent = `${m.pct}%`;
      break;
    case 'error':
      $('progress').hidden = true;
      $('st-trace').textContent = `load failed: ${m.message}`;
      break;
    case 'loaded':
      onLoaded(m);
      break;
    case 'state':
      onState(m);
      break;
    case 'addr-flash': {
      const flash = document.createElement('div');
      flash.className = 'addr-flash';
      flash.style.top = `${m.y}px`;
      flash.style.height = `${+$('row-px').value}px`;
      $('addr-view').appendChild(flash);
      setTimeout(() => flash.remove(), 1400);
      break;
    }
    case 'scrollTo':
      if (m.virtualH !== undefined) {
        const wantSpacer = Math.max(0, toCssLen(m.virtualH) - addrScroll.clientHeight);
        $('addr-spacer').style.height = `${wantSpacer}px`;
      }
      noteProgScroll(m.y);
      addrScroll.scrollTop = m.y;
      break;
    case 'stepped':
      if (m.event) {
        const e = m.event;
        // the worker already selected the allocation this event touches
        if (e.e !== undefined && e.e !== null) UI.selected = e.e;
        $('st-info').textContent =
          `${OPS[e.op]} id=${e.id} ${e.addr} ${fmtAllocSize(e.size)}${e.site ? ' · ' + e.site : ''}`;
        // open the allocation dialog for the malloc/free we stepped onto
        if (m.info) fillDetailPanel(m.info);
      }
      break;
    case 'xview':
      // the worker panned horizontally (centering a stepped-to allocation)
      if (m.pan !== undefined) {
        UI.xview.pan = m.pan;
        updateHzButton();
      }
      break;
    case 'events':
      onEventsSlice(m);
      break;
    case 'ev-pos':
      onEvPos(m);
      break;
    case 'flash-rects':
      flashRects(m.rects);
      break;
    case 'addr-at':
      if (m.addr) addAddrMark(m.addr);
      break;
    case 'addr-selected':
      if (m.info) {
        UI.selected = m.info.e;
        fillDetailPanel(m.info);
      }
      break;
    case 'tagged':
      if (m.tag > 0) {
        $('st-info').textContent =
          `tagged ${fmtNum(m.count)} allocations “${UI.tags[m.tag - 1]?.name ?? m.tag}”`;
      }
      buildLegend();
      break;
    case 'tag-counts':
      UI.tagCounts = {};
      for (const c of m.counts) UI.tagCounts[c.tag] = c.count;
      buildTagsSection();
      buildLegend();
      break;
    default:
      // rpc replies (pick / tlhover / convert / alloc-info / tags-dump):
      // resolved by reqId in one place, see rpc.ts
      handleReply(m);
  }
};

function onLoaded(m) {
  $('progress').hidden = true;
  UI.meta = m.meta;
  UI.warnings = m.warnings;
  UI.loaded = true;
  UI.selected = null;
  UI.tags = [];
  UI.tagCounts = {};
  UI.names.clear();
  UI.allocColors.clear();
  UI.bookmarks = [];
  UI.addrMarks = [];
  UI.savedFilters = [];
  UI.marksDirty = false;
  UI.crop = null;
  UI.filterDraft = '';
  UI.filterApplied = '';
  UI.filterMode = 1;
  filterApplyGeneration++;
  $('btn-filter').classList.remove('active');
  $('filter-panel').classList.remove('applying');
  $('filter-apply').disabled = false;
  resetSessionSnapshot(); // new trace: the previous snapshot says nothing
  updateCropIndicator();
  sendAddrMarks();
  sendNames();
  // the wasm view is recreated per trace: re-apply sticky toolbar prefs
  worker.postMessage({ type: 'set', key: 'showAll', value: $('show-all').checked });
  worker.postMessage({ type: 'set', key: 'sizeLabels', value: $('show-sizes').checked });
  worker.postMessage({ type: 'set', key: 'allocSizeFormat', value: allocSizeFormat() });
  worker.postMessage({ type: 'set', key: 'overlapMode', value: +$('overlap-mode').value });
  worker.postMessage({ type: 'set', key: 'ghostMode', value: $('ghost-mode').checked });
  clearSelection();
  syncTagDatalist();
  updateMarkers();
  $('btn-analysis').hidden = false;
  $('btn-analysis').classList.remove('active');
  $('btn-mark').hidden = false;
  $('btn-events').hidden = false;
  $('an-save').hidden = false;
  $('an-load').hidden = false;
  $('btn-play').disabled = false;
  UI.xview = { zoom: 1, pan: 0 };
  updateHzButton();
  $('trace-title').textContent = m.meta.title || UI.fileName || '';
  $('st-trace').textContent =
    `${UI.fileName || ''} · ${fmtNum(m.n)} events (M ${fmtNum(m.meta.nMalloc)} / F ${fmtNum(m.meta.nFree)} / R ${fmtNum(m.meta.nRealloc)})` +
    ` · peak ${fmtBytes(m.meta.peakLive)} · ${m.meta.addrMin}–${m.meta.addrMax}`;

  // warnings badge
  const wc = m.meta.warnTotal;
  $('btn-warnings').hidden = wc === 0;
  $('warn-count').textContent = fmtNum(wc);

  // every panel refills itself from the new trace, in table order — the UI
  // fields each one reads were all reset above
  for (const { build } of PANELS) build?.();

  $('detail-panel').hidden = true;
  UI.detailInfo = null;
  // pinned allocation windows reference events of the previous trace
  $$('.pinned-detail').forEach((w) => w.remove());
  refreshDrawerDividers('left');
  refreshDrawerDividers('right');
  // the marks autosave embeds its own session snapshot, so applying both
  // would run applySession twice back-to-back (double seeks, double
  // filter/layout messages, pinned windows torn down and rebuilt) — prefer
  // the marks blob when there is one, and fall back to the session alone
  if (!restoreMarksAutosave()) restoreSession();
}

function onState(m) {
  UI.state = m;
  UI.playing = m.playing;
  // adopt the worker's view ranges unless the user is actively zooming
  // (optimistic local updates win for ~250ms so wheel steps compound)
  if (!UI.tlLocalAt || performance.now() - UI.tlLocalAt > 250) {
    UI.tlT = m.tlT;
    UI.tlS = m.tlS;
  }
  $('btn-play').textContent = m.playing ? '⏸' : '▶';
  $('st-pos').textContent =
    `seq ${fmtNum(m.seq)} / ${fmtNum(m.n)} · t ${fmtTime(m.t)}`;
  $('st-live').innerHTML =
    `live <b>${fmtNum(m.liveCount)}</b> allocs · <b>${fmtBytes(m.liveBytes)}</b>`;
  const viewH = addrScroll.clientHeight;
  const wantSpacer = Math.max(0, toCssLen(m.virtualH) - viewH);
  const spacer = $('addr-spacer');
  if (Math.abs(spacer.offsetHeight - wantSpacer) > 1) {
    spacer.style.height = `${wantSpacer}px`;
  }
  $('empty-hint').style.display = m.liveCount === 0 ? 'block' : 'none';
  drawMoveLink(m.moveLink);
  updateSelOverlay();
  drawCropBands();
  updateMarkers();
  setAddrMarkYs(m.addrMarkYs || []);
  renderAddrMarkLines();
  updateEventsPanel();
}

// ---------------------------------------------------------------------------
// move-link / selection overlay (SVG, CSS px)
// ---------------------------------------------------------------------------

let hoverRects = [];

function svgRect(cls, r) {
  const c = toCss(r);
  return `<rect class="${cls}" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"/>`;
}

function drawMoveLink(ml) {
  const svg = overlay;
  let content = '';
  for (const r of hoverRects) {
    content += svgRect('hover-rect', r);
  }
  if (ml && ml.op === 2) {
    for (const r of ml.old) {
      content += svgRect('ml-old', r);
    }
    for (const r of ml.new) {
      content += svgRect('ml-new', r);
    }
    if (ml.old.length && ml.new.length) {
      const o = toCss(ml.old[0], 0);
      const n = toCss(ml.new[0], 0);
      content += `<line class="ml-line" x1="${o.x + o.w / 2}" y1="${o.y + o.h / 2}" x2="${n.x + n.w / 2}" y2="${n.y + n.h / 2}"/>`;
    }
  } else if (ml && ml.op === 1) {
    for (const r of ml.old) {
      content += svgRect('ml-old', r);
    }
  } else if (ml && ml.op === 0) {
    // fresh malloc: outline the new allocation so small ones are findable
    for (const r of ml.new) {
      content += svgRect('ml-new', r);
    }
  }
  setHtml(svg, content);
}

// ---------------------------------------------------------------------------
// playback controls
// ---------------------------------------------------------------------------

function buildSpeedSelect() {
  const sel = $('play-speed');
  const mode = $('play-mode').value;
  sel.innerHTML = '';
  if (mode === 't') {
    for (const secs of [5, 15, 60, 180]) {
      const o = document.createElement('option');
      o.value = String(secs);
      o.textContent = secs < 60 ? `trace in ${secs}s` : `trace in ${secs / 60}m`;
      sel.appendChild(o);
    }
    sel.value = '15';
  } else {
    for (const eps of [100, 1000, 10000, 100000]) {
      const o = document.createElement('option');
      o.value = String(eps);
      o.textContent = `${eps >= 1000 ? eps / 1000 + 'k' : eps} ev/s`;
      sel.appendChild(o);
    }
    sel.value = '1000';
  }
}
$('play-mode').onchange = buildSpeedSelect;

function playRate() {
  const mode = $('play-mode').value;
  const v = +$('play-speed').value;
  if (mode === 't') {
    const span = Math.max(1, (UI.meta ? UI.meta.tMax - UI.meta.tMin : 1));
    return span / v;
  }
  return v;
}

function togglePlay() {
  if (!UI.loaded) return;
  if (UI.playing) worker.postMessage({ type: 'pause' });
  else worker.postMessage({ type: 'play', mode: $('play-mode').value, rate: playRate() });
}
$('btn-play').onclick = togglePlay;
$('btn-step-back').onclick = (e) => worker.postMessage({ type: 'step', delta: e.shiftKey ? -100 : -1 });
$('btn-step-fwd').onclick = (e) => worker.postMessage({ type: 'step', delta: e.shiftKey ? 100 : 1 });

function toggleLock() {
  UI.locked = !UI.locked;
  $('btn-lock').textContent = UI.locked ? '🔒' : '🔓';
  $('btn-lock').classList.toggle('active', UI.locked);
  worker.postMessage({ type: 'set', key: 'locked', value: UI.locked });
  $('st-info').textContent = UI.locked
    ? 'viewport locked — stepping will not scroll the address view'
    : 'viewport unlocked — stepping follows the touched allocation';
}
$('btn-lock').onclick = toggleLock;

$('btn-jump').onclick = doJump;
$('jump-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });

function doJump() { execJump($('jump-input').value.trim()); }

function isJumpValue(v) {
  const addrText = v.startsWith('a:') ? v.slice(2).trim() : v;
  return /^0x[0-9a-f]+$/i.test(addrText) || v.startsWith('t:') || /^\d/.test(v);
}

function execJump(v) {
  if (!v) return;
  const addrText = v.startsWith('a:') ? v.slice(2).trim() : v;
  if (/^0x[0-9a-f]+$/i.test(addrText)) {
    // go to address: scroll the address-line, playhead untouched (selects
    // the live allocation there, if any — see the worker's goto-addr handler)
    try {
      const a = BigInt(addrText);
      worker.postMessage({
        type: 'goto-addr',
        lo: Number(a & 0xffffffffn),
        hi: Number((a >> 32n) & 0xffffffffn),
      });
      $('st-info').textContent = `→ ${addrText} (nearest live row)`;
    } catch { /* unparseable, ignore */ }
  } else if (v.startsWith('t:')) {
    worker.postMessage({ type: 'jump', t: parseFloat(v.slice(2)) });
  } else if (/^\d/.test(v)) {
    // parseFloat, not parseInt, so scientific notation works for a bare seq
    // the same way it already does after `t:` (1e6 → 1000000, not 1)
    worker.postMessage({ type: 'jump', seq: Math.round(parseFloat(v)) });
  }
}

// ---------------------------------------------------------------------------
// search / goto-anything overlay (g)
// ---------------------------------------------------------------------------

let searchItems = [];
let searchSel = 0;

function buildSearchTargets(q) {
  const items = [];
  const match = (...parts) => !q || parts.join(' ').toLowerCase().includes(q);
  UI.bookmarks.forEach((b) => {
    if (match(b.name)) items.push({
      kind: 'mark', label: b.name, sub: `seq ${fmtNum(b.seq)} · ${fmtTime(b.t)}`,
      action: () => worker.postMessage({ type: 'seek', seq: b.seq }),
    });
  });
  UI.addrMarks.forEach((m) => {
    if (match(m.name, m.addr)) items.push({
      kind: 'addr', label: m.name, sub: m.addr, action: () => gotoAddr(m.addr),
    });
  });
  UI.names.forEach((v, e) => {
    if (match(v.name, v.addr)) items.push({
      kind: 'alloc', label: v.name, sub: `id ${v.id} · ${v.addr}`,
      action: () => worker.postMessage({ type: 'jump', seq: e + 1, select: true }),
    });
  });
  UI.warnings.forEach((w) => {
    if (match(w.msg)) items.push({
      kind: 'warn', label: w.msg, sub: `#${w.seq}`,
      action: () => worker.postMessage({ type: 'jump', seq: w.seq + 1 }),
    });
  });
  return items.slice(0, 60);
}

function currentSearchItems() {
  const raw = $('search-input').value.trim();
  const items = [];
  if (raw && isJumpValue(raw)) {
    items.push({ kind: 'go', label: `Go to ${raw}`, sub: '', action: () => execJump(raw) });
  }
  items.push(...buildSearchTargets(raw.toLowerCase()));
  return items;
}

function renderSearchResults() {
  searchItems = currentSearchItems();
  searchSel = Math.min(searchSel, Math.max(0, searchItems.length - 1));
  const list = $('search-results');
  list.innerHTML = searchItems.length
    ? searchItems.map((it, i) => `<div class="sr-row${i === searchSel ? ' sel' : ''}" data-i="${i}">
        <span class="sr-kind">${it.kind}</span><span class="sr-label">${esc(it.label)}</span><span class="sr-sub">${esc(it.sub || '')}</span>
      </div>`).join('')
    : '<div class="empty">no matches</div>';
  $$('.sr-row', list).forEach((row) => {
    row.onclick = () => { searchItems[+row.dataset.i].action(); closeSearchOverlay(); };
  });
}

function openSearchOverlay() {
  if (!UI.loaded) return;
  $('search-overlay').hidden = false;
  const inp = $('search-input');
  inp.value = '';
  searchSel = 0;
  renderSearchResults();
  inp.focus();
}

function closeSearchOverlay() {
  $('search-overlay').hidden = true;
}

$('search-input').addEventListener('input', () => { searchSel = 0; renderSearchResults(); });
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchSel = Math.min(searchItems.length - 1, searchSel + 1);
    renderSearchResults();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchSel = Math.max(0, searchSel - 1);
    renderSearchResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const it = searchItems[searchSel];
    if (it) { it.action(); closeSearchOverlay(); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearchOverlay();
  }
});
$('search-overlay').addEventListener('pointerdown', (e) => {
  if (e.target === $('search-overlay')) closeSearchOverlay();
});

function isEditableTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
    || target?.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (isEditableTarget(e.target)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); worker.postMessage({ type: 'step', delta: e.shiftKey ? 100 : 1 }); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); worker.postMessage({ type: 'step', delta: e.shiftKey ? -100 : -1 }); }
  else if (e.key === 'Home') { worker.postMessage({ type: 'seek', seq: 0 }); }
  else if (e.key === 'End') { if (UI.state) worker.postMessage({ type: 'seek', seq: UI.state.n }); }
  else if (e.key === 'm' && UI.loaded) { addBookmark(); }
  else if (e.key === 'l' || e.key === 'L') { toggleLock(); }
  else if (e.key === 'g' && UI.loaded) {
    e.preventDefault();
    openSearchOverlay();
  }
});

// ---------------------------------------------------------------------------
// view controls
// ---------------------------------------------------------------------------

const DEFAULT_ROW_BYTES = 0x1000;

function rowBytesValue() {
  const input = $('row-bytes');
  if (!input.value.trim()) return DEFAULT_ROW_BYTES;
  return parseSize(input.value);
}

function setRowBytesInput(value) {
  $('row-bytes').value = value === DEFAULT_ROW_BYTES ? '' : fmtBytes(value);
}

$('row-bytes').onchange = () => {
  const input = $('row-bytes');
  const value = rowBytesValue();
  input.style.borderColor = value > 0 ? '' : 'var(--red)';
  if (value > 0) worker.postMessage({ type: 'set', key: 'rowBytes', value });
};
$('row-px').onchange = () =>
  worker.postMessage({ type: 'set', key: 'rowPx', value: +$('row-px').value });
// collapse threshold: plain number = rows, byte suffix / 0x… = bytes
function parseCollapseMin(v: string): { mode: 'rows' | 'bytes'; value: number } | null {
  v = (v || '').trim().toLowerCase();
  if (!v) return null;
  if (/^\d+$/.test(v)) return { mode: 'rows', value: Math.max(1, parseInt(v, 10)) };
  if (/^0x[0-9a-f]+$/.test(v)) return { mode: 'bytes', value: parseInt(v, 16) };
  const b = parseSize(v);
  return b > 0 ? { mode: 'bytes', value: b } : null;
}

function sendCollapseMin() {
  const spec = parseCollapseMin($('collapse-min').value);
  $('collapse-min').style.borderColor = spec ? '' : 'var(--red)';
  if (spec) worker.postMessage({ type: 'set', key: 'collapseMin', ...spec });
}
$('collapse-min').onchange = sendCollapseMin;
$('color-mode').onchange = () => {
  worker.postMessage({ type: 'set', key: 'colorMode', value: +$('color-mode').value });
  buildLegend();
};
$('show-all').onchange = () =>
  worker.postMessage({ type: 'set', key: 'showAll', value: $('show-all').checked });
$('show-sizes').onchange = () =>
  worker.postMessage({ type: 'set', key: 'sizeLabels', value: $('show-sizes').checked });
$('overlap-mode').onchange = () => {
  worker.postMessage({ type: 'set', key: 'overlapMode', value: +$('overlap-mode').value });
  savePrefs();
};
$('ghost-mode').onchange = () => {
  worker.postMessage({ type: 'set', key: 'ghostMode', value: $('ghost-mode').checked });
  savePrefs();
};
$('alloc-size-format').onchange = () => sendAllocSizeFormat();

// ---------------------------------------------------------------------------
// app-level display preferences. Unlike the per-trace session (below), the
// overlap display and freed-nested ghosts are how the user wants *every*
// trace drawn, so they persist globally and are restored at startup; the
// engine picks them up from the DOM on each trace load (onLoaded).
// ---------------------------------------------------------------------------

const PREFS_KEY = 'heapviz:prefs';

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      overlapMode: $('overlap-mode').value,
      ghosts: $('ghost-mode').checked,
    }));
  } catch { /* storage full/unavailable: silently skip */ }
}

(function restorePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    // legacy "outer on top" (2) folds into "ignore" (1)
    if (p.overlapMode !== undefined) $('overlap-mode').value = String(Math.min(+p.overlapMode || 0, 1));
    if (p.ghosts !== undefined) $('ghost-mode').checked = !!p.ghosts;
  } catch { /* corrupt/unavailable: defaults stand */ }
})();
$('show-addrs').onchange = () =>
  worker.postMessage({ type: 'set', key: 'addrLabels', value: $('show-addrs').checked });

function sendAllocSizeFormat() {
  worker.postMessage({ type: 'set', key: 'allocSizeFormat', value: allocSizeFormat() });
  refreshAllocSizeDisplays();
}

function refreshAllocSizeDisplays() {
  if (UI.detailInfo && !$('detail-panel').hidden) {
    buildDetailBody($('detail-body'), UI.detailInfo);
  }
  $$('.pinned-detail').forEach((win) => {
    if (win._allocInfo) buildDetailBody(win.querySelector('.panel-body'), win._allocInfo);
  });
  refreshEventsPanel();
}

// the worker draws in-allocation labels; it needs the user-assigned names
function sendNames() {
  worker.postMessage({
    type: 'names',
    names: [...UI.names.entries()].map(([e, v]) => [e, v.name]),
  });
}

// ---------------------------------------------------------------------------
// legend
// ---------------------------------------------------------------------------

function buildLegend() {
  const mode = +$('color-mode').value;
  const el = $('legend');
  if (!UI.meta || mode === 0) { el.hidden = true; return; }
  let html = '';
  if (mode === 1) {
    UI.meta.sites.forEach((s, i) => {
      const predicate = `site == ${quoteFilterString(s.name)}`;
      html += `<button class="chip filter-chip${hasTopLevelPredicate(UI.filterApplied, predicate) ? ' active' : ''}"
        data-filter-predicate="${esc(predicate)}"><span class="swatch" style="background:${CAT[i % 12]}"></span>${esc(s.name)}</button>`;
    });
  } else if (mode === 2) {
    UI.meta.thrs.forEach((t, i) => {
      const predicate = `thread == ${t.thr}`;
      html += `<button class="chip filter-chip${hasTopLevelPredicate(UI.filterApplied, predicate) ? ' active' : ''}"
        data-filter-predicate="${predicate}"><span class="swatch" style="background:${CAT[(i + 5) % 12]}"></span>thr ${t.thr}</button>`;
    });
  } else if (mode === 3) {
    html = `<span class="chip">16 B <span class="ramp" style="background:linear-gradient(90deg,${RAMP.join(',')})"></span> 16 MiB (log size)</span>`;
  } else if (mode === 4) {
    html = `<span class="chip">young <span class="ramp" style="background:linear-gradient(90deg,#7ee787,#39c5cf,#1f4fa8)"></span> old (log age vs oldest live)</span>`;
  } else if (mode === 5) {
    html = UI.tags.map((t, i) => {
      const predicate = `tag == ${quoteFilterString(t.name)}`;
      return `<button class="chip filter-chip${hasTopLevelPredicate(UI.filterApplied, predicate) ? ' active' : ''}"
        data-filter-predicate="${esc(predicate)}"><span class="swatch" style="background:${t.color}"></span>${esc(t.name)} · ${fmtNum(UI.tagCounts[i + 1] || 0)}</button>`;
    }).join('');
    const missing = 'tag is missing';
    html += `<button class="chip filter-chip${hasTopLevelPredicate(UI.filterApplied, missing) ? ' active' : ''}"
      data-filter-predicate="${missing}"><span class="swatch" style="background:#39414a"></span>untagged · ${fmtNum(UI.tagCounts[0] || 0)}</button>`;
    if (!UI.tags.length) {
      html = '<span class="chip">no tags yet</span>' + html;
    }
  }
  el.innerHTML = html;
  el.hidden = html === '';
  sendResizes();
}

$('legend').onclick = (event) => {
  const chip = event.target.closest('[data-filter-predicate]');
  if (!chip) return;
  const source = toggleFilterPredicate(
    UI.filterDraft,
    chip.dataset.filterPredicate,
    event.shiftKey ? '||' : '&&',
  );
  void applyFilterSource(source);
};

// ---------------------------------------------------------------------------
// filter expression editor
// ---------------------------------------------------------------------------

let filterCheckTimer = 0;
let filterCheckGeneration = 0;
let filterApplyGeneration = 0;
let filterCompletions: FilterCompletions | null = null;
let filterCompletionIndex = 0;

function setFilterStatus(text, kind = '') {
  const status = $('filter-status');
  status.textContent = text;
  status.className = `filter-status${kind ? ` ${kind}` : ''}`;
}

function showFilterDiagnostic(diagnostic) {
  setFilterStatus(`Invalid: ${diagnostic.message} at byte ${diagnostic.start}`, 'invalid');
}

function hideFilterCompletions() {
  const input = $('filter-source');
  const list = $('filter-completions');
  filterCompletions = null;
  filterCompletionIndex = 0;
  list.hidden = true;
  list.innerHTML = '';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function setActiveFilterCompletion(index) {
  if (!filterCompletions?.items.length) return;
  filterCompletionIndex = (index + filterCompletions.items.length)
    % filterCompletions.items.length;
  $$('[role=option]', $('filter-completions')).forEach((option, i) => {
    const active = i === filterCompletionIndex;
    option.classList.toggle('active', active);
    option.setAttribute('aria-selected', String(active));
    if (active) option.scrollIntoView({ block: 'nearest' });
  });
  $('filter-source').setAttribute(
    'aria-activedescendant',
    `filter-completion-${filterCompletionIndex}`,
  );
}

function showFilterCompletions(completions) {
  const input = $('filter-source');
  const list = $('filter-completions');
  filterCompletions = completions;
  filterCompletionIndex = 0;
  list.innerHTML = completions.items.map((candidate, index) =>
    `<div id="filter-completion-${index}" class="filter-completion" role="option"
      aria-selected="${index === 0}" data-completion="${index}">
      <span class="filter-completion-label">${esc(candidate.label)}</span>
      <span class="filter-completion-kind">${esc(candidate.kind)}</span>
      ${candidate.detail ? `<span class="filter-completion-detail">${esc(candidate.detail)}</span>` : ''}
    </div>`).join('') +
    (completions.hasMore
      ? '<div class="filter-completion-more">more — type to narrow</div>'
      : '');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  setActiveFilterCompletion(0);
}

function acceptFilterCompletion(index = filterCompletionIndex) {
  if (!filterCompletions) return;
  const candidate = filterCompletions.items[index];
  if (!candidate) return;
  const input = $('filter-source');
  const edit = applyFilterCompletion(input.value, filterCompletions, candidate);
  input.value = edit.source;
  input.setSelectionRange(edit.cursor, edit.cursor);
  hideFilterCompletions();
  input.focus();
  filterEdited();
}

function scheduleFilterCheck(explicit = false) {
  const input = $('filter-source');
  clearTimeout(filterCheckTimer);
  const generation = ++filterCheckGeneration;
  filterCheckTimer = window.setTimeout(async () => {
    const source = input.value;
    const cursorUtf16 = input.selectionStart;
    const cursor = utf8Offset(source, cursorUtf16);
    const result = await requestLatest('filter-check', 'filter-check', { source, cursor });
    if (
      generation !== filterCheckGeneration
      || source !== input.value
      || cursorUtf16 !== input.selectionStart
      || input.selectionStart !== input.selectionEnd
    ) return;
    if (source.trim() && source !== UI.filterApplied) {
      if (result.available === false) {
        setFilterStatus('Checker unavailable; keep editing or Apply to retry');
      } else if (result.valid) {
        setFilterStatus('Valid');
      } else if (result.diagnostic) {
        showFilterDiagnostic(result.diagnostic);
      }
    }
    if (
      document.activeElement === input
      && result.completions
      && (explicit || !!source.trim())
    ) {
      showFilterCompletions(result.completions);
    } else {
      hideFilterCompletions();
    }
  }, explicit ? 0 : 180);
}

function filterEdited() {
  const input = $('filter-source');
  UI.filterDraft = input.value;
  if (!UI.filterDraft.trim()) {
    setFilterStatus(UI.filterApplied ? 'Edited; applied filter is still active' : 'Empty');
  } else if (UI.filterDraft === UI.filterApplied) {
    setFilterStatus('Applied', 'applied');
  } else {
    setFilterStatus(UI.filterApplied ? 'Edited; applied filter is still active' : 'Checking…');
  }
  scheduleFilterCheck();
}

async function applyFilterSource(source = $('filter-source').value) {
  const panel = $('filter-panel');
  const button = $('filter-apply');
  const generation = ++filterApplyGeneration;
  UI.filterDraft = source;
  $('filter-source').value = source;
  clearTimeout(filterCheckTimer);
  ++filterCheckGeneration;
  cancelLatest('filter-check');
  hideFilterCompletions();
  panel.classList.add('applying');
  button.disabled = true;
  setFilterStatus('Applying…');
  try {
    const result = await request('filter-apply', { source });
    if (generation !== filterApplyGeneration) return false;
    if (!result.success) {
      if (UI.filterDraft !== source) filterEdited();
      else if (result.diagnostic) showFilterDiagnostic(result.diagnostic);
      return false;
    }
    UI.filterApplied = result.source ?? source;
    $('btn-filter').classList.toggle('active', !!UI.filterApplied);
    if (UI.filterDraft === source) {
      UI.filterDraft = UI.filterApplied;
      $('filter-source').value = UI.filterApplied;
      setFilterStatus(UI.filterApplied ? 'Applied' : 'Empty', UI.filterApplied ? 'applied' : '');
    } else {
      setFilterStatus('Edited; applied filter is still active');
    }
    worker.postMessage({ type: 'filter-mode', mode: UI.filterApplied ? UI.filterMode : 0 });
    buildLegend();
    evState.total = -1;
    evState.lastSeq = -1;
    refreshEventsPanel();
    return true;
  } finally {
    if (generation === filterApplyGeneration) {
      panel.classList.remove('applying');
      button.disabled = false;
    }
  }
}

function buildFilterPanel() {
  $('filter-source').value = UI.filterDraft;
  const mode = $1(`input[name=fmode][value="${UI.filterMode}"]`);
  if (mode) mode.checked = true;
  buildSavedFilters();
  filterEdited();
}

function buildSavedFilters() {
  const list = $('saved-filter-list');
  if (!UI.savedFilters.length) {
    list.innerHTML = '<div class="empty">no saved filters</div>';
    return;
  }
  list.innerHTML = UI.savedFilters.map((filter, index) => `<div class="saved-filter-row">
    <input type="text" class="grow" data-saved-filter-name="${index}" value="${esc(filter.name)}">
    <button type="button" data-saved-filter-set="${index}">set</button>
    <button type="button" class="x" data-saved-filter-delete="${index}" title="delete saved filter">×</button>
  </div>`).join('');
}

function saveCurrentFilter() {
  const input = $('saved-filter-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const existing = UI.savedFilters.find((filter) => filter.name === name);
  if (existing) existing.source = UI.filterDraft;
  else UI.savedFilters.push({ name, source: UI.filterDraft });
  input.value = '';
  buildSavedFilters();
  markDirty();
  setFilterStatus(`Saved “${name}”`);
}

$('filter-source').oninput = filterEdited;
$('filter-source').onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    hideFilterCompletions();
    void applyFilterSource();
  } else if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
    e.preventDefault();
    scheduleFilterCheck(true);
  } else if (filterCompletions && e.key === 'ArrowDown') {
    e.preventDefault();
    setActiveFilterCompletion(filterCompletionIndex + 1);
  } else if (filterCompletions && e.key === 'ArrowUp') {
    e.preventDefault();
    setActiveFilterCompletion(filterCompletionIndex - 1);
  } else if (filterCompletions && (e.key === 'Enter' || e.key === 'Tab')) {
    e.preventDefault();
    acceptFilterCompletion();
  } else if (e.key === 'Escape') {
    hideFilterCompletions();
  }
};
$('filter-source').onkeyup = (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) scheduleFilterCheck();
};
$('filter-source').onclick = () => { scheduleFilterCheck(); };
$('filter-source').onblur = () => { hideFilterCompletions(); };
$('filter-completions').onpointerdown = (e) => {
  const option = e.target.closest('[data-completion]');
  if (!option) return;
  e.preventDefault();
  acceptFilterCompletion(+option.dataset.completion);
};
$('filter-completions').onpointermove = (e) => {
  const option = e.target.closest('[data-completion]');
  if (option) setActiveFilterCompletion(+option.dataset.completion);
};
$('filter-apply').onclick = () => { void applyFilterSource(); };
$('saved-filter-save').onclick = saveCurrentFilter;
$('saved-filter-name').onkeydown = (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveCurrentFilter();
  }
};
$('saved-filter-list').onchange = (event) => {
  const input = event.target.closest('[data-saved-filter-name]');
  if (!input) return;
  let index = +input.dataset.savedFilterName;
  const name = input.value.trim();
  if (!name) {
    buildSavedFilters();
    return;
  }
  const duplicate = UI.savedFilters.findIndex((filter, i) => i !== index && filter.name === name);
  if (duplicate >= 0) {
    UI.savedFilters.splice(duplicate, 1);
    if (duplicate < index) index--;
  }
  UI.savedFilters[index].name = name;
  buildSavedFilters();
  markDirty();
};
$('saved-filter-list').onclick = (event) => {
  const set = event.target.closest('[data-saved-filter-set]');
  if (set) {
    const filter = UI.savedFilters[+set.dataset.savedFilterSet];
    if (filter) void applyFilterSource(filter.source);
    return;
  }
  const del = event.target.closest('[data-saved-filter-delete]');
  if (del) {
    UI.savedFilters.splice(+del.dataset.savedFilterDelete, 1);
    buildSavedFilters();
    markDirty();
  }
};
$('filter-clear').onclick = () => {
  $('filter-source').value = '';
  hideFilterCompletions();
  filterEdited();
  $('filter-source').focus();
};
$$('input[name=fmode]').forEach((radio) => {
  radio.onchange = () => {
    if (!radio.checked) return;
    UI.filterMode = +radio.value as 1 | 2;
    if (UI.filterApplied) worker.postMessage({ type: 'filter-mode', mode: UI.filterMode });
  };
});

// ---------------------------------------------------------------------------
// panel wiring. The windowing itself — dragging, the z-stack, docking into
// the left/right drawers — lives in web/shell/ and knows nothing about heaps.
// ---------------------------------------------------------------------------

// which panels exist, and what refills each from a loaded trace. The table
// itself is src/web/heap/panels.ts; the build functions are this file's, so they
// are attached here where they are in scope.
const PANELS = heapPanels({
  'play-panel': () => buildSpeedSelect(),
  // the row size comes from the trace header, with the default left visible
  // as a hint
  'layout-panel': () => setRowBytesInput(UI.meta.rowBytes),
  'appearance-panel': () => buildLegend(),
  'filter-panel': () => buildFilterPanel(),
  'analysis-panel': () => buildMarksPanel(),
  'warnings-panel': () => buildWarningsPanel(),
  'events-panel': () => resetEventsPanel(),
});

// the shell owns the window/drawer machinery (web/shell/); this is the
// domain side of the handoff: the panel table, and the startup wiring.
UI.drawers = drawersState;
$$('.panel').forEach((p) => makePanelWindow(p, dock));
initDrawers();

// panel titles and open/close plumbing, both from the table. The events panel
// wires its own button (opening it also refreshes the virtualized list), which
// is why its record carries no toggle.
for (const { id, title, toggle } of PANELS) {
  $(id).querySelector('.ph-t').textContent = title;
  if (!toggle) continue;
  $(toggle).onclick = () => {
    const p = $(id);
    p.hidden = !p.hidden;
    if (!p.hidden) raisePanel(p);
    if (p.dataset.dockSide) refreshDrawerDividers(p.dataset.dockSide);
  };
}
$$('.panel-close').forEach((b) => {
  b.onclick = () => {
    const p = $(b.dataset.close);
    p.hidden = true;
    if (p.dataset.dockSide) refreshDrawerDividers(p.dataset.dockSide);
  };
});

// ---------------------------------------------------------------------------
// warnings panel
// ---------------------------------------------------------------------------

function buildWarningsPanel() {
  const list = $('warnings-list');
  const total = UI.meta.warnTotal;
  let html = '';
  if (total > UI.warnings.length) {
    html += `<div class="group-title">showing first ${UI.warnings.length} of ${fmtNum(total)}</div>`;
  }
  html += UI.warnings.map((w) =>
    `<div class="warn-row" data-seq="${w.seq}"><span class="warn-seq">#${w.seq}</span><span class="warn-msg">${esc(w.msg)}</span></div>`).join('');
  list.innerHTML = html || '<i>none</i>';
  $$('.warn-row', list).forEach((row) => {
    row.onclick = () => worker.postMessage({ type: 'jump', seq: +row.dataset.seq + 1 });
  });
}

// ---------------------------------------------------------------------------
// events panel (src/web/heap/events-panel.ts): the virtualized sequential list.
// ---------------------------------------------------------------------------

initEventsPanel({
  ui: UI,
  post: (msg) => worker.postMessage(msg),
  fmtAllocSize,
  updateSelOverlay,
  requestSelMirror,
  openSelPopover,
});

// ---------------------------------------------------------------------------
// analysis layer (src/web/heap/analysis.ts): tags, names, colors, time marks,
// address marks, and the `.heapa` file. Wired here with what it still needs
// from this scope.
// ---------------------------------------------------------------------------

initAnalysis({
  ui: UI,
  post: (msg) => worker.postMessage(msg),
  CAT,
  DEFAULT_ROW_BYTES,
  fmtTime,
  buildLegend,
  buildFilterPanel,
  sendNames,
  rowBytesValue,
  setRowBytesInput,
  sendCollapseMin,
});

// ---------------------------------------------------------------------------
// session (src/web/session.ts): filters, layout, view/zoom, crop, window & drawer
// state, playhead — everything *except* marks. It is the one module that
// serializes both shell and heap state, so everything it needs from here is
// handed over explicitly rather than shared through this scope.
// ---------------------------------------------------------------------------

initSession({
  ui: UI,
  post: (msg) => worker.postMessage(msg),
  panels: PANELS,
  allocSizeFormat,
  rowBytesValue,
  sendCollapseMin,
  buildLegend,
  sendAllocSizeFormat,
  resetEventsPanel,
  sendXView,
  applyFilterSource,
  setCrop,
  requestAllocInfo,
  createPinnedWindow,
  buildMarks,
  applyMarks,
});

function clearSelection() {
  UI.sel = null;
  UI.selMirror = null;
  $('sel-popover').hidden = true;
  $$('.tl-select, .tl-select-echo').forEach((el) => { el.hidden = true; });
  $('events-sel-band').hidden = true;
}

// paints a range band (as a fraction of the strip's current view) into `el`
function paintBand(el, strip, kind, lo, hi) {
  const v = kind === 0 ? UI.tlT : UI.tlS;
  const w = strip.clientWidth;
  const x0 = ((lo - v.lo) / (v.hi - v.lo)) * w;
  const x1 = ((hi - v.lo) / (v.hi - v.lo)) * w;
  el.style.left = `${Math.max(0, x0)}px`;
  el.style.width = `${Math.max(0, Math.min(w, x1) - Math.max(0, x0))}px`;
  el.hidden = x1 < 0 || x0 > w;
}

function updateSelOverlay() {
  if (!UI.sel) return;
  const strip = $(UI.sel.kind === 0 ? 'strip-t' : 'strip-s');
  paintBand(strip.querySelector('.tl-select'), strip, UI.sel.kind, UI.sel.lo, UI.sel.hi);
  // the mirrored range on the *other* strip lags one worker round-trip
  // behind (see requestSelMirror) — repaint it against the current view too
  // so panning/zooming that strip keeps the echo band in the right place
  if (UI.selMirror) {
    const other = $(UI.selMirror.kind === 0 ? 'strip-t' : 'strip-s');
    paintBand(other.querySelector('.tl-select-echo'), other, UI.selMirror.kind, UI.selMirror.lo, UI.selMirror.hi);
  }
  updateEventsSelBand();
}

// keep the mirrored selection (other domain) in sync with UI.sel; cheap
// coalesced worker round-trip, see requestConvert
function requestSelMirror() {
  if (!UI.sel) { UI.selMirror = null; return; }
  const sel = UI.sel;
  requestConvert(sel.kind, sel.lo, sel.hi, (lo, hi) => {
    if (UI.sel !== sel) return; // a newer selection superseded this request
    UI.selMirror = { kind: sel.kind === 0 ? 1 : 0, lo, hi };
    updateSelOverlay();
  });
}

// ---------------------------------------------------------------------------
// crop: temporarily show only allocations created (born) inside a seq window,
// dimming/hiding the rest per the Filter panel's dim/hide mode — persistent
// until removed, unlike the transient drag selection above
// ---------------------------------------------------------------------------

function setCrop(seqLo, seqHi) {
  const n = UI.state ? UI.state.n : (UI.meta ? UI.meta.n : Infinity);
  if (!UI.loaded) return;
  UI.crop = { lo: Math.max(0, Math.min(seqLo, seqHi)), hi: Math.min(n, Math.max(seqLo, seqHi)) };
  worker.postMessage({ type: 'set', key: 'crop', value: UI.crop });
  updateCropIndicator();
  drawCropBands();
}

function clearCrop() {
  if (!UI.crop) return;
  UI.crop = null;
  worker.postMessage({ type: 'set', key: 'crop', value: null });
  updateCropIndicator();
  drawCropBands();
}

function updateCropIndicator() {
  const btn = $('crop-indicator');
  btn.hidden = !UI.crop;
  if (UI.crop) $('crop-range').textContent = `seq ${fmtNum(UI.crop.lo)}–${fmtNum(UI.crop.hi)}`;
}
$('crop-indicator').onclick = clearCrop;

function drawCropBands() {
  const stripS = $('strip-s');
  const bandS = stripS.querySelector('.tl-crop');
  if (!UI.crop) {
    bandS.hidden = true;
    $('strip-t').querySelector('.tl-crop').hidden = true;
    return;
  }
  paintBand(bandS, stripS, 1, UI.crop.lo, UI.crop.hi);
  requestConvert(1, UI.crop.lo, UI.crop.hi, (lo, hi) => {
    if (!UI.crop) return; // cleared while the conversion was in flight
    const stripT = $('strip-t');
    paintBand(stripT.querySelector('.tl-crop'), stripT, 0, lo, hi);
  });
}

function openSelPopover(clientX, clientY) {
  const sel = UI.sel;
  if (!sel) return;
  const range = sel.kind === 0
    ? `t ${fmtTime(sel.lo)} – ${fmtTime(sel.hi)}`
    : `seq ${fmtNum(Math.round(sel.lo))} – ${fmtNum(Math.round(sel.hi))}`;
  $('sel-range').textContent = range;
  const pop = $('sel-popover');
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(innerWidth - r.width - 8, Math.max(4, clientX - r.width / 2))}px`;
  pop.style.top = `${clientY + 10}px`;
  $('sel-tag-name').value = '';
}

$('sel-zoom').onclick = () => {
  if (!UI.sel) return;
  UI.setView[UI.sel.kind]({ lo: UI.sel.lo, hi: UI.sel.hi });
  clearSelection();
};
$('sel-crop').onclick = () => {
  if (!UI.sel) return;
  const sel = UI.sel;
  if (sel.kind === 1) {
    setCrop(Math.round(sel.lo), Math.round(sel.hi));
  } else {
    requestConvert(0, sel.lo, sel.hi, (lo, hi) => setCrop(Math.round(lo), Math.round(hi)));
  }
  clearSelection();
};
$('sel-tag').onclick = () => applySelTag(false);
$('sel-tag-freed').onclick = () => applySelTag(true);
$('sel-tag-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') applySelTag(false); });
$('sel-cancel').onclick = clearSelection;

function applySelTag(byFree) {
  if (!UI.sel) return;
  const id = tagIdFor($('sel-tag-name').value);
  if (!id) { $('sel-tag-name').focus(); return; }
  worker.postMessage({ type: 'tag-range', kind: UI.sel.kind, lo: UI.sel.lo, hi: UI.sel.hi, tag: id, byFree });
  // the color mode stays as-is: tags remain visible via their stripe
  buildLegend();
  clearSelection();
  markDirty();
}

document.addEventListener('keydown', (e) => {
  if (isEditableTarget(e.target)) return;
  if (e.key === 'Escape') clearSelection();
});

// ---------------------------------------------------------------------------
// timeline interaction
// ---------------------------------------------------------------------------

function setupTimeline(stripId, canvas, kind) {
  const strip = $(stripId);
  const hoverline = strip.querySelector('.tl-hoverline');
  const view = () => (kind === 0 ? UI.tlT : UI.tlS);
  // `mirror` is internal: false when this call is itself the mirrored
  // update for the *other* strip's zoom, so it doesn't bounce back and forth
  const setView = (raw, mirror = true) => {
    if (!UI.meta) return;
    const v = kind === 0
      ? clampView(raw, UI.meta.tMin, Math.max(UI.meta.tMax, UI.meta.tMin + 1), 1e-9)
      : clampView(raw, 0, Math.max(UI.meta.n, 1), 4);
    if (kind === 0) UI.tlT = v; else UI.tlS = v;
    UI.tlLocalAt = performance.now();
    worker.postMessage({ type: 'tlview', kind, lo: v.lo, hi: v.hi });
    updateSelOverlay();
    if (mirror) {
      requestConvert(kind, v.lo, v.hi, (lo, hi) => {
        UI.setView[kind === 0 ? 1 : 0]({ lo, hi }, false);
      });
    }
  };
  const valAt = (x) => {
    const r = canvas.getBoundingClientRect();
    const v = view();
    return v.lo + ((x - r.left) / r.width) * (v.hi - v.lo);
  };
  UI.setView[kind] = setView;
  let dragging = false;
  let selecting = null; // anchor clientX while shift-dragging a range

  const seekTo = (x) => {
    const val = valAt(x);
    worker.postMessage(kind === 0 ? { type: 'seek', t: val } : { type: 'seek', seq: val });
  };

  const updateSelection = (x) => {
    const a = valAt(Math.min(selecting, x));
    const b = valAt(Math.max(selecting, x));
    UI.sel = { kind, lo: a, hi: b };
    updateSelOverlay();
    requestSelMirror();
  };

  strip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    strip.setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      clearSelection();
      selecting = e.clientX;
      updateSelection(e.clientX);
    } else {
      clearSelection();
      dragging = true;
      seekTo(e.clientX);
    }
  });
  strip.addEventListener('pointerup', (e) => {
    dragging = false;
    if (selecting !== null) {
      const moved = Math.abs(e.clientX - selecting) > 3;
      selecting = null;
      if (moved && UI.sel) openSelPopover(e.clientX, e.clientY);
      else clearSelection();
    }
  });
  strip.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    hoverline.hidden = false;
    hoverline.style.left = `${e.clientX - r.left}px`;
    if (selecting !== null) updateSelection(e.clientX);
    else if (dragging) seekTo(e.clientX);
    queryTlHover(kind, e.clientX - r.left);
  });
  strip.addEventListener('pointerleave', () => {
    hoverline.hidden = true;
    hideTooltip('tl');
  });
  strip.addEventListener('dblclick', () => {
    if (!UI.meta) return;
    setView(kind === 0
      ? { lo: UI.meta.tMin, hi: Math.max(UI.meta.tMax, UI.meta.tMin + 1) }
      : { lo: 0, hi: Math.max(UI.meta.n, 1) });
  });
  strip.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = view();
    const span = v.hi - v.lo;
    if (e.shiftKey) {
      const d = span * (e.deltaY > 0 ? 0.15 : -0.15);
      setView({ lo: v.lo + d, hi: v.hi + d });
    } else {
      const f = Math.exp(e.deltaY * 0.0015);
      const c = valAt(e.clientX);
      setView({ lo: c - (c - v.lo) * f, hi: c + (v.hi - c) * f });
    }
  }, { passive: false });
}

setupTimeline('strip-t', tltCanvas, 0);
setupTimeline('strip-s', tlsCanvas, 1);

function queryTlHover(kind, x) {
  if (!UI.loaded) return;
  requestLatest('tl', 'tlhover', { kind, x }).then(onTlHoverResult);
}
function onTlHoverResult(m) {
  if (m.info) {
    const i = m.info;
    const range = m.kind === 0
      ? `t ${fmtTime(i.from)} – ${fmtTime(i.to)}`
      : `seq ${fmtNum(Math.floor(i.from))} – ${fmtNum(Math.floor(i.to))}`;
    // positioning comes from positionTooltipNearMouse (which tracks the real
    // mouse), so showTooltip takes no coordinates
    showTooltip('tl',
      `<span class="g">▲ ${fmtNum(i.g)} alloc</span>  <span class="r">▼ ${fmtNum(i.r)} free</span>\n<span class="dim">${range} · events ${fmtNum(i.seqFrom)}–${fmtNum(i.seqTo)}</span>`);
    positionTooltipNearMouse();
  }
}

// ---------------------------------------------------------------------------
// domain conversion (time <-> seq), for mirroring selection/zoom between the
// two timeline strips and the Events panel; coalesced like tlHover above so a
// fast drag never queues more than one in-flight request
// ---------------------------------------------------------------------------

function requestConvert(kind, lo, hi, cb) {
  if (!UI.loaded) return;
  requestLatest('convert', 'convert', { kind, lo, hi }).then((m) => cb(m.lo, m.hi));
}

// ---------------------------------------------------------------------------
// address-line interaction
// ---------------------------------------------------------------------------

// Programmatic scrolls (anchoring, jump-to-event) echo back as scroll events;
// forwarding those echoes to the worker would overwrite its authoritative
// scroll with stale/rounded values mid-drag. Track recent programmatic
// targets and swallow matching events — only real user scrolls get forwarded.
const progScrolls = [];
function noteProgScroll(y) {
  progScrolls.push({ y, t: performance.now() });
  if (progScrolls.length > 8) progScrolls.shift();
}
function isProgScrollEcho(y) {
  const now = performance.now();
  for (let i = progScrolls.length - 1; i >= 0; i--) {
    if (now - progScrolls[i].t > 250) {
      progScrolls.splice(i, 1);
    } else if (Math.abs(progScrolls[i].y - y) < 2) {
      progScrolls.splice(i, 1);
      return true;
    }
  }
  return false;
}

addrScroll.addEventListener('scroll', () => {
  const y = addrScroll.scrollTop;
  if (isProgScrollEcho(y)) return;
  worker.postMessage({ type: 'scroll', y });
});

// --- horizontal zoom on the byte axis (see also hz-reset in the toolbar) ---

function sendXView() {
  worker.postMessage({ type: 'set', key: 'xview', value: { ...UI.xview } });
  updateHzButton();
}

function updateHzButton() {
  const z = UI.xview.zoom;
  const b = $('hz-reset');
  b.hidden = z <= 1.001;
  b.textContent = `↔ ×${z >= 10 ? Math.round(z) : z.toFixed(1)}`;
}

$('hz-reset').onclick = () => {
  UI.xview = { zoom: 1, pan: 0 };
  sendXView();
};

function hzZoomAt(clientX, factor) {
  const r = addrCanvas.getBoundingClientRect();
  const fx = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const v = UI.xview;
  const cursorFrac = v.pan + fx / v.zoom; // row fraction under the cursor
  const zoom = Math.min(65536, Math.max(1, v.zoom * factor));
  const pan = Math.min(Math.max(cursorFrac - fx / zoom, 0), 1 - 1 / zoom);
  UI.xview = { zoom, pan };
  sendXView();
}

function hzPan(deltaPx) {
  const v = UI.xview;
  if (v.zoom <= 1) return;
  const pan = v.pan + (deltaPx / addrScroll.clientWidth) / v.zoom;
  UI.xview.pan = Math.min(Math.max(pan, 0), 1 - 1 / v.zoom);
  sendXView();
}

addrScroll.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.altKey) {
    // zoom the byte axis around the cursor, timeline-style (row size unchanged)
    e.preventDefault();
    hzZoomAt(e.clientX, Math.exp(-e.deltaY * 0.0015));
  } else if (e.shiftKey) {
    // shift+wheel: pan the zoomed byte axis, timeline-style
    e.preventDefault();
    hzPan((e.deltaY || e.deltaX) * 0.6);
  } else if (e.deltaX !== 0 && UI.xview.zoom > 1) {
    // horizontal wheel / trackpad: pan too
    e.preventDefault();
    hzPan(e.deltaX);
  }
}, { passive: false });

addrScroll.addEventListener('pointermove', (e) => {
  if (!UI.loaded) return;
  const r = addrCanvas.getBoundingClientRect();
  requestLatest('pick', 'pick', {
    x: e.clientX - r.left, y: e.clientY - r.top, forClick: false,
  }).then(onPickResult);
});
addrScroll.addEventListener('pointerleave', () => {
  cancelLatest('pick');
  hoverRects = [];
  hideTooltip('addr');
  drawMoveLink(UI.state && UI.state.moveLink);
});
addrScroll.addEventListener('click', (e) => {
  const r = addrCanvas.getBoundingClientRect();
  if (e.shiftKey) {
    // shift+click marks the address under the cursor
    worker.postMessage({
      type: 'addr-at', x: e.clientX - r.left, y: e.clientY - r.top, reqId: UI.reqId++,
    });
    return;
  }
  if (!UI.loaded) return;
  requestLatest('pick', 'pick', {
    x: e.clientX - r.left, y: e.clientY - r.top, forClick: true,
  }).then(onPickResult);
});

function onPickResult(m) {
  const info = m.info;
  if (m.forClick) {
    UI.selected = info ? info.e : null;
    worker.postMessage({ type: 'set', key: 'selected', value: UI.selected });
    fillDetailPanel(info);
  } else if (info) {
    hoverRects = info.rects || [];
    drawMoveLink(UI.state && UI.state.moveLink);
    const name = UI.names.get(info.e)?.name;
    const tag = info.tag > 0 ? UI.tags[info.tag - 1] : null;
    const lines = [
      `<b>${name ? `“${esc(name)}”  ` : ''}id ${info.id}</b>${info.site ? `  <span style="color:${CAT[(info.siteIdx ?? 0) % 12]}">${esc(info.site)}</span>` : ''}${tag ? `  <span style="color:${tag.color}">⬤ ${esc(tag.name)}</span>` : ''}`,
      `${info.addr} – ${info.end}  <span class="g">${fmtAllocSize(info.size)}</span>${info.usable ? ` <span class="dim">(usable ${fmtAllocSize(info.usable)})</span>` : ''}`,
      `<span class="dim">born</span> seq ${fmtNum(info.seq)} · t ${fmtTime(info.t)}   <span class="dim">age</span> ${fmtTime(info.age)}`,
      `${info.thr !== null ? `<span class="dim">thr</span> ${info.thr}   ` : ''}` +
      (info.deathSeq !== null ? `<span class="dim">dies</span> seq ${fmtNum(info.deathSeq)} (t ${fmtTime(info.deathT)})` : '<span class="dim">never freed</span>'),
    ];
    showTooltip('addr', lines.join('\n'));
    positionTooltipNearMouse();
  } else {
    hoverRects = [];
    drawMoveLink(UI.state && UI.state.moveLink);
    hideTooltip('addr');
  }
}

// Render allocation info into `root` and wire its controls. Scoped by class
// (no ids) so the same body can live in the detail panel and in any number
// of pinned windows at once.
function buildDetailBody(root, info) {
  const rows = [
    ['id', info.id],
    ['range', `${info.addr} – ${info.end}`],
    ['size', fmtAllocSizeDetail(info.size)],
    info.usable ? ['usable', fmtAllocSizeDetail(info.usable)] : null,
    ['site', info.site ?? '—'],
    ['thread', info.thr ?? '—'],
    ['born', `seq ${fmtNum(info.seq)} · t ${fmtTime(info.t)}`],
    ['dies', info.deathSeq !== null ? `seq ${fmtNum(info.deathSeq)} · t ${fmtTime(info.deathT)}` : 'never (leak?)'],
  ].filter(Boolean);
  let html = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${esc(String(v))}</span></div>`).join('');
  if (info.stack) {
    html += `<div class="row"><span class="k">stack</span><span>${esc(info.stack)}</span></div>`;
  }
  if (info.extra) {
    for (const [k, v] of Object.entries(info.extra)) {
      html += `<div class="row"><span class="k">${esc(k)}</span><span>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</span></div>`;
    }
  }
  const curTag = info.tag > 0 ? UI.tags[info.tag - 1]?.name || '' : '';
  html += `<div class="row"><span class="k">name</span>
    <input class="d-name" placeholder="name this allocation" value="${esc(UI.names.get(info.e)?.name || '')}" size="18"></div>`;
  html += `<div class="row"><span class="k">tag</span>
    <input class="d-tag" placeholder="tag (empty = none)" value="${esc(curTag)}" size="12" list="tag-names">
    <button class="d-tag-apply">set</button></div>`;
  html += `<div class="row"><span class="k">color</span>
    <input type="color" class="d-color" value="#3fb950" title="highlight this allocation in every color mode">
    <button class="d-color-clear">clear</button></div>`;
  html += `<div class="actions">
    <button class="d-focus" title="Scroll/pan to this allocation and flash exactly where it is">⌖ focus</button>
    <button class="d-birth">go to birth</button>
    ${info.deathSeq !== null ? '<button class="d-death">go to death</button>' : ''}
    <button class="d-range" title="Replace the Filter expression with this allocation's address range and apply it">match range</button>
  </div>`;
  root.innerHTML = html;
  const q = (sel) => root.querySelector(sel);
  // same pulse as re-clicking the current event in the Events panel
  q('.d-focus').onclick = () => worker.postMessage({ type: 'flash-event', seq: info.e });
  q('.d-birth').onclick = () => worker.postMessage({ type: 'jump', seq: info.seq + 1 });
  const dd = q('.d-death');
  if (dd) dd.onclick = () => worker.postMessage({ type: 'jump', seq: info.deathSeq + 1 });
  q('.d-range').onclick = async () => {
    showPanel('filter-panel');
    const applied = await applyFilterSource(`span overlaps ${info.addr}..${info.end}`);
    if (applied) {
      $('st-info').textContent = `filtering range ${info.addr} – ${info.end}`;
    }
  };
  q('.d-name').onchange = () => {
    const v = q('.d-name').value.trim();
    if (v) UI.names.set(info.e, { name: v, id: info.id, addr: info.addr });
    else UI.names.delete(info.e);
    buildNamesSection();
    sendNames();
    // keep the enclosing window's title in sync with the name
    const t = root.closest('.panel')?.querySelector('.ph-t');
    if (t) t.textContent = detailTitle(info);
    markDirty();
  };
  q('.d-tag-apply').onclick = () => {
    const id = tagIdFor(q('.d-tag').value);
    worker.postMessage({ type: 'tag-event', e: info.e, tag: id });
    info.tag = id;
    buildLegend();
    markDirty();
  };
  const curColor = UI.allocColors.get(info.e);
  if (curColor) q('.d-color').value = curColor;
  q('.d-color').oninput = () => {
    const v = q('.d-color').value;
    UI.allocColors.set(info.e, v);
    worker.postMessage({ type: 'alloc-color', e: info.e, rgb: parseInt(v.slice(1), 16) });
    // oninput fires on every tick of a live picker drag: update only this
    // allocation's swatch in the names list — a full rebuild here would
    // replace elements while the user is mid-gesture on them
    const sw = $('an-names').querySelector(`input[data-ncolor="${info.e}"]`);
    if (sw) sw.value = v;
    markDirty();
  };
  // the full names-list rebuild waits for the committed value
  q('.d-color').onchange = () => buildNamesSection();
  q('.d-color-clear').onclick = () => {
    UI.allocColors.delete(info.e);
    worker.postMessage({ type: 'alloc-color', e: info.e, rgb: null });
    buildNamesSection();
    markDirty();
  };
}

function detailTitle(info) {
  const name = UI.names.get(info.e)?.name;
  return name ? `Allocation · ${name}` : 'Allocation';
}

function panelHasManualPosition(panel) {
  return !!(panel.style.left || panel.style.top || panel.style.right || panel.style.bottom);
}

// When the live panel (re)opens, keep it in the usable workspace beside any
// open drawer. After pinning, start from the default bottom-left spot and
// cascade up-right past any pinned windows sitting there.
function placeLivePanel(panel, reset = false) {
  if (reset) {
  panel.style.left = '';
  panel.style.top = '';
  panel.style.right = '';
  panel.style.bottom = '';
  }
  const r = panel.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  const gap = 10;
  const leftDr = drawerEl('left');
  const rightDr = drawerEl('right');
  let minX = gap;
  let maxX = Math.max(gap, innerWidth - r.width - gap);
  if (!leftDr.hidden) minX = Math.max(minX, leftDr.getBoundingClientRect().right + gap);
  if (!rightDr.hidden) maxX = Math.min(maxX, rightDr.getBoundingClientRect().left - r.width - gap);
  if (maxX < minX) {
    // Very narrow layouts may not have enough room between two drawers; keep
    // the panel visible and prefer the space nearest the left drawer.
    const visibleMax = Math.max(gap, innerWidth - r.width - gap);
    minX = Math.min(minX, visibleMax);
    maxX = visibleMax;
  }
  const clampX = (v) => Math.min(maxX, Math.max(minX, v));
  const nx = clampX(x);
  let moved = Math.abs(nx - x) > 0.5;
  x = nx;
  const pins = $$('.pinned-detail').map((w) => w.getBoundingClientRect());
  const clash = () => pins.some((p) => Math.abs(p.left - x) < 48 && Math.abs(p.top - y) < 48);
  while (clash() && y > 40) {
    x = clampX(x + 28);
    y -= 28;
    moved = true;
  }
  if (moved) {
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
}

function fillDetailPanel(info) {
  const panel = $('detail-panel');
  if (!info) { panel.hidden = true; return; }
  // never two windows for the same allocation: if it is already pinned,
  // bring that window to the front instead of opening a duplicate
  const dup = document.querySelector(`.pinned-detail[data-e="${info.e}"]`);
  if (dup) {
    panel.hidden = true;
    raisePanel(dup);
    return;
  }
  UI.detailInfo = info;
  panel.querySelector('.ph-t').textContent = detailTitle(info);
  buildDetailBody($('detail-body'), info);
  const wasHidden = panel.hidden;
  panel.hidden = false;
  // only reset/cascade position when the live panel was just vacated by a
  // pin (so a fresh window doesn't land on the pinned one); a plain close
  // (× or Escape) leaves the window where the user left it unless that spot is
  // now covered by an open drawer
  if (wasHidden) placeLivePanel(panel, UI.detailWasPinned || !panelHasManualPosition(panel));
  UI.detailWasPinned = false;
  raisePanel(panel);
}

// Build a standalone pinned-allocation window for `info`, optionally placed
// at a floating `rect` ({left,top,right,bottom} css strings). Shared by the
// interactive pin button and by session restore (see applySession).
function createPinnedWindow(info, rect) {
  const live = $('detail-panel');
  const win = document.createElement('div');
  win.className = 'panel pinned-detail';
  win.dataset.e = info.e;
  win._allocInfo = info;
  win.innerHTML = `<div class="panel-head"><span class="ph-t">${esc(detailTitle(info))}</span>
      <span class="head-actions">
        <button class="d-pin pinned" title="Unpin — return this to the live Allocation panel">📌</button>
        <button class="panel-close">×</button>
      </span></div>
    <div class="panel-body detail-body"></div>`;
  document.body.appendChild(win);
  buildDetailBody(win.querySelector('.panel-body'), info);
  if (rect) {
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  }
  $1('.panel-close', win).onclick = () => {
    const side = win.dataset.dockSide;
    win.remove();
    if (side) refreshDrawerDividers(side);
  };
  $1('.d-pin', win).onclick = () => {
    const side = win.dataset.dockSide;
    const rr = win.getBoundingClientRect();
    win.remove();
    if (side) refreshDrawerDividers(side);
    fillDetailPanel(info);
    live.style.left = `${rr.left}px`;
    live.style.top = `${rr.top}px`;
    live.style.right = 'auto';
    live.style.bottom = 'auto';
    placeLivePanel(live);
  };
  makePanelWindow(win, dock);
  raisePanel(win);
  return win;
}

// Pin the current allocation window: it stays exactly where it is (as a
// pinned window, orange pin), and the next selection opens a fresh live
// Allocation panel. Clicking a pinned window's pin returns it to the live
// panel; × closes it. Any number of windows can be pinned.
$('d-pin').onclick = () => {
  const info = UI.detailInfo;
  if (!info) return;
  const live = $('detail-panel');
  // identical chrome to the live panel — the orange pin is the only tell
  createPinnedWindow(info, live.getBoundingClientRect());
  UI.detailWasPinned = true;
  live.hidden = true;
};
