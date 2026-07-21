// heap-visualizer main thread: DOM chrome and input. All heavy lifting (parse, seek,
// raster) happens in the worker; this file forwards input and paints overlays.
// Projects (directories, runs, .heapa auto-persist) live in project.js.

import * as project from './project.js';

const $ = (id) => document.getElementById(id);

const CAT = ['#58a6ff', '#3fb950', '#f2cc60', '#ff7b72', '#bc8cff', '#39c5cf',
  '#f778ba', '#d29922', '#7ee787', '#ffa657', '#79c0ff', '#d2a8ff'];
const RAMP = ['#0e4429', '#006d32', '#26a641', '#39d353'];
const OPS = ['malloc', 'free', 'realloc', 'begin', 'end', 'log'];
const OP_LETTER = ['M', 'F', 'R', 'B', 'E', 'L'];
const OP_CLASS = ['m', 'f', 'r', 'b', 'e', 'l'];

const dpr = window.devicePixelRatio || 1;

// cache-bust the worker and (below) the wasm: browsers heuristically cache
// subresources, so a rebuilt core would otherwise need a devtools
// disable-cache reload to show up
const BUILD_V = Date.now();
const worker = new Worker(`worker.js?v=${BUILD_V}`, { type: 'module' });

const UI = {
  meta: null,
  warnings: [],
  state: null,      // last state message from the worker
  playing: false,
  tlT: { lo: 0, hi: 1 },
  tlS: { lo: 0, hi: 1 },
  selected: null,
  reqId: 1,
  loaded: false,
  tags: [],         // tag id = index + 1; {name, color: '#rrggbb', visible}
  tagCounts: {},    // tag id -> tagged creator-event count (0 = untagged)
  untaggedVisible: true,
  names: new Map(),       // creator event -> {name, id, addr}
  allocColors: new Map(), // creator event -> '#rrggbb' override
  bookmarks: [],          // {name, seq, t} time marks
  addrMarks: [],          // {name, addr: '0x…'} address marks
  sel: null,        // active range selection {kind, lo, hi}
  selMirror: null,  // UI.sel converted to the other domain: {kind, lo, hi}
  marksDirty: false, // tags/bookmarks/addr marks/names/colors changed since last save/load
  crop: null,       // {lo, hi} in seq domain, or null; see setCrop/clearCrop
  setView: {},      // per-strip view setters, filled by setupTimeline
  locked: false,    // locked viewport: stepping never auto-scrolls
  xview: { zoom: 1, pan: 0 }, // horizontal zoom/pan on the address line
};

// expose for tests / console poking
window.__heap_visualizer = UI;
UI.worker = worker;
UI.seek = (seq) => worker.postMessage({ type: 'seek', seq });

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function fmtBytes(b) {
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

function fmtHexSize(b) {
  return `0x${Math.max(0, Math.round(Number(b) || 0)).toString(16)}`;
}

function allocSizeFormat() {
  return $('alloc-size-format')?.value === 'hex' ? 'hex' : 'human';
}

function fmtAllocSize(b) {
  return allocSizeFormat() === 'hex' ? fmtHexSize(b) : fmtBytes(b);
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

function fmtNum(x) {
  return Number(x).toLocaleString('en-US');
}

// one-line description of an event, for the step readout
function stepReadout(e) {
  switch (e.op) {
    case 3: return `begin “${e.name}”${e.thr !== undefined ? ` · thr ${e.thr}` : ' · global'}`;
    case 4: return `end “${e.name}”${e.thr !== undefined ? ` · thr ${e.thr}` : ' · global'}`;
    case 5: return `log [${e.lvl}] ${e.msg}`;
    default:
      return `${OPS[e.op]} ${e.addr} ${fmtAllocSize(e.size)}` +
        `${e.invalid ? ' · ⚠ invalid free' : ''}${e.site ? ' · ' + e.site : ''}`;
  }
}

function parseSize(s) {
  s = (s || '').trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^(0x[\da-f]+|[\d.]+)\s*([kmgt]?)i?b?$/);
  if (!m) return 0;
  const mult = { '': 1, k: 1024, m: 1 << 20, g: 1 << 30, t: 2 ** 40 }[m[2]];
  const value = m[1].startsWith('0x') ? parseInt(m[1], 16) : parseFloat(m[1]);
  return Math.round(value * mult);
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
    { type: 'init', wasmURL: new URL(`heap_visualizer_core.wasm?v=${BUILD_V}`, location.href).href, addr: a, tlt: t, tls: s, dpr },
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

// Load one or more trace buffers as a single (merged) stream. Multiple
// buffers = one run: the core merges them by t.
async function loadBuffers(buffers, name) {
  $('progress').hidden = false;
  $('progress-pct').textContent = '0%';
  UI.fileName = name;
  project.showLanding(false);
  worker.postMessage({ type: 'load', buffers }, buffers);
}

async function loadBuffer(buf, name) {
  loadBuffers([buf], name);
}

async function loadURL(url) {
  try {
    // always revalidate: a stale cached trace (e.g. an old demo.heapl)
    // would resurface warnings that were fixed in the file
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    project.noteQuickLook({ url });
    loadBuffer(await resp.arrayBuffer(), url.split('/').pop());
  } catch (e) {
    $('st-trace').textContent = `failed to load ${url}: ${e.message}`;
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
      $('st-trace').textContent = `analysis load failed: ${e.message}`;
    }
  } else {
    project.noteQuickLook({ files: [f] });
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

const pending = { pick: null, tl: null };

worker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'ready':
      sendResizes();
      worker.postMessage({ type: 'set', key: 'rowPx', value: +$('row-px').value });
      const url = new URLSearchParams(location.search).get('trace');
      if (url) loadURL(url);
      break;
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
        const wantSpacer = Math.max(0, m.virtualH / dpr - addrScroll.clientHeight);
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
        $('st-info').textContent = stepReadout(e);
        // open the matching detail window: allocations for M/F/R, the
        // span/log panel for B/E/L (selection covers every event kind)
        if (m.info) fillDetailPanel(m.info);
        else if ((e.op === 3 || e.op === 4) && UI.spans && UI.spans[e.span]) selectSpan(UI.spans[e.span]);
        else if (e.op === 5) selectLog({ lvl: e.lvl, msg: e.msg, src: e.src, thr: e.thr, seq: e.seq, t: e.t });
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
    case 'flash-rects':
      flashRects(m.rects);
      break;
    case 'pick-result':
      onPickResult(m);
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
    case 'tags-dump': {
      const w = dumpWaiters.get(m.reqId);
      if (w) { dumpWaiters.delete(m.reqId); w(m.tags); }
      break;
    }
    case 'tlhover-result':
      onTlHoverResult(m);
      break;
    case 'spans':
      UI.spans = m.spans;
      buildLanes();
      break;
    case 'logs':
      UI.logs = m.logs;
      buildLanes();
      buildLogsPanel();
      break;
    case 'convert-result':
      onConvertResult(m);
      break;
    case 'alloc-info-result': {
      const w = allocInfoWaiters.get(m.reqId);
      if (w) { allocInfoWaiters.delete(m.reqId); w(m.info); }
      break;
    }
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
  UI.untaggedVisible = true;
  UI.names.clear();
  UI.allocColors.clear();
  UI.bookmarks = [];
  UI.addrMarks = [];
  UI.marksDirty = false;
  UI.crop = null;
  updateCropIndicator();
  sendAddrMarks();
  sendNames();
  // the wasm view is recreated per trace: re-apply sticky toolbar prefs
  worker.postMessage({ type: 'set', key: 'showAll', value: $('show-all').checked });
  worker.postMessage({ type: 'set', key: 'sizeLabels', value: $('show-sizes').checked });
  worker.postMessage({ type: 'set', key: 'allocSizeFormat', value: allocSizeFormat() });
  clearSelection();
  syncTagDatalist();
  buildMarksPanel();
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
  resetEventsPanel();
  // span/log lanes: fetch once per trace; the strip appears only when the
  // run actually has spans or logs
  UI.spans = null;
  UI.logs = null;
  UI.laneVis = null;
  UI.selSpan = null;
  $('span-panel').hidden = true;
  $('btn-logs').hidden = !m.meta.nLog;
  $('btn-active').hidden = !m.meta.nSpan;
  lgState.rows = null;
  $('logs-term').innerHTML = '';
  activeState.lastSeq = -1;
  $('active-list').innerHTML = '';
  if (m.meta.nSpan) worker.postMessage({ type: 'spans' });
  if (m.meta.nLog) worker.postMessage({ type: 'logs' });
  if (!m.meta.nSpan && !m.meta.nLog) buildLanes();
  $('trace-title').textContent = m.meta.title || UI.fileName || '';
  const extraCounts =
    (m.meta.nSpan ? ` / S ${fmtNum(m.meta.nSpan)}` : '') +
    (m.meta.nLog ? ` / L ${fmtNum(m.meta.nLog)}` : '');
  $('st-trace').textContent =
    `${UI.fileName || ''} · ${fmtNum(m.n)} events (M ${fmtNum(m.meta.nMalloc)} / F ${fmtNum(m.meta.nFree)} / R ${fmtNum(m.meta.nRealloc)}${extraCounts})` +
    ` · peak ${fmtBytes(m.meta.peakLive)} · ${m.meta.addrMin}–${m.meta.addrMax}`;

  // warnings badge
  const wc = m.meta.warnTotal;
  $('btn-warnings').hidden = wc === 0;
  $('warn-count').textContent = fmtNum(wc);
  buildWarningsPanel();

  // row size from the trace header; leave the default visible as a hint
  setRowBytesInput(m.meta.rowBytes);
  buildFilterPanel();
  buildSpeedSelect();
  buildLegend();
  $('detail-panel').hidden = true;
  UI.detailInfo = null;
  // pinned allocation windows reference events of the previous trace
  document.querySelectorAll('.pinned-detail, .pinned-span').forEach((w) => w.remove());
  refreshDrawerDividers('left');
  refreshDrawerDividers('right');
  if (project.isRunOpen()) {
    // a project run owns its analysis: the paired .heapa is the source of
    // truth (it also carries the session/window layout)
    project.afterTraceLoaded();
  } else {
    restoreSession();
    restoreMarksAutosave();
  }
  project.onTraceLoaded();
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
  const wantSpacer = Math.max(0, m.virtualH / dpr - viewH);
  const spacer = $('addr-spacer');
  if (Math.abs(spacer.offsetHeight - wantSpacer) > 1) {
    spacer.style.height = `${wantSpacer}px`;
  }
  $('empty-hint').style.display = m.liveCount === 0 ? 'block' : 'none';
  drawMoveLink(m.moveLink);
  updateSelOverlay();
  drawCropBands();
  updateMarkers();
  lastAddrMarkYs = m.addrMarkYs || [];
  renderAddrMarkLines();
  updateEventsPanel();
  renderLanes();
  updateLogsPanel();
  updateActivePanel();
}

// ---------------------------------------------------------------------------
// move-link / selection overlay (SVG, CSS px)
// ---------------------------------------------------------------------------

let hoverRects = [];

function drawMoveLink(ml) {
  const svg = overlay;
  let content = '';
  for (const r of hoverRects) {
    content += `<rect class="hover-rect" x="${r.x / dpr}" y="${r.y / dpr}" width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
  }
  if (ml && ml.op === 2) {
    for (const r of ml.old) {
      content += `<rect class="ml-old" x="${r.x / dpr}" y="${r.y / dpr}" width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
    }
    for (const r of ml.new) {
      content += `<rect class="ml-new" x="${r.x / dpr}" y="${r.y / dpr}" width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
    }
    if (ml.old.length && ml.new.length) {
      const o = ml.old[0], n = ml.new[0];
      content += `<line class="ml-line" x1="${(o.x + o.w / 2) / dpr}" y1="${(o.y + o.h / 2) / dpr}" x2="${(n.x + n.w / 2) / dpr}" y2="${(n.y + n.h / 2) / dpr}"/>`;
    }
  } else if (ml && ml.op === 1) {
    for (const r of ml.old) {
      content += `<rect class="ml-old" x="${r.x / dpr}" y="${r.y / dpr}" width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
    }
  } else if (ml && ml.op === 0) {
    // fresh malloc: outline the new allocation so small ones are findable
    for (const r of ml.new) {
      content += `<rect class="ml-new" x="${r.x / dpr}" y="${r.y / dpr}" width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
    }
  }
  svg.innerHTML = content;
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
    worker.postMessage({ type: 'jump', seq: parseInt(v, 10) });
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
      kind: 'alloc', label: v.name, sub: `#${e} · ${v.addr}`,
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
  list.querySelectorAll('.sr-row').forEach((row) => {
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

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
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
function parseCollapseMin(v) {
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
$('alloc-size-format').onchange = () => sendAllocSizeFormat();
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
  document.querySelectorAll('.pinned-detail').forEach((win) => {
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
      html += `<span class="chip"><span class="swatch" style="background:${CAT[i % 12]}"></span>${esc(s.name)}</span>`;
    });
  } else if (mode === 2) {
    UI.meta.thrs.forEach((t, i) => {
      html += `<span class="chip"><span class="swatch" style="background:${CAT[(i + 5) % 12]}"></span>thr ${t.thr}</span>`;
    });
  } else if (mode === 3) {
    html = `<span class="chip">16 B <span class="ramp" style="background:linear-gradient(90deg,${RAMP.join(',')})"></span> 16 MiB (log size)</span>`;
  } else if (mode === 4) {
    html = `<span class="chip">young <span class="ramp" style="background:linear-gradient(90deg,#7ee787,#39c5cf,#1f4fa8)"></span> old (log age vs oldest live)</span>`;
  } else if (mode === 5) {
    html = UI.tags.map((t, i) =>
      `<span class="chip"><span class="swatch" style="background:${t.color}"></span>${esc(t.name)} · ${fmtNum(UI.tagCounts[i + 1] || 0)}</span>`).join('') +
      `<span class="chip"><span class="swatch" style="background:#39414a"></span>untagged · ${fmtNum(UI.tagCounts[0] || 0)}</span>`;
    if (!UI.tags.length) html = '<span class="chip">no tags yet — shift-drag a timeline range or use the allocation panel</span>';
  }
  el.innerHTML = html;
  el.hidden = html === '';
  sendResizes();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// filter panel
// ---------------------------------------------------------------------------

function allNoneHtml(sel) {
  return `<span class="allnone"><a data-an="all" data-sel="${sel}">all</a> · <a data-an="none" data-sel="${sel}">none</a></span>`;
}

function buildFilterPanel() {
  const sites = $('f-sites');
  sites.innerHTML = UI.meta.sites.length
    ? `<div class="group-title">sites ${allNoneHtml('site')}</div>` + UI.meta.sites.map((s, i) =>
      `<label><input type="checkbox" data-site="${i}" checked><span class="swatch" style="background:${CAT[i % 12]}"></span>${esc(s.name)}<span class="count">${fmtNum(s.count)}</span></label>`).join('')
    : '';
  const thrs = $('f-thrs');
  thrs.innerHTML = UI.meta.thrs.length > 1
    ? `<div class="group-title">threads ${allNoneHtml('thr')}</div>` + UI.meta.thrs.map((t, i) =>
      `<label><input type="checkbox" data-thr="${i}" checked><span class="swatch" style="background:${CAT[(i + 5) % 12]}"></span>thr ${t.thr}<span class="count">${fmtNum(t.count)}</span></label>`).join('')
    : '';
  // scoped to sites/threads only — tags live in the same panel but keep
  // their own dedicated wiring (buildTagsSection) driven by UI.tags state,
  // not raw checkbox DOM state
  for (const group of [sites, thrs]) {
    group.querySelectorAll('input').forEach((inp) => { inp.onchange = sendFilter; });
    group.querySelectorAll('.allnone a').forEach((a) => {
      a.onclick = () => {
        const on = a.dataset.an === 'all';
        group.querySelectorAll(`input[data-${a.dataset.sel}]`)
          .forEach((b) => { b.checked = on; });
        sendFilter();
      };
    });
  }
  $('f-size-min').oninput = sendFilter;
  $('f-size-max').oninput = sendFilter;
  buildTagsSection();
}

function sendFilter() {
  const panel = $('filter-panel');
  const siteBoxes = [...panel.querySelectorAll('input[data-site]')];
  const thrBoxes = [...panel.querySelectorAll('input[data-thr]')];
  const sites = siteBoxes.filter((b) => b.checked).map((b) => +b.dataset.site);
  const thrs = thrBoxes.filter((b) => b.checked).map((b) => +b.dataset.thr);
  const sizeMin = parseSize($('f-size-min').value);
  const sizeMax = parseSize($('f-size-max').value);
  const allSites = sites.length === siteBoxes.length;
  const allThrs = thrs.length === thrBoxes.length;
  // tag visibility (from the tags panel; bit 0 = untagged)
  const tagBits = [];
  if (UI.untaggedVisible) tagBits.push(0);
  UI.tags.forEach((t, i) => { if (t.visible) tagBits.push(i + 1); });
  const allTags = tagBits.length === UI.tags.length + 1;
  const active = !allSites || !allThrs || !allTags || sizeMin > 0 || sizeMax > 0;
  const mode = active ? +panel.querySelector('input[name=fmode]:checked').value : 0;
  worker.postMessage({
    type: 'set', key: 'filter',
    value: {
      mode,
      sites: allSites ? null : sites,
      thrs: allThrs ? null : thrs,
      tags: allTags ? null : tagBits,
      sizeMin, sizeMax,
    },
  });
  $('btn-filter').classList.toggle('active', active);
}

$('filter-clear').onclick = () => {
  $('filter-panel').querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = true; });
  $('f-size-min').value = '';
  $('f-size-max').value = '';
  UI.untaggedVisible = true;
  UI.tags.forEach((t) => { t.visible = true; });
  buildTagsSection();
  sendFilter();
};

// ---------------------------------------------------------------------------
// panels as draggable windows: drag by the header, and keep a z-stack where
// the last panel opened or dragged sits on top
// ---------------------------------------------------------------------------

// dockable/floating panels tracked by session (drawers, window positions) —
// detail-panel and its pinned clones are excluded: they're per-allocation
// and not meaningful to restore across a session
const PANEL_IDS = ['play-panel', 'layout-panel', 'filter-panel', 'analysis-panel', 'warnings-panel', 'events-panel',
  'lanes-panel', 'span-panel', 'project-panel', 'logs-panel', 'active-panel'];

let panelZ = 40;

function raisePanel(p) {
  p.style.zIndex = ++panelZ;
}

// docked windows are the default home (editor-style): a window the user has
// never explicitly placed opens docked at its natural side; dragging it out
// (or a restored floating position) opts it out via dataset.placed
const DEFAULT_DOCK = {
  'events-panel': 'bottom',
  'logs-panel': 'bottom',
  'warnings-panel': 'bottom',
  'analysis-panel': 'right',
  'span-panel': 'right',
  'active-panel': 'right',
  'detail-panel': 'right',
  'project-panel': 'left',
  'play-panel': 'left',
  'layout-panel': 'left',
  'filter-panel': 'left',
  'lanes-panel': 'left',
};

function showPanel(id) {
  const p = $(id);
  if (!p.dataset.dockSide && !p.dataset.placed) {
    dockPanel(p, DEFAULT_DOCK[id] || 'right');
  }
  p.hidden = false;
  if (p.dataset.dockSide) {
    uncollapseDock(p.dataset.dockSide);
    refreshDrawerDividers(p.dataset.dockSide);
  }
  raisePanel(p);
}

function makePanelWindow(p) {
  // any interaction with a window brings it to the front
  p.addEventListener('pointerdown', () => raisePanel(p));
  const head = p.querySelector('.panel-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // header buttons/inputs (close, save, follow…) still work normally
    if (e.target.closest('button, input, select, a')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const r = p.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let moved = false;
    let dropSide = null;
    let dropRef = null;
    let zoneSide = null; // last side reported by dropSideAt, for edge-transition detection

    const floatTo = (ev) => {
      p.style.left = `${Math.min(innerWidth - 60, Math.max(4 - r.width + 60, ev.clientX - dx))}px`;
      p.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    };
    const move = (ev) => {
      if ((ev.buttons & 1) === 0) {
        finish();
        return;
      }
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        // pick up immediately: a docked panel pops out of its drawer the
        // instant a drag starts (rather than only on drop), so it's always
        // obviously "in your hand" and never looks stuck mid-drag — it only
        // re-docks if actually dropped on a drawer, below
        if (p.classList.contains('docked')) undockPanel(p);
        p.classList.add('dragging');
      }
      // keep the window tracking the cursor continuously, even while
      // hovering a drop zone — it used to freeze there, which read as stuck
      floatTo(ev);
      const side = dropSideAt(ev.clientX, ev.clientY);
      // refreshDrawerDividers rebuilds divider elements (and their pointer
      // listeners) from scratch — only run it on an actual zone change, not
      // every pointermove tick, or it visibly stutters the drag
      if (side !== zoneSide) {
        if (zoneSide) refreshDrawerDividers(zoneSide);
        zoneSide = side;
      }
      if (side) {
        dropSide = side;
        dropRef = showDropPreview(p, side, ev.clientX, ev.clientY);
      } else {
        dropSide = null;
        clearDropPreview();
      }
    };
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (head.hasPointerCapture?.(e.pointerId)) head.releasePointerCapture(e.pointerId);
      clearDropPreview();
      p.classList.remove('dragging');
      if (moved && dropSide) dockPanelAt(p, dropSide, dropRef);
      // a deliberate float placement opts this window out of default docking
      else if (moved) p.dataset.placed = '1';
      // normalizes hidden state for whichever drawer(s) were touched, and is
      // a harmless no-op for any that weren't
      DOCK_SIDES.forEach(refreshDrawerDividers);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });
}
document.querySelectorAll('.panel').forEach(makePanelWindow);

// ---------------------------------------------------------------------------
// dockable left/right drawers: panels float by default (above); this adds an
// alternate home where any of PANEL_IDS can stack, get hidden as a group, and
// be resized — without changing anything about how floating panels behave
// ---------------------------------------------------------------------------

// a drawer is visible exactly when it has a docked window in it and is not
// collapsed — see refreshDrawerDividers. Collapsing (the ◧ ⬓ ◨ status-bar
// toggles) hides the drawer but keeps its windows locked inside, like other
// editors' panel toggles.
UI.drawers = {
  left: [], right: [], bottom: [],
  widthLeft: 300, widthRight: 300, heightBottom: 240,
  collapsed: { left: false, right: false, bottom: false },
};

const DOCK_SIDES = ['left', 'right', 'bottom'];

const panelFloatRect = new Map(); // panel element -> its floating {left,top,right,bottom}, for undock

function drawerEl(side) { return $(`drawer-${side}`); }

// the bottom drawer stacks panels horizontally; left/right stack vertically
function drawerHoriz(side) { return side === 'bottom'; }

function refreshDrawerDividers(side) {
  const dr = drawerEl(side);
  dr.querySelectorAll('.drawer-vresize, .drawer-hresize').forEach((d) => d.remove());
  // a docked-but-closed (×'d) panel stays a DOM child so re-opening it from
  // the toolbar still works, but it shouldn't hold the drawer open or get a
  // divider of its own
  const panels = [...dr.children].filter((c) => c.classList.contains('panel') && !c.hidden);
  const horiz = drawerHoriz(side);
  panels.forEach((p, i) => {
    p.style.flex = '1 1 0';
    if (i > 0) {
      const div = document.createElement('div');
      div.className = horiz ? 'drawer-hresize' : 'drawer-vresize';
      dr.insertBefore(div, p);
      wireSplit(div, panels[i - 1], p, horiz);
    }
  });
  dr.hidden = panels.length === 0 || UI.drawers.collapsed[side];
  updateDockToggles();
}

// Drag the divider between two adjacent docked panels. Snapshot every visible
// panel at its current pixel size first, then move size only between the two
// panels adjacent to the handle; otherwise flexbox redistributes the delta
// across all docked panels in the drawer when there are three or more.
// `horiz` = panels flow horizontally (bottom drawer), so the split is on x.
function wireSplit(div, panelA, panelB, horiz) {
  const dim = horiz ? 'width' : 'height';
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const start = horiz ? e.clientX : e.clientY;
    const panels = [...div.parentElement.children]
      .filter((c) => c.classList.contains('panel') && !c.hidden);
    panels.forEach((p) => {
      p.style.flex = `0 0 ${p.getBoundingClientRect()[dim]}px`;
    });
    const startA = panelA.getBoundingClientRect()[dim];
    const startB = panelB.getBoundingClientRect()[dim];
    const total = startA + startB;
    const min = Math.min(60, total / 2);
    const move = (ev) => {
      const cur = horiz ? ev.clientX : ev.clientY;
      const a = Math.max(min, Math.min(total - min, startA + (cur - start)));
      panelA.style.flex = `0 0 ${a}px`;
      panelB.style.flex = `0 0 ${total - a}px`;
    };
    const up = () => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', up);
      if (div.hasPointerCapture?.(e.pointerId)) div.releasePointerCapture(e.pointerId);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', up);
  });
}

// status-bar dock toggles: collapse/expand a dock without undocking its
// windows (the drawer just disappears until toggled back or a window opens)
function toggleDock(side) {
  UI.drawers.collapsed[side] = !UI.drawers.collapsed[side];
  refreshDrawerDividers(side);
}

function uncollapseDock(side) {
  if (UI.drawers.collapsed[side]) {
    UI.drawers.collapsed[side] = false;
    refreshDrawerDividers(side);
  }
}

function updateDockToggles() {
  for (const side of DOCK_SIDES) {
    const btn = $(`dock-${side}`);
    if (!btn) continue;
    const hasPanels = [...drawerEl(side).children]
      .some((c) => c.classList.contains('panel') && !c.hidden);
    const collapsed = UI.drawers.collapsed[side];
    btn.classList.toggle('on', hasPanels && !collapsed);
    btn.title = `${collapsed ? 'show' : 'hide'} the ${side} dock` +
      (hasPanels ? '' : ' (empty)');
  }
}

function wireDrawerWidthResize(side) {
  const dr = drawerEl(side);
  const handle = document.createElement('div');
  handle.className = 'drawer-resize';
  dr.appendChild(handle);
  const horiz = side === 'bottom'; // bottom dock resizes its *height*
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = horiz ? e.clientY : e.clientX;
    const startSz = dr.getBoundingClientRect()[horiz ? 'height' : 'width'];
    const move = (ev) => {
      if (horiz) {
        const h = Math.max(100, Math.min(innerHeight * 0.6, startSz - (ev.clientY - start)));
        dr.style.height = `${h}px`;
        UI.drawers.heightBottom = h;
      } else {
        const dx = ev.clientX - start;
        const w = Math.max(160, Math.min(600, side === 'left' ? startSz + dx : startSz - dx));
        dr.style.width = `${w}px`;
        UI.drawers[side === 'left' ? 'widthLeft' : 'widthRight'] = w;
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
wireDrawerWidthResize('left');
wireDrawerWidthResize('right');
wireDrawerWidthResize('bottom');

// dropSideAt/showDropPreview/clearDropPreview drive the drag-and-drop dock
// path (see makePanelWindow): dock at a specific position, reorder within
// the same drawer, or move between drawers, all by dragging a panel's header
function dropSideAt(clientX, clientY) {
  const leftDr = drawerEl('left');
  const rightDr = drawerEl('right');
  const bottomDr = drawerEl('bottom');
  if (!bottomDr.hidden && clientY >= bottomDr.getBoundingClientRect().top) return 'bottom';
  if (!leftDr.hidden && clientX <= leftDr.getBoundingClientRect().right) return 'left';
  if (!rightDr.hidden && clientX >= rightDr.getBoundingClientRect().left) return 'right';
  // activation zone at the screen edge, so a currently-empty (hidden) drawer
  // can still be dropped into (the bottom zone sits above the status bar)
  const EDGE = 44;
  if (clientY >= innerHeight - 26 - EDGE && clientX > EDGE && clientX < innerWidth - EDGE) return 'bottom';
  if (clientX <= EDGE) return 'left';
  if (clientX >= innerWidth - EDGE) return 'right';
  return null;
}

// the docked panel (if any) just before which `p` should land, given a
// pointer y position — null means "append at the end"
const dndIndicator = document.createElement('div');
dndIndicator.id = 'dnd-indicator';
dndIndicator.hidden = true;
document.body.appendChild(dndIndicator);

// shows an insertion-line preview at the position `p` would land in `side`'s
// drawer for a drop at the pointer, and returns the panel to insert before
// (null = append at the end). Note: dr.children always includes the
// permanent .drawer-resize width handle, so "empty" is judged by panel count.
// Left/right drawers insert by y (stacked); the bottom drawer by x (side by
// side), with a vertical indicator line.
function showDropPreview(p, side, clientX, clientY) {
  const dr = drawerEl(side);
  dr.hidden = false; // reveal as a preview even if currently empty
  document.querySelectorAll('.drawer.drop-target').forEach((d) => { if (d !== dr) d.classList.remove('drop-target'); });
  dr.classList.add('drop-target');
  const horiz = drawerHoriz(side);
  const panels = [...dr.children].filter((c) => c.classList.contains('panel') && !c.hidden && c !== p);
  const ref = panels.find((cand) => {
    const cr = cand.getBoundingClientRect();
    return horiz ? clientX < cr.left + cr.width / 2 : clientY < cr.top + cr.height / 2;
  }) || null;
  let rect;
  let pos;
  if (ref) {
    rect = ref.getBoundingClientRect();
    pos = horiz ? rect.left : rect.top;
  } else if (panels.length) {
    rect = panels[panels.length - 1].getBoundingClientRect();
    pos = horiz ? rect.right : rect.bottom;
  } else {
    rect = dr.getBoundingClientRect();
    pos = (horiz ? rect.left : rect.top) + 6;
  }
  if (horiz) {
    dndIndicator.style.left = `${pos - 1}px`;
    dndIndicator.style.width = '2px';
    dndIndicator.style.top = `${rect.top}px`;
    dndIndicator.style.height = `${rect.height}px`;
  } else {
    dndIndicator.style.left = `${rect.left}px`;
    dndIndicator.style.width = `${rect.width}px`;
    dndIndicator.style.top = `${pos - 1}px`;
    dndIndicator.style.height = '2px';
  }
  dndIndicator.hidden = false;
  return ref;
}

function clearDropPreview() {
  dndIndicator.hidden = true;
  document.querySelectorAll('.drawer.drop-target').forEach((d) => d.classList.remove('drop-target'));
}

function dockPanelAt(p, side, beforeEl) {
  const oldSide = p.dataset.dockSide;
  if (!oldSide) {
    panelFloatRect.set(p, { left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom });
  }
  uncollapseDock(side); // docking into a hidden dock reveals it
  p.classList.add('docked');
  p.dataset.dockSide = side;
  p.hidden = false;
  drawerEl(side).insertBefore(p, beforeEl || null);
  // id-keyed bookkeeping is only for session persistence of the fixed
  // PANEL_IDS windows — dynamically-created pinned allocation windows have
  // no stable id and dock/reorder/undock fine without being tracked here
  if (oldSide && oldSide !== side && p.id) {
    const oldArr = UI.drawers[oldSide];
    const oi = oldArr.indexOf(p.id);
    if (oi >= 0) oldArr.splice(oi, 1);
  }
  if (p.id) {
    // rebuild from actual DOM order: correct for both a fresh dock and a
    // same-drawer reorder, no manual index bookkeeping needed
    UI.drawers[side] = [...drawerEl(side).children]
      .filter((c) => c.classList.contains('panel') && c.id)
      .map((c) => c.id);
  }
  refreshDrawerDividers(side);
  if (oldSide && oldSide !== side) refreshDrawerDividers(oldSide);
}

function dockPanel(p, side) {
  dockPanelAt(p, side, null);
}

function undockPanel(p) {
  const side = p.dataset.dockSide;
  if (!side) return;
  delete p.dataset.dockSide;
  p.classList.remove('docked');
  p.style.flex = '';
  document.body.appendChild(p);
  const r = panelFloatRect.get(p);
  if (r) {
    p.style.left = r.left; p.style.top = r.top; p.style.right = r.right; p.style.bottom = r.bottom;
  }
  panelFloatRect.delete(p);
  if (p.id) {
    const arr = UI.drawers[side];
    const i = arr.indexOf(p.id);
    if (i >= 0) arr.splice(i, 1);
  }
  refreshDrawerDividers(side);
  raisePanel(p);
}

// re-dock panels and restore drawer sizes/visibility from a saved session
function applyDrawersState(d) {
  if (!d) return;
  UI.drawers = {
    left: [], right: [], bottom: [],
    widthLeft: d.widthLeft || 300,
    widthRight: d.widthRight || 300,
    heightBottom: d.heightBottom || 240,
    collapsed: { left: false, right: false, bottom: false },
  };
  drawerEl('left').style.width = `${UI.drawers.widthLeft}px`;
  drawerEl('right').style.width = `${UI.drawers.widthRight}px`;
  drawerEl('bottom').style.height = `${UI.drawers.heightBottom}px`;
  // dockPanel pushes into UI.drawers.<side> itself and shows the drawer
  // (via refreshDrawerDividers) as soon as it has content
  (d.left || []).forEach((id) => { if ($(id)) dockPanel($(id), 'left'); });
  (d.right || []).forEach((id) => { if ($(id)) dockPanel($(id), 'right'); });
  (d.bottom || []).forEach((id) => { if ($(id)) dockPanel($(id), 'bottom'); });
  // collapsed state applies after content is in place
  if (d.collapsed) {
    UI.drawers.collapsed = { left: !!d.collapsed.left, right: !!d.collapsed.right, bottom: !!d.collapsed.bottom };
    DOCK_SIDES.forEach(refreshDrawerDividers);
  }
}

// panel open/close plumbing
for (const [btn, panel] of [
  ['btn-playcfg', 'play-panel'],
  ['btn-layout', 'layout-panel'],
  ['btn-filter', 'filter-panel'],
  ['btn-analysis', 'analysis-panel'],
  ['btn-warnings', 'warnings-panel'],
  ['btn-lanes', 'lanes-panel'],
  ['btn-logs', 'logs-panel'],
  ['btn-active', 'active-panel'],
]) {
  $(btn).onclick = () => {
    const p = $(panel);
    if (p.hidden) {
      showPanel(panel);
      // views that project current state need a fill on open
      if (panel === 'logs-panel') updateLogsPanel(true);
      else if (panel === 'active-panel') updateActivePanel(true);
      else if (panel === 'events-panel') refreshEventsPanel();
    } else {
      p.hidden = true;
      if (p.dataset.dockSide) refreshDrawerDividers(p.dataset.dockSide);
    }
  };
}
document.querySelectorAll('.panel-close').forEach((b) => {
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
    `<div class="warn-row${w.anomaly ? ' anomaly' : ''}" data-seq="${w.seq}">` +
    `<span class="warn-seq">#${w.seq}</span>` +
    `<span class="warn-msg">${esc(w.msg)}${w.addr ? ` <span class="dim">${w.addr}</span>` : ''}</span></div>`).join('');
  list.innerHTML = html || '<i>none</i>';
  list.querySelectorAll('.warn-row').forEach((row) => {
    row.onclick = () => worker.postMessage({ type: 'jump', seq: +row.dataset.seq + 1 });
  });
}

// ---------------------------------------------------------------------------
// events panel (virtualized sequential list)
// ---------------------------------------------------------------------------

const EV_ROW = 18;            // px per row
const EV_MAX_SPACER = 12e6;   // cap the scroll height; index-mapped beyond it
const evState = { from: 0, count: 0, reqId: 0, lastSeq: -1 };

function evLayout() {
  const n = UI.meta ? UI.meta.n : 0;
  const viewH = $('events-scroll').clientHeight;
  const spacerH = Math.min(n * EV_ROW, EV_MAX_SPACER);
  const visN = Math.max(1, Math.ceil(viewH / EV_ROW) + 1);
  const maxFrom = Math.max(0, n - visN + 1);
  return { n, viewH, spacerH, visN, maxFrom };
}

function refreshEventsPanel() {
  if (!UI.loaded || $('events-panel').hidden) return;
  const L = evLayout();
  $('events-spacer').style.height = `${L.spacerH}px`;
  const sc = $('events-scroll');
  const denom = Math.max(1, L.spacerH - L.viewH);
  const from = Math.min(L.maxFrom, Math.round((sc.scrollTop / denom) * L.maxFrom));
  $('events-rows').style.top = `${sc.scrollTop}px`;
  evState.from = from;
  evState.count = L.visN;
  evState.reqId = UI.reqId++;
  worker.postMessage({ type: 'events', from, count: L.visN, reqId: evState.reqId });
  updateEventsSelBand();
}

function onEventsSlice(m) {
  if (m.reqId !== evState.reqId) return;
  const curSeq = UI.state ? UI.state.seq - 1 : -1;
  $('events-rows').innerHTML = m.events.map((ev) => {
    let body;
    if (ev.op === 3 || ev.op === 4) {
      body = `<span class="ev-addr">${ev.thr !== undefined ? `thr ${ev.thr}` : 'global'}</span>
        <span class="ev-site">${esc(ev.name)}</span>`;
    } else if (ev.op === 5) {
      body = `<span class="ev-addr">${esc(ev.lvl)}</span>
        <span class="ev-site" title="${esc(ev.msg)}">${esc(ev.msg)}</span>`;
    } else {
      body = `<span class="ev-addr">${ev.addr}</span>
        <span class="ev-size">${fmtAllocSize(ev.size)}</span>
        <span class="ev-site">${ev.invalid ? '⚠ invalid free' : ev.site ? esc(ev.site) : ''}</span>`;
    }
    return `
    <div class="ev-row${ev.seq === curSeq ? ' cur' : ''}" data-seq="${ev.seq}" title="click: seek here and select the allocation">
      <span class="ev-seq">${fmtNum(ev.seq)}</span>
      <span class="ev-op ${OP_CLASS[ev.op]}">${OP_LETTER[ev.op]}</span>
      ${body}
    </div>`;
  }).join('');
  $('events-rows').querySelectorAll('.ev-row').forEach((row) => {
    row.onclick = () => {
      const seq = +row.dataset.seq;
      if (UI.state && seq === UI.state.seq - 1) {
        // already the current event: flash exactly where it is on the map
        worker.postMessage({ type: 'flash-event', seq });
      } else {
        worker.postMessage({ type: 'jump', seq: seq + 1, select: true });
      }
    };
  });
}

// pulse overlay marking the exact location of an allocation (from the event
// list); a ping ring makes even sub-pixel allocations findable
function flashRects(rects) {
  const view = $('addr-view');
  for (const r of (rects || []).slice(0, 16)) {
    const x = r.x / dpr;
    const y = r.y / dpr;
    const w = Math.max(3, r.w / dpr);
    const h = Math.max(3, r.h / dpr);
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
function updateEventsPanel() {
  if (!UI.loaded || $('events-panel').hidden || !UI.state) return;
  const cur = UI.state.seq - 1;
  if (cur === evState.lastSeq) return;
  evState.lastSeq = cur;
  if ($('ev-follow').checked && (cur < evState.from || cur >= evState.from + evState.count - 1)) {
    evScrollToSeq(cur);
    return;
  }
  $('events-rows').querySelectorAll('.ev-row').forEach((row) => {
    row.classList.toggle('cur', +row.dataset.seq === cur);
  });
}

function evScrollToSeq(seq) {
  const L = evLayout();
  const target = Math.max(0, Math.min(L.maxFrom, seq - Math.floor(L.visN / 2)));
  const y = (target / Math.max(1, L.maxFrom)) * Math.max(0, L.spacerH - L.viewH);
  $('events-scroll').scrollTop = y;
  refreshEventsPanel();
}

function stepEventsSelection(delta) {
  if (!UI.loaded || !UI.state || !UI.state.n) return;
  const cur = UI.state.seq - 1;
  const target = Math.max(0, Math.min(UI.state.n - 1, cur + delta));
  worker.postMessage({ type: 'jump', seq: target + 1, select: true });
}

function resetEventsPanel() {
  evState.lastSeq = -1;
  $('events-scroll').scrollTop = 0;
  $('events-rows').innerHTML = '';
  if (!$('events-panel').hidden) refreshEventsPanel();
}

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
  const yToSeq = (y) => evState.from + (y - scEl.getBoundingClientRect().top) / EV_ROW;
  scEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !UI.loaded) return;
    dragFromY = e.clientY;
    dragFromSeq = yToSeq(e.clientY);
    dragCaptured = false;
    // don't capture yet: setPointerCapture re-targets the eventual click to
    // this element too, which would swallow plain row clicks (jump-to-event)
  });
  scEl.addEventListener('pointermove', (e) => {
    if (dragFromY === null || Math.abs(e.clientY - dragFromY) < 3) return;
    if (!dragCaptured) { scEl.setPointerCapture(e.pointerId); dragCaptured = true; }
    const n = UI.state ? UI.state.n : (UI.meta ? UI.meta.n : 0);
    const b = yToSeq(e.clientY);
    UI.sel = { kind: 1, lo: Math.max(0, Math.min(dragFromSeq, b)), hi: Math.min(n, Math.max(dragFromSeq, b)) };
    updateSelOverlay();
    requestSelMirror();
  });
  scEl.addEventListener('pointerup', (e) => {
    if (dragFromY === null) return;
    const moved = dragCaptured;
    dragFromY = null;
    dragCaptured = false;
    if (moved && UI.sel && UI.sel.kind === 1) openSelPopover(e.clientX, e.clientY);
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

// ---------------------------------------------------------------------------
// tags & range selection
// ---------------------------------------------------------------------------

function tagIdFor(name) {
  name = name.trim();
  if (!name) return 0;
  let i = UI.tags.findIndex((t) => t.name === name);
  if (i === -1) {
    i = UI.tags.length;
    UI.tags.push({ name, color: CAT[i % 12], visible: true });
    syncTagDatalist();
    sendTagColors();
    buildTagsSection();
    $('btn-analysis').hidden = false;
    markDirty();
  }
  return i + 1;
}

function syncTagDatalist() {
  document.querySelectorAll('datalist.tag-names, #tag-names').forEach((dl) => {
    dl.innerHTML = UI.tags.map((t) => `<option value="${esc(t.name)}">`).join('');
  });
}

function sendTagColors() {
  worker.postMessage({
    type: 'tag-colors',
    colors: UI.tags.map((t) => parseInt(t.color.slice(1), 16)),
  });
}

function buildMarksPanel() {
  buildBookmarksSection();
  buildAddrMarksSection();
  buildNamesSection();
}

function buildBookmarksSection() {
  const list = $('an-bookmarks');
  if (!UI.bookmarks.length) {
    list.innerHTML = '<div class="empty">none — press “＋ mark” (or m) to bookmark the current position</div>';
    return;
  }
  list.innerHTML = UI.bookmarks.map((b, i) => `<div class="an-row">
      <input type="text" class="grow" data-bmname="${i}" value="${esc(b.name)}">
      <span class="pos" data-bmgo="${i}" title="jump in time — the address view stays where it is">seq ${fmtNum(b.seq)} · ${fmtTime(b.t)}</span>
      <button class="x" data-bmloc="${i}" title="jump in time and center where that event happened">⌖</button>
      <button class="x" data-bmdel="${i}">×</button>
    </div>`).join('');
  list.querySelectorAll('[data-bmname]').forEach((inp) => {
    inp.onchange = () => {
      UI.bookmarks[+inp.dataset.bmname].name = inp.value.trim() || `mark ${+inp.dataset.bmname + 1}`;
      updateMarkers();
      markDirty();
    };
  });
  list.querySelectorAll('[data-bmgo]').forEach((el) => {
    // time-only: anchored seek keeps the current address in the viewport
    el.onclick = () => worker.postMessage({ type: 'seek', seq: UI.bookmarks[+el.dataset.bmgo].seq });
  });
  list.querySelectorAll('[data-bmloc]').forEach((el) => {
    // time + place: centers the allocation the event touched
    el.onclick = () => worker.postMessage({ type: 'jump', seq: UI.bookmarks[+el.dataset.bmloc].seq });
  });
  list.querySelectorAll('[data-bmdel]').forEach((el) => {
    el.onclick = () => {
      UI.bookmarks.splice(+el.dataset.bmdel, 1);
      buildBookmarksSection();
      updateMarkers();
      markDirty();
    };
  });
}

function buildTagsSection() {
  const list = $('tags-list');
  if (!UI.tags.length) {
    list.innerHTML = '<div class="empty">none — shift-drag a range on a timeline, or tag an allocation from its panel</div>';
    return;
  }
  let html = UI.tags.map((t, i) => `<div class="an-row">
      <input type="checkbox" data-tagvis="${i + 1}" ${t.visible ? 'checked' : ''} title="visible">
      <input type="color" data-tagcolor="${i + 1}" value="${t.color}">
      <input type="text" class="grow" data-tagname="${i + 1}" value="${esc(t.name)}">
      <span class="count">${fmtNum(UI.tagCounts[i + 1] || 0)}</span>
      <button class="x" data-tagdel="${i + 1}" title="delete tag (untags its allocations)">×</button>
    </div>`).join('');
  html += `<div class="an-row">
      <input type="checkbox" data-tagvis="0" ${UI.untaggedVisible ? 'checked' : ''} title="visible">
      <span class="swatch" style="background:#39414a"></span>
      <span class="grow">untagged</span>
      <span class="count">${fmtNum(UI.tagCounts[0] || 0)}</span>
    </div>`;
  list.innerHTML = html;
  list.querySelectorAll('input[data-tagvis]').forEach((inp) => {
    inp.onchange = () => {
      const id = +inp.dataset.tagvis;
      if (id === 0) UI.untaggedVisible = inp.checked;
      else UI.tags[id - 1].visible = inp.checked;
      sendFilter();
      markDirty();
    };
  });
  list.querySelectorAll('input[data-tagcolor]').forEach((inp) => {
    inp.oninput = () => {
      UI.tags[+inp.dataset.tagcolor - 1].color = inp.value;
      sendTagColors();
      buildLegend();
      markDirty();
    };
  });
  list.querySelectorAll('input[data-tagname]').forEach((inp) => {
    inp.onchange = () => {
      const v = inp.value.trim();
      if (v) UI.tags[+inp.dataset.tagname - 1].name = v;
      syncTagDatalist();
      buildLegend();
      markDirty();
    };
  });
  list.querySelectorAll('[data-tagdel]').forEach((el) => {
    el.onclick = () => deleteTag(+el.dataset.tagdel);
  });
}

// all / none visibility toggles for the tags list (untagged included)
document.querySelectorAll('#tags-allnone a').forEach((a) => {
  a.onclick = () => {
    const on = a.dataset.an === 'all';
    UI.untaggedVisible = on;
    UI.tags.forEach((t) => { t.visible = on; });
    buildTagsSection();
    sendFilter();
    markDirty();
  };
});

function deleteTag(id) {
  worker.postMessage({ type: 'retag', from: id, to: 0 });
  for (let k = id + 1; k <= UI.tags.length; k++) {
    worker.postMessage({ type: 'retag', from: k, to: k - 1 });
  }
  UI.tags.splice(id - 1, 1);
  // with no tags left, buildTagsSection renders only the "none yet" hint —
  // no checkbox survives to undo an "untagged" filter, which would strand
  // the user with everything hidden and no obvious way back except the
  // Filter panel's unrelated "clear" button; auto-restore visibility instead
  if (UI.tags.length === 0) UI.untaggedVisible = true;
  syncTagDatalist();
  sendTagColors();
  buildTagsSection();
  sendFilter();
  buildLegend();
  markDirty();
}

function buildNamesSection() {
  const list = $('an-names');
  const entries = [...UI.names.entries()];
  if (!entries.length) {
    list.innerHTML = '<div class="empty">none — click an allocation and name it in its panel</div>';
    return;
  }
  list.innerHTML = entries.map(([e, v]) => `<div class="an-row">
      <input type="color" data-ncolor="${e}" value="${UI.allocColors.get(e) || '#3fb950'}" title="highlight color">
      <input type="text" class="grow" data-nname="${e}" value="${esc(v.name)}">
      <span class="pos" data-ngo="${e}" title="select and jump to birth">#${e} · ${v.addr}</span>
      <button class="x" data-ndel="${e}">×</button>
    </div>`).join('');
  list.querySelectorAll('[data-ncolor]').forEach((inp) => {
    inp.oninput = () => {
      const e = +inp.dataset.ncolor;
      UI.allocColors.set(e, inp.value);
      worker.postMessage({ type: 'alloc-color', e, rgb: parseInt(inp.value.slice(1), 16) });
      markDirty();
    };
  });
  list.querySelectorAll('[data-nname]').forEach((inp) => {
    inp.onchange = () => {
      const e = +inp.dataset.nname;
      const v = inp.value.trim();
      if (v) UI.names.get(e).name = v;
      else { UI.names.delete(e); buildNamesSection(); }
      sendNames();
      markDirty();
    };
  });
  list.querySelectorAll('[data-ngo]').forEach((el) => {
    el.onclick = () => {
      // select, jump to birth, and open the allocation info window
      worker.postMessage({ type: 'jump', seq: +el.dataset.ngo + 1, select: true });
    };
  });
  list.querySelectorAll('[data-ndel]').forEach((el) => {
    el.onclick = () => {
      const e = +el.dataset.ndel;
      UI.names.delete(e);
      if (UI.allocColors.delete(e)) {
        worker.postMessage({ type: 'alloc-color', e, rgb: null });
      }
      buildNamesSection();
      sendNames();
      markDirty();
    };
  });
}

// ---------------------------------------------------------------------------
// address marks
// ---------------------------------------------------------------------------

function sendAddrMarks() {
  worker.postMessage({
    type: 'addr-marks',
    marks: UI.addrMarks.map((m) => {
      const a = BigInt(m.addr);
      return { lo: Number(a & 0xffffffffn), hi: Number((a >> 32n) & 0xffffffffn) };
    }),
  });
}

function gotoAddr(addrHex) {
  const a = BigInt(addrHex);
  worker.postMessage({
    type: 'goto-addr',
    lo: Number(a & 0xffffffffn),
    hi: Number((a >> 32n) & 0xffffffffn),
  });
}

function addAddrMark(addrHex) {
  UI.addrMarks.push({ name: `addr ${UI.addrMarks.length + 1}`, addr: addrHex });
  sendAddrMarks();
  buildAddrMarksSection();
  $('st-info').textContent = `marked ${addrHex} — rename it in the Marks panel`;
  showPanel('analysis-panel');
  markDirty();
}

function buildAddrMarksSection() {
  const list = $('an-addrmarks');
  if (!UI.addrMarks.length) {
    list.innerHTML = '<div class="empty">none — shift-click the address map to mark an address</div>';
    return;
  }
  list.innerHTML = UI.addrMarks.map((m, i) => `<div class="an-row">
      <input type="text" class="grow" data-amname="${i}" value="${esc(m.name)}">
      <span class="pos" data-amgo="${i}" title="center on this address">${esc(m.addr)}</span>
      <button class="x" data-amdel="${i}">×</button>
    </div>`).join('');
  list.querySelectorAll('[data-amname]').forEach((inp) => {
    inp.onchange = () => {
      UI.addrMarks[+inp.dataset.amname].name = inp.value.trim() || `addr ${+inp.dataset.amname + 1}`;
      renderAddrMarkLines();
      markDirty();
    };
  });
  list.querySelectorAll('[data-amgo]').forEach((el) => {
    el.onclick = () => gotoAddr(UI.addrMarks[+el.dataset.amgo].addr);
  });
  list.querySelectorAll('[data-amdel]').forEach((el) => {
    el.onclick = () => {
      UI.addrMarks.splice(+el.dataset.amdel, 1);
      markDirty();
      sendAddrMarks();
      buildAddrMarksSection();
    };
  });
}

let lastAddrMarkYs = [];
function renderAddrMarkLines() {
  const box = $('addr-mark-lines');
  box.innerHTML = UI.addrMarks.map((m, i) => {
    const y = lastAddrMarkYs[i];
    if (y === null || y === undefined) return '';
    return `<div class="amark" style="top:${y}px" data-am="${i}" data-label="⚑ ${esc(m.name)} ${esc(m.addr)}"></div>`;
  }).join('');
  box.querySelectorAll('.amark').forEach((el) => {
    el.onclick = () => gotoAddr(UI.addrMarks[+el.dataset.am].addr);
  });
}

// ---------------------------------------------------------------------------
// time marks (bookmarks)
// ---------------------------------------------------------------------------

function addBookmark() {
  if (!UI.state) return;
  const b = { name: `mark ${UI.bookmarks.length + 1}`, seq: UI.state.seq, t: UI.state.t };
  UI.bookmarks.push(b);
  buildBookmarksSection();
  updateMarkers();
  $('st-info').textContent = `bookmarked seq ${fmtNum(b.seq)} · ${fmtTime(b.t)} — rename it in the Marks panel`;
  showPanel('analysis-panel');
  markDirty();
}
$('btn-mark').onclick = addBookmark;

function updateMarkers() {
  for (const [stripId, kind] of [['strip-t', 0], ['strip-s', 1]]) {
    const strip = $(stripId);
    const marks = strip.querySelector('.tl-marks');
    const v = kind === 0 ? UI.tlT : UI.tlS;
    const w = strip.clientWidth;
    marks.innerHTML = UI.bookmarks.map((b, i) => {
      const val = kind === 0 ? b.t : b.seq;
      const x = ((val - v.lo) / (v.hi - v.lo)) * w;
      if (x < 0 || x > w) return '';
      return `<div class="mark" style="left:${x}px" data-bm="${i}" data-label="⚑ ${esc(b.name)}" title="${esc(b.name)} — click: jump in time · shift+click: also center the place"></div>`;
    }).join('');
    marks.querySelectorAll('.mark').forEach((el) => {
      // plain click: time only (stay at the same address); shift+click: also
      // center where the event happened
      el.onclick = (ev) => worker.postMessage({
        type: ev.shiftKey ? 'jump' : 'seek',
        seq: UI.bookmarks[+el.dataset.bm].seq,
      });
    });
  }
}

// ---------------------------------------------------------------------------
// analysis save / load
// ---------------------------------------------------------------------------

const allocInfoWaiters = new Map();

// fetch alloc_info for a creator event directly (not via pixel pick) — used
// to recreate pinned allocation windows from a saved session
function requestAllocInfo(e) {
  return new Promise((resolve) => {
    const reqId = UI.reqId++;
    allocInfoWaiters.set(reqId, resolve);
    worker.postMessage({ type: 'alloc-info', e, reqId });
  });
}

const dumpWaiters = new Map();

function requestTagsDump() {
  return new Promise((resolve) => {
    const reqId = UI.reqId++;
    dumpWaiters.set(reqId, resolve);
    worker.postMessage({ type: 'tags-dump', reqId });
  });
}

async function buildMarks() {
  const taggedEvents = await requestTagsDump();
  return {
    heapVisualizerAnalysis: 1,
    saved: new Date().toISOString(),
    trace: {
      file: UI.fileName || null,
      title: UI.meta.title,
      n: UI.meta.n,
      tMin: UI.meta.tMin,
      tMax: UI.meta.tMax,
    },
    playhead: UI.state ? UI.state.seq : 0,
    rowBytes: rowBytesValue(),
    collapseMin: $('collapse-min').value.trim(),
    colorMode: +$('color-mode').value,
    tags: UI.tags.map((t) => ({ name: t.name, color: t.color, visible: t.visible })),
    taggedEvents,
    names: [...UI.names.entries()].map(([e, v]) => ({ e, name: v.name, addr: v.addr })),
    allocColors: [...UI.allocColors.entries()],
    bookmarks: UI.bookmarks,
    addrMarks: UI.addrMarks,
    // layout/filters/crop/drawers/window positions — folded in so the one
    // manually-exported file is a complete snapshot, not just the "marks"
    session: buildSession(),
  };
}

// tracks whether marks changed since the last save/load/autosave — drives
// the periodic marks autosave below, not a refresh warning: marks (like
// session/layout state) now auto-persist to localStorage, so there's nothing
// a plain refresh can actually lose
function markDirty() { UI.marksDirty = true; }

async function saveMarks() {
  if (!UI.loaded) return;
  const obj = await buildMarks();
  const base = (UI.fileName || 'trace').replace(/\.(heapl|jsonl|json|txt)$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  a.download = `${base}.heapa.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('st-info').textContent = `marks saved to ${a.download}`;
  UI.marksDirty = false;
}

function applyMarks(obj, quiet) {
  if (!obj || obj.heapVisualizerAnalysis !== 1) {
    if (!quiet) $('st-trace').textContent = 'not a heap-visualizer marks file';
    return;
  }
  if (!UI.loaded) {
    $('st-trace').textContent = 'load the matching trace first, then load the marks';
    return;
  }
  if (obj.trace && obj.trace.n !== UI.meta.n) {
    $('st-info').textContent =
      `⚠ analysis was saved for a trace with ${fmtNum(obj.trace.n)} events (this one has ${fmtNum(UI.meta.n)}) — applying anyway`;
  }
  // clear existing per-alloc colors, then rebuild everything from the file
  for (const e of UI.allocColors.keys()) {
    worker.postMessage({ type: 'alloc-color', e, rgb: null });
  }
  worker.postMessage({ type: 'tags-clear' });
  UI.tags = (obj.tags || []).map((t, i) => ({
    name: t.name || `tag ${i + 1}`,
    color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : CAT[i % 12],
    visible: t.visible !== false,
  }));
  sendTagColors();
  for (const [tagStr, events] of Object.entries(obj.taggedEvents || {})) {
    const tag = +tagStr;
    if (tag >= 1 && tag <= UI.tags.length && Array.isArray(events)) {
      worker.postMessage({ type: 'tag-events', tag, events });
    }
  }
  UI.names = new Map((obj.names || []).map((r) => [r.e, { name: r.name, addr: r.addr }]));
  sendNames();
  UI.allocColors = new Map((obj.allocColors || []).filter(([, c]) => /^#[0-9a-f]{6}$/i.test(c)));
  for (const [e, c] of UI.allocColors) {
    worker.postMessage({ type: 'alloc-color', e, rgb: parseInt(c.slice(1), 16) });
  }
  UI.bookmarks = (obj.bookmarks || []).map((b) => ({ name: String(b.name), seq: b.seq | 0, t: +b.t }));
  UI.addrMarks = (obj.addrMarks || []).filter((m) => /^0x[0-9a-f]+$/i.test(m.addr))
    .map((m) => ({ name: String(m.name), addr: m.addr.toLowerCase() }));
  sendAddrMarks();
  if (obj.rowBytes) {
    setRowBytesInput(obj.rowBytes);
    worker.postMessage({ type: 'set', key: 'rowBytes', value: obj.rowBytes });
  }
  if (obj.collapseMin) {
    $('collapse-min').value = String(obj.collapseMin);
    sendCollapseMin();
  }
  if (obj.colorMode !== undefined) {
    $('color-mode').value = String(obj.colorMode);
    worker.postMessage({ type: 'set', key: 'colorMode', value: obj.colorMode });
  }
  if (obj.playhead !== undefined) {
    worker.postMessage({ type: 'seek', seq: obj.playhead });
  }
  syncTagDatalist();
  sendFilter();
  buildMarksPanel();
  buildLegend();
  updateMarkers();
  // layout/filters/crop/drawers/window positions, if this file has them
  // (buildMarks folds in buildSession()) — applied last so they win over the
  // legacy rowBytes/collapseMin/colorMode/playhead fields above
  applySession(obj.session);
  if (!quiet) {
    showPanel('analysis-panel');
    $('st-info').textContent =
      `marks loaded: ${UI.tags.length} tags, ${UI.names.size} names, ${UI.bookmarks.length} time marks, ${UI.addrMarks.length} addr marks`;
  }
  UI.marksDirty = false;
}

UI.buildMarks = buildMarks;
UI.applyMarks = applyMarks;

$('an-save').onclick = saveMarks;
$('an-load').onclick = () => $('analysis-file').click();
$('analysis-file').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (f) {
    try {
      applyMarks(JSON.parse(await f.text()));
    } catch (e) {
      $('st-trace').textContent = `marks load failed: ${e.message}`;
    }
  }
  ev.target.value = '';
};

// ---------------------------------------------------------------------------
// session: filters, layout, view/zoom, crop, window & drawer state, playhead —
// everything *except* marks (tags/bookmarks/addr marks/names/colors, which
// stay manual Save…/Load… since they're meant to be portable/shared).
// Auto-persisted to localStorage per trace file name; restored silently on
// load. No manual UI for this — it's working state, not a deliverable.
// ---------------------------------------------------------------------------

function sessionKey() {
  return UI.fileName ? `heapviz:session:${UI.fileName}` : null;
}

function buildSession() {
  const windows = {};
  for (const id of PANEL_IDS) {
    const p = $(id);
    windows[id] = { hidden: p.hidden, left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom };
  }
  const fmode = document.querySelector('input[name=fmode]:checked');
  return {
    heapVisualizerSession: 1,
    rowBytes: $('row-bytes').value,
    collapseMin: $('collapse-min').value,
    rowPx: $('row-px').value,
    colorMode: $('color-mode').value,
    allocSizeFormat: allocSizeFormat(),
    showAll: $('show-all').checked,
    sizeLabels: $('show-sizes').checked,
    addrLabels: $('show-addrs').checked,
    xview: UI.xview,
    crop: UI.crop,
    filter: {
      fmode: fmode ? fmode.value : '1',
      sizeMin: $('f-size-min').value,
      sizeMax: $('f-size-max').value,
      // checkbox states by index — meaningful only against the same trace's
      // site/thread list, which is exactly what the file-name-scoped key gives us
      sites: [...document.querySelectorAll('#filter-panel input[data-site]')].map((b) => b.checked),
      thrs: [...document.querySelectorAll('#filter-panel input[data-thr]')].map((b) => b.checked),
    },
    playhead: UI.state ? UI.state.seq : 0,
    laneVis: UI.laneVis,
    windows,
    drawers: UI.drawers || null,
    // pinned allocation windows: re-fetched by creator event index on
    // restore (see applySession), since only the trace — not the info blob
    // itself — is worth persisting
    pinned: [...document.querySelectorAll('.pinned-detail')].map((win) => ({
      e: +win.dataset.e,
      dockSide: win.dataset.dockSide || null,
      left: win.style.left, top: win.style.top, right: win.style.right, bottom: win.style.bottom,
    })),
  };
}

function applySession(obj) {
  if (!obj || obj.heapVisualizerSession !== 1) return;
  if (obj.rowBytes !== undefined) {
    $('row-bytes').value = obj.rowBytes;
    const v = rowBytesValue();
    if (v > 0) worker.postMessage({ type: 'set', key: 'rowBytes', value: v });
  }
  if (obj.collapseMin !== undefined) { $('collapse-min').value = obj.collapseMin; sendCollapseMin(); }
  if (obj.rowPx !== undefined) {
    $('row-px').value = obj.rowPx;
    worker.postMessage({ type: 'set', key: 'rowPx', value: +$('row-px').value });
  }
  if (obj.colorMode !== undefined) {
    $('color-mode').value = obj.colorMode;
    worker.postMessage({ type: 'set', key: 'colorMode', value: +$('color-mode').value });
    buildLegend();
  }
  if (obj.allocSizeFormat !== undefined) {
    $('alloc-size-format').value = obj.allocSizeFormat === 'hex' ? 'hex' : 'human';
    sendAllocSizeFormat();
  }
  if (obj.showAll !== undefined) {
    $('show-all').checked = obj.showAll;
    worker.postMessage({ type: 'set', key: 'showAll', value: obj.showAll });
  }
  if (obj.sizeLabels !== undefined) {
    $('show-sizes').checked = obj.sizeLabels;
    worker.postMessage({ type: 'set', key: 'sizeLabels', value: obj.sizeLabels });
  }
  if (obj.addrLabels !== undefined) {
    $('show-addrs').checked = obj.addrLabels;
    worker.postMessage({ type: 'set', key: 'addrLabels', value: obj.addrLabels });
  }
  if (obj.xview) { UI.xview = obj.xview; sendXView(); }
  if (obj.filter) {
    const f = obj.filter;
    const fr = document.querySelector(`input[name=fmode][value="${f.fmode}"]`);
    if (fr) fr.checked = true;
    if (f.sizeMin !== undefined) $('f-size-min').value = f.sizeMin;
    if (f.sizeMax !== undefined) $('f-size-max').value = f.sizeMax;
    const siteBoxes = [...document.querySelectorAll('#filter-panel input[data-site]')];
    (f.sites || []).forEach((checked, i) => { if (siteBoxes[i]) siteBoxes[i].checked = checked; });
    const thrBoxes = [...document.querySelectorAll('#filter-panel input[data-thr]')];
    (f.thrs || []).forEach((checked, i) => { if (thrBoxes[i]) thrBoxes[i].checked = checked; });
    sendFilter();
  }
  if (obj.windows) {
    for (const id of PANEL_IDS) {
      const w = obj.windows[id];
      const p = $(id);
      if (!w || !p) continue;
      p.hidden = w.hidden;
      if (w.left) {
        p.style.left = w.left; p.style.top = w.top; p.style.right = w.right; p.style.bottom = w.bottom;
        // a restored floating position is a user placement: don't re-dock it
        p.dataset.placed = '1';
      }
    }
  }
  if (obj.crop) setCrop(obj.crop.lo, obj.crop.hi);
  if (obj.laneVis) { UI.laneVis = obj.laneVis; buildLanes(); }
  if (obj.playhead !== undefined) worker.postMessage({ type: 'seek', seq: obj.playhead });
  applyDrawersState(obj.drawers);
  restorePinnedWindows(obj.pinned);
}

// re-fetches each pinned allocation's info by creator event index (the trace
// itself, not the info blob, is what's persisted) and recreates its window,
// docked or floating exactly as saved
async function restorePinnedWindows(pinned) {
  if (!pinned || !pinned.length) return;
  document.querySelectorAll('.pinned-detail').forEach((w) => w.remove()); // avoid dupes on repeated restore
  for (const pw of pinned) {
    const info = await requestAllocInfo(pw.e);
    if (!info) continue; // stale/unknown event (e.g. mismatched trace): skip
    const win = createPinnedWindow(info, null);
    win.style.left = pw.left; win.style.top = pw.top; win.style.right = pw.right; win.style.bottom = pw.bottom;
    if (pw.dockSide) dockPanelAt(win, pw.dockSide, null);
  }
}

function saveSessionNow() {
  const key = sessionKey();
  if (!key || !UI.loaded) return;
  try { localStorage.setItem(key, JSON.stringify(buildSession())); } catch { /* storage full/unavailable: silently skip */ }
}

function marksKey() {
  return UI.fileName ? `heapviz:marks:${UI.fileName}` : null;
}

// marks (tags/bookmarks/addr marks/names/colors) also auto-persist to
// localStorage alongside the session — the manual Save…/Load… buttons are
// still there for a portable/shareable file, but there's no reason a plain
// refresh should lose work that was never explicitly exported
async function saveMarksAutosave() {
  const key = marksKey();
  if (!key || !UI.loaded) return;
  try {
    localStorage.setItem(key, JSON.stringify(await buildMarks()));
  } catch { /* storage full/unavailable: silently skip */ }
}

function restoreMarksAutosave() {
  const key = marksKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) applyMarks(JSON.parse(raw), true);
  } catch { /* corrupt/unavailable: ignore, nothing to restore */ }
}

// cheap periodic autosave rather than hooking every single input's change
// event — a full session snapshot is a handful of DOM reads, negligible next
// to render/scroll work, and this keeps every future settable from needing
// to remember to call a save function
let sessionSaveTimer = null;
function scheduleSessionAutosave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setInterval(() => {
    if (!UI.loaded) return;
    saveSessionNow();
    if (UI.marksDirty) saveMarksAutosave();
    // project runs also persist the analysis to their .heapa (only writes
    // when something changed)
    project.autosave();
  }, 2000);
}
scheduleSessionAutosave();
window.addEventListener('beforeunload', saveSessionNow);

function restoreSession() {
  const key = sessionKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) applySession(JSON.parse(raw));
  } catch { /* corrupt/unavailable: ignore, defaults stand */ }
}

function clearSelection() {
  UI.sel = null;
  UI.selMirror = null;
  $('sel-popover').hidden = true;
  document.querySelectorAll('.tl-select, .tl-select-echo').forEach((el) => { el.hidden = true; });
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

// thin band in the Events panel's scroll gutter spanning the seq range of
// the current selection (direct if kind is seq, mirrored if kind is time)
function updateEventsSelBand() {
  const band = $('events-sel-band');
  if (!UI.sel) { band.hidden = true; return; }
  const seqRange = UI.sel.kind === 1 ? UI.sel : UI.selMirror;
  if (!seqRange || $('events-panel').hidden) { band.hidden = true; return; }
  const L = evLayout();
  const sc = $('events-scroll');
  // viewport-relative y, from the currently-visible row window (evState.from)
  // — what refreshEventsPanel keeps accurate even once the spacer height is
  // capped for very long traces (EV_MAX_SPACER); #events-sel-band is a plain
  // sibling of the scroll content (unlike #events-rows, which self-cancels
  // scrollTop via its own `top` style), so re-add scrollTop to place it in
  // the scroll container's coordinate space
  const y0 = (seqRange.lo - evState.from) * EV_ROW;
  const y1 = (seqRange.hi - evState.from) * EV_ROW;
  band.hidden = y1 <= 0 || y0 >= L.viewH;
  if (!band.hidden) {
    const top = Math.max(0, Math.min(L.viewH, y0));
    const bot = Math.max(0, Math.min(L.viewH, y1));
    band.style.top = `${top + sc.scrollTop}px`;
    band.style.height = `${Math.max(2, bot - top)}px`;
  }
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
  if (e.key === 'Escape') clearSelection();
});

// ---------------------------------------------------------------------------
// timeline interaction
// ---------------------------------------------------------------------------

// mirror of the worker's clamping so optimistic local updates agree with it
function clampView(v, min, max, minSpan) {
  let { lo, hi } = v;
  if (hi - lo < minSpan) hi = lo + minSpan;
  const span = hi - lo;
  if (span >= max - min) return { lo: min, hi: Math.max(max, min + minSpan) };
  if (lo < min) { lo = min; hi = min + span; }
  if (hi > max) { hi = max; lo = max - span; }
  return { lo, hi };
}

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
    queryTlHover(kind, e.clientX - r.left, e.clientY);
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

let tlHoverReq = null;
function queryTlHover(kind, x, clientY) {
  tlHoverReq = { kind, x, clientY };
  if (!pending.tl) flushTlHover();
}
function flushTlHover() {
  if (!tlHoverReq || !UI.loaded) { pending.tl = null; return; }
  const q = tlHoverReq;
  tlHoverReq = null;
  pending.tl = UI.reqId++;
  worker.postMessage({ type: 'tlhover', kind: q.kind, x: q.x, reqId: pending.tl });
  pending.tlPos = q;
}
function onTlHoverResult(m) {
  if (m.reqId !== pending.tl) return;
  pending.tl = null;
  const q = pending.tlPos;
  if (m.info) {
    const i = m.info;
    const range = m.kind === 0
      ? `t ${fmtTime(i.from)} – ${fmtTime(i.to)}`
      : `seq ${fmtNum(Math.floor(i.from))} – ${fmtNum(Math.floor(i.to))}`;
    showTooltip('tl',
      `<span class="g">▲ ${fmtNum(i.g)} alloc</span>  <span class="r">▼ ${fmtNum(i.r)} free</span>\n<span class="dim">${range} · events ${fmtNum(i.seqFrom)}–${fmtNum(i.seqTo)}</span>`,
      q.xClient ?? 0, q.clientY);
    positionTooltipNearMouse();
  }
  if (tlHoverReq) flushTlHover();
}

// ---------------------------------------------------------------------------
// domain conversion (time <-> seq), for mirroring selection/zoom between the
// two timeline strips and the Events panel; coalesced like tlHover above so a
// fast drag never queues more than one in-flight request
// ---------------------------------------------------------------------------

let convertReq = null;   // {kind, lo, hi, cb} waiting to be sent
let convertInFlight = null;
let convertCb = null;

function requestConvert(kind, lo, hi, cb) {
  convertReq = { kind, lo, hi, cb };
  if (!convertInFlight) flushConvert();
}
function flushConvert() {
  if (!convertReq || !UI.loaded) { convertInFlight = null; return; }
  const q = convertReq;
  convertReq = null;
  convertInFlight = UI.reqId++;
  convertCb = q.cb;
  worker.postMessage({ type: 'convert', kind: q.kind, lo: q.lo, hi: q.hi, reqId: convertInFlight });
}
function onConvertResult(m) {
  if (m.reqId !== convertInFlight) return;
  convertInFlight = null;
  const cb = convertCb;
  convertCb = null;
  if (cb) cb(m.lo, m.hi);
  if (convertReq) flushConvert();
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

let pickQueue = null;
addrScroll.addEventListener('pointermove', (e) => {
  const r = addrCanvas.getBoundingClientRect();
  pickQueue = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (!pending.pick) flushPick(false);
});
addrScroll.addEventListener('pointerleave', () => {
  pickQueue = null;
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
  pending.pick = UI.reqId++;
  worker.postMessage({
    type: 'pick', x: e.clientX - r.left, y: e.clientY - r.top,
    reqId: pending.pick, forClick: true,
  });
});

function flushPick(forClick) {
  if (!pickQueue || !UI.loaded) { pending.pick = null; return; }
  const q = pickQueue;
  pickQueue = null;
  pending.pick = UI.reqId++;
  worker.postMessage({ type: 'pick', x: q.x, y: q.y, reqId: pending.pick, forClick });
}

function onPickResult(m) {
  if (m.reqId !== pending.pick) return;
  pending.pick = null;
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
      `<b>${name ? `“${esc(name)}”  ` : ''}#${info.e}</b>${info.site ? `  <span style="color:${CAT[(info.siteIdx ?? 0) % 12]}">${esc(info.site)}</span>` : ''}${tag ? `  <span style="color:${tag.color}">⬤ ${esc(tag.name)}</span>` : ''}`,
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
  if (pickQueue) flushPick(false);
}

// Render allocation info into `root` and wire its controls. Scoped by class
// (no ids) so the same body can live in the detail panel and in any number
// of pinned windows at once.
function buildDetailBody(root, info) {
  const rows = [
    ['alloc', `#${info.e} (birth event)`],
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
  </div>`;
  root.innerHTML = html;
  const q = (sel) => root.querySelector(sel);
  // same pulse as re-clicking the current event in the Events panel
  q('.d-focus').onclick = () => worker.postMessage({ type: 'flash-event', seq: info.e });
  q('.d-birth').onclick = () => worker.postMessage({ type: 'jump', seq: info.seq + 1 });
  const dd = q('.d-death');
  if (dd) dd.onclick = () => worker.postMessage({ type: 'jump', seq: info.deathSeq + 1 });
  q('.d-name').onchange = () => {
    const v = q('.d-name').value.trim();
    if (v) UI.names.set(info.e, { name: v, addr: info.addr });
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
    UI.allocColors.set(info.e, q('.d-color').value);
    worker.postMessage({ type: 'alloc-color', e: info.e, rgb: parseInt(q('.d-color').value.slice(1), 16) });
    buildNamesSection();
    markDirty();
  };
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
  const pins = [...document.querySelectorAll('.pinned-detail, .pinned-span')].map((w) => w.getBoundingClientRect());
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
  if (!info) {
    panel.hidden = true;
    if (panel.dataset.dockSide) refreshDrawerDividers(panel.dataset.dockSide);
    return;
  }
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
  showPanel('detail-panel'); // docks right by default, like the other windows
  // floating mode only: reset/cascade position when the live panel was just
  // vacated by a pin (so a fresh window doesn't land on the pinned one); a
  // plain close (× or Escape) leaves the window where the user left it
  // unless that spot is now covered by an open drawer
  if (!panel.dataset.dockSide && wasHidden) {
    placeLivePanel(panel, UI.detailWasPinned || !panelHasManualPosition(panel));
  }
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
  win.querySelector('.panel-close').onclick = () => {
    const side = win.dataset.dockSide;
    win.remove();
    if (side) refreshDrawerDividers(side);
  };
  win.querySelector('.d-pin').onclick = () => {
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
  makePanelWindow(win);
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
  if (live.dataset.dockSide) refreshDrawerDividers(live.dataset.dockSide);
};

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------

const tooltip = $('tooltip');
let tooltipOwner = null;
let mouse = { x: 0, y: 0 };
document.addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });

function showTooltip(owner, html) {
  tooltipOwner = owner;
  tooltip.innerHTML = html;
  tooltip.hidden = false;
}
function hideTooltip(owner) {
  if (tooltipOwner === owner) {
    tooltip.hidden = true;
    tooltipOwner = null;
  }
}
function positionTooltipNearMouse() {
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  let x = mouse.x + pad;
  let y = mouse.y + pad;
  if (x + r.width > innerWidth - 8) x = mouse.x - r.width - pad;
  if (y + r.height > innerHeight - 8) y = mouse.y - r.height - pad;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}

// ---------------------------------------------------------------------------
// project layer bootstrap (landing screen, runs, .heapa auto-persist)
// ---------------------------------------------------------------------------

project.init({
  loadBuffers,
  loadDemo: () => loadURL('demo.heapl'),
  buildMarks,
  applyMarks: (obj) => applyMarks(obj, true),
  status: (text) => { $('st-info').textContent = text; },
  isLoaded: () => UI.loaded,
  raisePanel,
  showPanel,
  panelClosed: (p) => { if (p.dataset.dockSide) refreshDrawerDividers(p.dataset.dockSide); },
});

// ---------------------------------------------------------------------------
// span/log lanes (spec v2 Part III, first slice): flame ribbons for the
// global lane and each thread lane, plus level-colored log ticks — temporal
// axis, sharing the time strip's view range and the playhead. Rendered on
// the main thread (span counts are small next to event counts); the full
// axis×content lane model (reorder, sequential-axis lanes, analysis spans)
// builds on this.
// ---------------------------------------------------------------------------

const LANE_ROW = 13;      // px per nesting depth row
const LANE_GAP = 3;       // px between lanes
const LANE_LOG = 12;      // px for the log tick lane
const LANE_MAX_DEPTH = 3; // deeper nesting draws into the last row

let laneHits = [];        // hit-test rects of the last render (CSS px)

function laneNameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CAT[h % CAT.length];
}

const LOG_LVL_COLOR = {
  trace: '#484f58', debug: '#6e7681', info: '#58a6ff',
  warn: '#d29922', error: '#f85149', fatal: '#ff7b72',
};

// group spans into lanes and assign nesting depths (stack sweep per lane)
function buildLanes() {
  const spans = UI.spans || [];
  const logs = UI.logs || [];
  const strip = $('lane-strip');
  const lanes = [];
  const grouped = new Map(); // lane key -> spans
  for (const sp of spans) {
    const key = sp.thr === null ? 'global' : `thr ${sp.thr}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(sp);
  }
  // global lane first, then thread lanes in id order
  const keys = [...grouped.keys()].sort((a, b) => {
    if (a === 'global') return -1;
    if (b === 'global') return 1;
    return +a.slice(4) - +b.slice(4);
  });
  // lane visibility: user-chosen set (Lanes panel, persisted per run).
  // Default keeps the strip calm: global phases + logs on, per-thread
  // function lanes opt-in.
  if (!UI.laneVis) {
    UI.laneVis = { logs: true };
    for (const k of keys) UI.laneVis[k] = k === 'global';
    // a run with only thread spans still shows something by default
    if (!keys.includes('global') && keys.length) UI.laneVis[keys[0]] = true;
  }
  const n = UI.meta ? UI.meta.n : 0;
  for (const key of keys) {
    const list = grouped.get(key);
    // depth: number of open ancestors at begin (spans arrive in begin order)
    const stack = []; // end indices of open ancestors
    let rows = 1;
    for (const sp of list) {
      const b = sp.begin ?? -1;
      const e = sp.end ?? n;
      while (stack.length && stack[stack.length - 1] <= b) stack.pop();
      sp.depth = Math.min(stack.length, LANE_MAX_DEPTH - 1);
      rows = Math.max(rows, sp.depth + 1);
      stack.push(e);
    }
    lanes.push({ key, spans: list, rows, on: UI.laneVis[key] !== false });
  }
  UI.laneAll = { lanes, hasLogs: logs.length > 0 };
  UI.laneLayout = {
    lanes: lanes.filter((l) => l.on),
    hasLogs: logs.length > 0 && UI.laneVis.logs !== false,
  };
  $('btn-lanes').hidden = !(lanes.length || logs.length);
  buildLanesPanel();
  const shown = UI.laneLayout.lanes.length || UI.laneLayout.hasLogs;
  strip.hidden = !shown;
  if (shown) {
    // the canvas is laid out at full content height; the strip viewport is
    // capped and scrolls when there are more lanes than fit
    const h = UI.laneLayout.lanes.reduce((s, l) => s + l.rows * LANE_ROW + LANE_GAP, 0) +
      (UI.laneLayout.hasLogs ? LANE_LOG : 0) + 4;
    UI.laneLayout.contentH = h;
    strip.style.height = `${Math.min(160, h)}px`;
    renderLanes();
  }
}

// the Lanes panel: check = lane shown; choices persist with the session
function buildLanesPanel() {
  const box = $('lanes-list');
  const A = UI.laneAll;
  if (!A || (!A.lanes.length && !A.hasLogs)) {
    box.innerHTML = '<div class="empty">this run has no spans or logs</div>';
    return;
  }
  let html = A.lanes.map((l) => `<label><input type="checkbox" data-lane="${esc(l.key)}"
    ${UI.laneVis[l.key] !== false ? 'checked' : ''}> ${esc(l.key)}
    <span class="dim">· ${l.spans.length} span${l.spans.length === 1 ? '' : 's'}</span></label>`).join('');
  if (A.hasLogs) {
    html += `<label><input type="checkbox" data-lane="logs"
      ${UI.laneVis.logs !== false ? 'checked' : ''}> logs
      <span class="dim">· ${(UI.logs || []).length} entries</span></label>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-lane]').forEach((inp) => {
    inp.onchange = () => {
      UI.laneVis[inp.dataset.lane] = inp.checked;
      buildLanes();
    };
  });
  $('lanes-allnone').querySelectorAll('a').forEach((a) => {
    a.onclick = () => {
      const on = a.dataset.an === 'all';
      for (const l of UI.laneAll.lanes) UI.laneVis[l.key] = on;
      UI.laneVis.logs = on;
      buildLanes();
    };
  });
}

let laneHover = null;   // hit under the cursor (for highlight)

function renderLanes() {
  const L = UI.laneLayout;
  const strip = $('lane-strip');
  if (!L || strip.hidden || !UI.loaded) return;
  const cv = $('lanes');
  const w = strip.clientWidth;
  const h = Math.max(strip.clientHeight, L.contentH || 0);
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = `${h}px`;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const v = UI.tlT;
  const span = Math.max(1e-9, v.hi - v.lo);
  const xOf = (t) => ((t - v.lo) / span) * w;
  laneHits = [];

  let y = 2;
  ctx.textBaseline = 'middle';
  let laneIdx = 0;
  const labelChips = []; // drawn last so ribbons never cover them
  for (const lane of L.lanes) {
    const laneH = lane.rows * LANE_ROW;
    // alternating lane bands + separators keep rows readable
    if (laneIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(230,237,243,0.025)';
      ctx.fillRect(0, y - 1, w, laneH + LANE_GAP - 1);
    }
    ctx.fillStyle = 'rgba(48,54,61,0.6)';
    ctx.fillRect(0, y + laneH + LANE_GAP - 2, w, 1);
    for (const sp of lane.spans) {
      const rx0 = xOf(sp.t0);
      const rx1 = xOf(sp.t1);
      if (rx1 < 0 || rx0 > w) continue;
      const x0 = Math.max(-4, rx0);
      const bw = Math.max(2, Math.min(w + 8, rx1) - x0);
      const by = y + sp.depth * LANE_ROW;
      const color = laneNameColor(sp.name);
      const hit = { x0, x1: x0 + bw, y0: by, y1: by + LANE_ROW, span: sp, lane: lane.key };
      laneHits.push(hit);
      const hovered = laneHover && laneHover.span === sp;
      const selected = UI.selSpan === sp.i;
      ctx.beginPath();
      ctx.roundRect(x0, by + 1, bw, LANE_ROW - 3, 3);
      ctx.fillStyle = color + (selected ? 'cc' : hovered ? 'aa' : '66');
      ctx.fill();
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.strokeStyle = selected ? '#e6edf3' : color;
      ctx.stroke();
      if (bw > 30) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = selected || hovered ? '#ffffff' : '#e6edf3';
        const avail = bw - 10;
        const label = sp.name.length * 6 > avail ? sp.name.slice(0, Math.max(1, avail / 6)) : sp.name;
        ctx.fillText(label, Math.max(2, x0) + 5, by + LANE_ROW / 2);
      }
    }
    labelChips.push({ text: lane.key, y: y + laneH / 2 });
    y += laneH + LANE_GAP;
    laneIdx++;
  }

  if (L.hasLogs) {
    if (laneIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(230,237,243,0.025)';
      ctx.fillRect(0, y - 1, w, LANE_LOG + 1);
    }
    for (const lg of UI.logs) {
      const x = xOf(lg.t);
      if (x < 0 || x > w) continue;
      const hovered = laneHover && laneHover.log === lg;
      ctx.fillStyle = LOG_LVL_COLOR[lg.lvl] || LOG_LVL_COLOR.info;
      ctx.fillRect(x - (hovered ? 1 : 0), y + 1, hovered ? 3.5 : 1.5, LANE_LOG - 2);
      laneHits.push({ x0: x - 3, x1: x + 3, y0: y, y1: y + LANE_LOG, log: lg });
    }
    labelChips.push({ text: 'logs', y: y + LANE_LOG / 2 });
  }

  // lane name chips over everything, like the strips' corner tags
  ctx.font = '9px ui-monospace, monospace';
  for (const chip of labelChips) {
    const tw = ctx.measureText(chip.text).width;
    ctx.fillStyle = 'rgba(13,17,23,0.78)';
    ctx.beginPath();
    ctx.roundRect(3, chip.y - 6.5, tw + 10, 13, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(139,148,158,0.95)';
    ctx.fillText(chip.text, 8, chip.y + 0.5);
  }

  // playhead (same convention as the strips above)
  if (UI.state) {
    const x = xOf(UI.state.t);
    if (x >= -2 && x <= w + 2) {
      ctx.fillStyle = 'rgba(230,237,243,0.08)';
      ctx.fillRect(0, 0, Math.max(0, x), h);
      ctx.fillStyle = '#e6edf3';
      ctx.fillRect(Math.round(x), 0, 1.5, h);
    }
  }
}

function laneHitAt(ev) {
  const strip = $('lane-strip');
  const r = strip.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top + strip.scrollTop; // hits are in content coords
  // topmost (deepest nested) hit wins
  for (let i = laneHits.length - 1; i >= 0; i--) {
    const t = laneHits[i];
    if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return t;
  }
  return null;
}

// span/log detail panel — the lane counterpart of the allocation panel,
// with the same pinning lifecycle (📌 keeps the window as-is; the next
// span/log selection opens a fresh live panel)

function buildSpanBody(root, sp) {
  const laneName = sp.thr === null ? 'global' : `thr ${sp.thr}`;
  const rows = [
    ['name', sp.name],
    ['lane', laneName],
    ['from', sp.begin !== null ? `event ${fmtNum(sp.begin)} · ${fmtTime(sp.t0)}` : `before trace (${fmtTime(sp.t0)})`],
    ['to', sp.end !== null ? `event ${fmtNum(sp.end)} · ${fmtTime(sp.t1)}` : `open at end (${fmtTime(sp.t1)})`],
    ['duration', fmtTime(sp.t1 - sp.t0)],
    ['events', fmtNum((sp.end ?? (UI.meta.n - 1)) - (sp.begin ?? 0) + 1)],
  ];
  let html = rows.map(([k, v2]) => `<div class="row"><span class="k">${k}</span><span>${esc(String(v2))}</span></div>`).join('');
  html += `<div class="actions">
    <button class="sp-begin">⏮ go to begin</button>
    <button class="sp-end">go to end ⏭</button>
    <button class="sp-zoom" title="Zoom both timelines to this span">🔍 zoom</button>
    <button class="sp-crop" title="Crop: dim everything not created during this span">✂ crop</button>
  </div>`;
  root.innerHTML = html;
  const b0 = sp.begin ?? 0;
  const b1 = sp.end ?? Math.max(0, UI.meta.n - 1);
  root.querySelector('.sp-begin').onclick = () => worker.postMessage({ type: 'jump', seq: b0 + 1, select: false });
  root.querySelector('.sp-end').onclick = () => worker.postMessage({ type: 'jump', seq: b1 + 1, select: false });
  root.querySelector('.sp-zoom').onclick = () => {
    if (UI.setView[0]) UI.setView[0]({ lo: sp.t0, hi: Math.max(sp.t1, sp.t0 + 1) });
  };
  root.querySelector('.sp-crop').onclick = () => setCrop(b0, b1 + 1);
}

function buildLogBody(root, lg) {
  const rows = [
    ['level', lg.lvl],
    ['message', lg.msg],
    lg.src ? ['source', lg.src] : null,
    lg.thr !== undefined ? ['thread', lg.thr] : null,
    ['event', `${fmtNum(lg.seq)} · ${fmtTime(lg.t)}`],
  ].filter(Boolean);
  let html = rows.map(([k, v2]) => `<div class="row"><span class="k">${k}</span><span>${esc(String(v2))}</span></div>`).join('');
  html += `<div class="actions"><button class="sp-begin">⏮ go to event</button></div>`;
  root.innerHTML = html;
  root.querySelector('.sp-begin').onclick = () => worker.postMessage({ type: 'jump', seq: lg.seq + 1, select: false });
}

// info = {kind:'span', sp} | {kind:'log', lg}; key dedupes pinned windows
function spanInfoKey(info) {
  return info.kind === 'span' ? `s${info.sp.i}` : `l${info.lg.seq}`;
}

function spanInfoTitle(info) {
  return info.kind === 'span' ? `Span · ${info.sp.name}` : `Log · ${info.lg.lvl}`;
}

function buildSpanInfoBody(root, info) {
  if (info.kind === 'span') buildSpanBody(root, info.sp);
  else buildLogBody(root, info.lg);
}

function openSpanPanel(info) {
  // never two windows for the same span/log: raise the pinned one instead
  const dup = document.querySelector(`.pinned-span[data-key="${spanInfoKey(info)}"]`);
  if (dup) {
    raisePanel(dup);
    return;
  }
  UI.spanInfo = info;
  const panel = $('span-panel');
  panel.querySelector('.ph-t').textContent = spanInfoTitle(info);
  buildSpanInfoBody($('span-body'), info);
  const wasHidden = panel.hidden;
  showPanel('span-panel');
  if (!panel.dataset.dockSide && wasHidden) {
    placeLivePanel(panel, UI.spanWasPinned || !panelHasManualPosition(panel));
  }
  UI.spanWasPinned = false;
  raisePanel(panel);
}

function selectSpan(sp) {
  UI.selSpan = sp.i;
  renderLanes();
  openSpanPanel({ kind: 'span', sp });
}

function selectLog(lg) {
  UI.selSpan = null;
  renderLanes();
  openSpanPanel({ kind: 'log', lg });
}

// standalone pinned span/log window — same lifecycle as pinned allocations
function createPinnedSpanWindow(info, rect) {
  const live = $('span-panel');
  const win = document.createElement('div');
  win.className = 'panel pinned-span';
  win.dataset.key = spanInfoKey(info);
  win.innerHTML = `<div class="panel-head"><span class="ph-t">${esc(spanInfoTitle(info))}</span>
      <span class="head-actions">
        <button class="d-pin pinned" title="Unpin — return this to the live Span/Log panel">📌</button>
        <button class="panel-close">×</button>
      </span></div>
    <div class="panel-body detail-body"></div>`;
  document.body.appendChild(win);
  buildSpanInfoBody(win.querySelector('.panel-body'), info);
  if (rect) {
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  }
  win.querySelector('.panel-close').onclick = () => {
    const side = win.dataset.dockSide;
    win.remove();
    if (side) refreshDrawerDividers(side);
  };
  win.querySelector('.d-pin').onclick = () => {
    const side = win.dataset.dockSide;
    const rr = win.getBoundingClientRect();
    win.remove();
    if (side) refreshDrawerDividers(side);
    openSpanPanel(info);
    if (!live.dataset.dockSide) {
      live.style.left = `${rr.left}px`;
      live.style.top = `${rr.top}px`;
      live.style.right = 'auto';
      live.style.bottom = 'auto';
      placeLivePanel(live);
    }
  };
  makePanelWindow(win);
  raisePanel(win);
  return win;
}

$('sp-pin').onclick = () => {
  const info = UI.spanInfo;
  if (!info) return;
  const live = $('span-panel');
  createPinnedSpanWindow(info, live.getBoundingClientRect());
  UI.spanWasPinned = true;
  live.hidden = true;
  if (live.dataset.dockSide) refreshDrawerDividers(live.dataset.dockSide);
};

{
  const strip = $('lane-strip');
  new ResizeObserver(() => renderLanes()).observe(strip);
  strip.addEventListener('mousemove', (ev) => {
    const hit = laneHitAt(ev);
    if ((hit && hit.span) !== (laneHover && laneHover.span) ||
        (hit && hit.log) !== (laneHover && laneHover.log)) {
      laneHover = hit;
      renderLanes();
    } else {
      laneHover = hit;
    }
    strip.style.cursor = hit ? 'pointer' : 'crosshair';
    if (hit && hit.span) {
      const sp = hit.span;
      showTooltip('lanes', [
        `<b>${esc(sp.name)}</b>  <span class="dim">${esc(hit.lane)}</span>`,
        `${fmtTime(sp.t0)} – ${fmtTime(sp.t1)}  <span class="g">${fmtTime(sp.t1 - sp.t0)}</span>`,
        '<span class="dim">click: select · dblclick: zoom to span</span>',
      ].join('\n'));
      positionTooltipNearMouse();
    } else if (hit && hit.log) {
      const lg = hit.log;
      showTooltip('lanes', [
        `<b>[${esc(lg.lvl)}]</b> ${esc(lg.msg)}`,
        `${lg.src ? esc(lg.src) + ' · ' : ''}${fmtTime(lg.t)}${lg.thr !== undefined ? ` · thr ${lg.thr}` : ''}`,
        '<span class="dim">click: select</span>',
      ].join('\n'));
      positionTooltipNearMouse();
    } else {
      hideTooltip('lanes');
    }
  });
  strip.addEventListener('mouseleave', () => {
    hideTooltip('lanes');
    if (laneHover) { laneHover = null; renderLanes(); }
  });
  strip.addEventListener('click', (ev) => {
    const hit = laneHitAt(ev);
    if (hit && hit.span) {
      selectSpan(hit.span);
    } else if (hit && hit.log) {
      selectLog(hit.log);
    } else if (UI.loaded) {
      // empty area: deselect + plain seek, like the strips
      if (UI.selSpan !== null && UI.selSpan !== undefined) { UI.selSpan = null; renderLanes(); }
      const r = strip.getBoundingClientRect();
      const v = UI.tlT;
      const t = v.lo + ((ev.clientX - r.left) / r.width) * (v.hi - v.lo);
      worker.postMessage({ type: 'seek', t });
    }
  });
  strip.addEventListener('dblclick', (ev) => {
    const hit = laneHitAt(ev);
    if (hit && hit.span && UI.setView[0]) {
      // zoom both timelines to the span
      UI.setView[0]({ lo: hit.span.t0, hi: Math.max(hit.span.t1, hit.span.t0 + 1) });
    } else if (UI.meta && UI.setView[0]) {
      UI.setView[0]({ lo: UI.meta.tMin, hi: Math.max(UI.meta.tMax, UI.meta.tMin + 1) });
    }
  });
  // zoom/pan on the lanes themselves — same gestures as the time strip,
  // driving the shared temporal view (UI.setView[0] mirrors to the events
  // strip); repaint immediately so the lanes feel attached to the wheel
  strip.addEventListener('wheel', (e) => {
    if (!UI.meta || !UI.setView[0]) return;
    e.preventDefault();
    const v = UI.tlT;
    const span = v.hi - v.lo;
    if (e.shiftKey) {
      const d = span * (e.deltaY > 0 ? 0.15 : -0.15);
      UI.setView[0]({ lo: v.lo + d, hi: v.hi + d });
    } else {
      const r = strip.getBoundingClientRect();
      const c = v.lo + ((e.clientX - r.left) / r.width) * span;
      const f = Math.exp(e.deltaY * 0.0015);
      UI.setView[0]({ lo: c - (c - v.lo) * f, hi: c + (v.hi - c) * f });
    }
    renderLanes();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// Logs view: the run's L records as a terminal — monospace scrollback,
// level-colored, click a line to seek there. Lines after the playhead are
// dimmed ("not printed yet"); follow keeps the newest printed line in view.
// ---------------------------------------------------------------------------

const lgState = { rows: null, splitIdx: -1 };
const LVL_BADGE = { trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };

function buildLogsPanel() {
  const term = $('logs-term');
  const logs = UI.logs || [];
  $('btn-logs').hidden = !logs.length;
  lgState.splitIdx = -1;
  if (!logs.length) {
    term.innerHTML = '<div class="lg-empty">this run has no log records</div>';
    lgState.rows = null;
    return;
  }
  term.innerHTML = logs.map((lg, i) => `
    <div class="lg-row future" data-i="${i}" data-seq="${lg.seq}" title="click: seek to this log">
      <span class="lg-t">${fmtTime(lg.t)}</span>
      <span class="lg-lvl ${lg.lvl}">${LVL_BADGE[lg.lvl] || 'INF'}</span>
      <span class="lg-msg">${esc(lg.msg)}${lg.src ? ` <span class="lg-src">${esc(lg.src)}</span>` : ''}</span>
    </div>`).join('');
  lgState.rows = [...term.querySelectorAll('.lg-row')];
  lgState.rows.forEach((row) => {
    row.onclick = () => worker.postMessage({ type: 'jump', seq: +row.dataset.seq + 1, select: false });
  });
  applyLogsFilter();
  updateLogsPanel(true);
}

function updateLogsPanel(force) {
  if (!lgState.rows || !UI.state || $('logs-panel').hidden) return;
  const logs = UI.logs;
  const cur = UI.state.seq;
  // rows [0, split) are before the playhead ("printed")
  let lo = 0;
  let hi = logs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (logs[mid].seq < cur) lo = mid + 1; else hi = mid;
  }
  const split = lo;
  if (!force && split === lgState.splitIdx) return;
  const prev = lgState.splitIdx;
  const a = force || prev < 0 ? 0 : Math.min(prev, split);
  const b = force || prev < 0 ? lgState.rows.length : Math.max(prev, split);
  for (let i = a; i < b; i++) lgState.rows[i].classList.toggle('future', i >= split);
  lgState.splitIdx = split;
  $('logs-term').querySelector('.lg-row.cur')?.classList.remove('cur');
  if (split > 0) {
    const rowEl = lgState.rows[split - 1];
    rowEl.classList.add('cur');
    if ($('lg-follow').checked) rowEl.scrollIntoView({ block: 'nearest' });
  }
}

function applyLogsFilter() {
  if (!lgState.rows) return;
  const q = $('lg-filter').value.trim().toLowerCase();
  UI.logs.forEach((lg, i) => {
    const show = !q || lg.msg.toLowerCase().includes(q)
      || (lg.src || '').toLowerCase().includes(q) || lg.lvl.includes(q);
    lgState.rows[i].style.display = show ? '' : 'none';
  });
}
$('lg-filter').oninput = applyLogsFilter;
$('lg-follow').onchange = () => updateLogsPanel(true);

// ---------------------------------------------------------------------------
// Active spans view: the span stack open at the playhead, per lane, nested —
// "where is the program right now". Click a row to select the span.
// ---------------------------------------------------------------------------

const activeState = { lastSeq: -1 };

function updateActivePanel(force) {
  if ($('active-panel').hidden || !UI.state || !UI.spans) return;
  const cur = UI.state.seq;
  if (!force && cur === activeState.lastSeq) return;
  activeState.lastSeq = cur;
  const curT = UI.state.t;
  // a span is active once its B is applied and until its E is applied
  const active = UI.spans.filter((sp) =>
    (sp.begin === null || cur > sp.begin) && (sp.end === null || cur <= sp.end));
  const list = $('active-list');
  if (!active.length) {
    list.innerHTML = '<div class="empty">no spans open at the playhead</div>';
    return;
  }
  const byLane = new Map();
  for (const sp of active) {
    const key = sp.thr === null ? 'global' : `thr ${sp.thr}`;
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key).push(sp);
  }
  const keys = [...byLane.keys()].sort((a, b) => {
    if (a === 'global') return -1;
    if (b === 'global') return 1;
    return +a.slice(4) - +b.slice(4);
  });
  let html = '';
  for (const key of keys) {
    html += `<div class="group-title">${esc(key)}</div>`;
    for (const sp of byLane.get(key)) {
      html += `<div class="as-row" data-sp="${sp.i}" style="padding-left:${8 + (sp.depth || 0) * 14}px"
        title="click: select this span">
        <span class="as-dot" style="background:${laneNameColor(sp.name)}"></span>
        <span class="as-name">${esc(sp.name)}</span>
        <span class="as-open">${fmtTime(Math.max(0, curT - sp.t0))}</span>
      </div>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll('.as-row').forEach((row) => {
    row.onclick = () => selectSpan(UI.spans[+row.dataset.sp]);
  });
}

// status-bar dock visibility toggles (windows stay locked in, editor-style)
for (const side of DOCK_SIDES) {
  $(`dock-${side}`).onclick = () => toggleDock(side);
}
