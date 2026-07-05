// heap-visualizer main thread: DOM chrome and input. All heavy lifting (parse, seek,
// raster) happens in the worker; this file forwards input and paints overlays.

const $ = (id) => document.getElementById(id);

const CAT = ['#58a6ff', '#3fb950', '#f2cc60', '#ff7b72', '#bc8cff', '#39c5cf',
  '#f778ba', '#d29922', '#7ee787', '#ffa657', '#79c0ff', '#d2a8ff'];
const RAMP = ['#0e4429', '#006d32', '#26a641', '#39d353'];
const OPS = ['malloc', 'free', 'realloc'];

const dpr = window.devicePixelRatio || 1;

const worker = new Worker('worker.js', { type: 'module' });

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
    $('st-trace').textContent = `failed to load ${url}: ${e.message}`;
  }
}

// Route an incoming file: a saved analysis (single JSON object with the
// heapVisualizerAnalysis marker) or a trace stream.
async function handleFile(f) {
  const head = await f.slice(0, 300).text();
  if (head.includes('"heapVisualizerAnalysis"')) {
    try {
      applyAnalysis(JSON.parse(await f.text()));
    } catch (e) {
      $('st-trace').textContent = `analysis load failed: ${e.message}`;
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
        $('st-info').textContent =
          `${OPS[e.op]} id=${e.id} ${e.addr} ${fmtBytes(e.size)}${e.site ? ' · ' + e.site : ''}`;
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
    case 'flash-rects':
      flashRects(m.rects);
      break;
    case 'pick-result':
      onPickResult(m);
      break;
    case 'addr-at':
      if (m.addr) addAddrMark(m.addr);
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
  sendAddrMarks();
  sendNames();
  // the wasm view is recreated per trace: re-apply sticky toolbar prefs
  worker.postMessage({ type: 'set', key: 'showAll', value: $('show-all').checked });
  worker.postMessage({ type: 'set', key: 'sizeLabels', value: $('show-sizes').checked });
  clearSelection();
  syncTagDatalist();
  buildAnalysisPanel();
  updateMarkers();
  $('btn-analysis').hidden = false;
  $('btn-analysis').classList.remove('active');
  $('btn-mark').hidden = false;
  $('btn-events').hidden = false;
  $('btn-play').disabled = false;
  UI.xview = { zoom: 1, pan: 0 };
  updateHzButton();
  resetEventsPanel();
  $('trace-title').textContent = m.meta.title || UI.fileName || '';
  $('st-trace').textContent =
    `${UI.fileName || ''} · ${fmtNum(m.n)} events (M ${fmtNum(m.meta.nMalloc)} / F ${fmtNum(m.meta.nFree)} / R ${fmtNum(m.meta.nRealloc)})` +
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
  document.querySelectorAll('.pinned-detail').forEach((w) => w.remove());
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
  updateMarkers();
  lastAddrMarkYs = m.addrMarkYs || [];
  renderAddrMarkLines();
  updateEventsPanel();
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

function doJump() {
  const v = $('jump-input').value.trim();
  if (!v) return;
  const addrText = v.startsWith('a:') ? v.slice(2).trim() : v;
  if (/^0x[0-9a-f]+$/i.test(addrText)) {
    // go to address: scroll the address-line, playhead untouched
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
    $('jump-input').focus();
    $('jump-input').select();
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
  $('filter-panel').querySelectorAll('input').forEach((inp) => { inp.onchange = sendFilter; });
  $('filter-panel').querySelectorAll('.allnone a').forEach((a) => {
    a.onclick = () => {
      const on = a.dataset.an === 'all';
      $('filter-panel').querySelectorAll(`input[data-${a.dataset.sel}]`)
        .forEach((b) => { b.checked = on; });
      sendFilter();
    };
  });
  $('f-size-min').oninput = sendFilter;
  $('f-size-max').oninput = sendFilter;
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
  $('btn-analysis').classList.toggle('active', !allTags);
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

let panelZ = 40;

function raisePanel(p) {
  p.style.zIndex = ++panelZ;
}

function showPanel(id) {
  const p = $(id);
  p.hidden = false;
  raisePanel(p);
}

function makePanelWindow(p) {
  // any interaction with a window brings it to the front
  p.addEventListener('pointerdown', () => raisePanel(p));
  const head = p.querySelector('.panel-head');
  head.addEventListener('pointerdown', (e) => {
    // header buttons/inputs (close, save, follow…) still work normally
    if (e.target.closest('button, input, select, a')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const r = p.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      p.style.left = `${Math.min(innerWidth - 60, Math.max(4 - r.width + 60, ev.clientX - dx))}px`;
      p.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}
document.querySelectorAll('.panel').forEach(makePanelWindow);

// panel open/close plumbing
for (const [btn, panel] of [
  ['btn-playcfg', 'play-panel'],
  ['btn-layout', 'layout-panel'],
  ['btn-filter', 'filter-panel'],
  ['btn-analysis', 'analysis-panel'],
  ['btn-warnings', 'warnings-panel'],
]) {
  $(btn).onclick = () => {
    const p = $(panel);
    p.hidden = !p.hidden;
    if (!p.hidden) raisePanel(p);
  };
}
document.querySelectorAll('.panel-close').forEach((b) => {
  b.onclick = () => { $(b.dataset.close).hidden = true; };
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
}

function onEventsSlice(m) {
  if (m.reqId !== evState.reqId) return;
  const curSeq = UI.state ? UI.state.seq - 1 : -1;
  $('events-rows').innerHTML = m.events.map((ev) => `
    <div class="ev-row${ev.seq === curSeq ? ' cur' : ''}" data-seq="${ev.seq}" title="click: seek here and select the allocation">
      <span class="ev-seq">${fmtNum(ev.seq)}</span>
      <span class="ev-op ${['m', 'f', 'r'][ev.op]}">${['M', 'F', 'R'][ev.op]}</span>
      <span class="ev-addr">${ev.addr}</span>
      <span class="ev-size">${fmtBytes(ev.size)}</span>
      <span class="ev-site">${ev.site ? esc(ev.site) : ''}</span>
    </div>`).join('');
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

function resetEventsPanel() {
  evState.lastSeq = -1;
  $('events-scroll').scrollTop = 0;
  $('events-rows').innerHTML = '';
  if (!$('events-panel').hidden) refreshEventsPanel();
}

$('events-scroll').addEventListener('scroll', refreshEventsPanel);
new ResizeObserver(() => refreshEventsPanel()).observe($('events-scroll'));
$('btn-events').onclick = () => {
  const p = $('events-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) {
    raisePanel(p);
    evState.lastSeq = -1;
    refreshEventsPanel();
    updateEventsPanel();
  }
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

function buildAnalysisPanel() {
  buildBookmarksSection();
  buildAddrMarksSection();
  buildTagsSection();
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
    };
  });
  list.querySelectorAll('input[data-tagcolor]').forEach((inp) => {
    inp.oninput = () => {
      UI.tags[+inp.dataset.tagcolor - 1].color = inp.value;
      sendTagColors();
      buildLegend();
    };
  });
  list.querySelectorAll('input[data-tagname]').forEach((inp) => {
    inp.onchange = () => {
      const v = inp.value.trim();
      if (v) UI.tags[+inp.dataset.tagname - 1].name = v;
      syncTagDatalist();
      buildLegend();
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
  };
});

function deleteTag(id) {
  worker.postMessage({ type: 'retag', from: id, to: 0 });
  for (let k = id + 1; k <= UI.tags.length; k++) {
    worker.postMessage({ type: 'retag', from: k, to: k - 1 });
  }
  UI.tags.splice(id - 1, 1);
  syncTagDatalist();
  sendTagColors();
  sendFilter();
  buildLegend();
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
      <span class="pos" data-ngo="${e}" title="select and jump to birth">id ${v.id} · ${v.addr}</span>
      <button class="x" data-ndel="${e}">×</button>
    </div>`).join('');
  list.querySelectorAll('[data-ncolor]').forEach((inp) => {
    inp.oninput = () => {
      const e = +inp.dataset.ncolor;
      UI.allocColors.set(e, inp.value);
      worker.postMessage({ type: 'alloc-color', e, rgb: parseInt(inp.value.slice(1), 16) });
    };
  });
  list.querySelectorAll('[data-nname]').forEach((inp) => {
    inp.onchange = () => {
      const e = +inp.dataset.nname;
      const v = inp.value.trim();
      if (v) UI.names.get(e).name = v;
      else { UI.names.delete(e); buildNamesSection(); }
      sendNames();
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
  $('st-info').textContent = `marked ${addrHex} — rename it in the Analysis panel`;
  showPanel('analysis-panel');
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
    };
  });
  list.querySelectorAll('[data-amgo]').forEach((el) => {
    el.onclick = () => gotoAddr(UI.addrMarks[+el.dataset.amgo].addr);
  });
  list.querySelectorAll('[data-amdel]').forEach((el) => {
    el.onclick = () => {
      UI.addrMarks.splice(+el.dataset.amdel, 1);
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
  $('st-info').textContent = `bookmarked seq ${fmtNum(b.seq)} · ${fmtTime(b.t)} — rename it in the Analysis panel`;
  showPanel('analysis-panel');
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

const dumpWaiters = new Map();

function requestTagsDump() {
  return new Promise((resolve) => {
    const reqId = UI.reqId++;
    dumpWaiters.set(reqId, resolve);
    worker.postMessage({ type: 'tags-dump', reqId });
  });
}

async function buildAnalysis() {
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
    names: [...UI.names.entries()].map(([e, v]) => ({ e, name: v.name, id: v.id, addr: v.addr })),
    allocColors: [...UI.allocColors.entries()],
    bookmarks: UI.bookmarks,
    addrMarks: UI.addrMarks,
  };
}

async function saveAnalysis() {
  if (!UI.loaded) return;
  const obj = await buildAnalysis();
  const base = (UI.fileName || 'trace').replace(/\.(heapl|jsonl|json|txt)$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  a.download = `${base}.heapa.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('st-info').textContent = `analysis saved to ${a.download}`;
}

function applyAnalysis(obj) {
  if (!obj || obj.heapVisualizerAnalysis !== 1) {
    $('st-trace').textContent = 'not a heap-visualizer analysis file';
    return;
  }
  if (!UI.loaded) {
    $('st-trace').textContent = 'load the matching trace first, then load the analysis';
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
  UI.names = new Map((obj.names || []).map((r) => [r.e, { name: r.name, id: r.id, addr: r.addr }]));
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
  buildAnalysisPanel();
  buildLegend();
  updateMarkers();
  showPanel('analysis-panel');
  $('st-info').textContent =
    `analysis loaded: ${UI.tags.length} tags, ${UI.names.size} names, ${UI.bookmarks.length} time marks, ${UI.addrMarks.length} addr marks`;
}

UI.buildAnalysis = buildAnalysis;
UI.applyAnalysis = applyAnalysis;

$('an-save').onclick = saveAnalysis;
$('an-load').onclick = () => $('analysis-file').click();
$('analysis-file').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (f) {
    try {
      applyAnalysis(JSON.parse(await f.text()));
    } catch (e) {
      $('st-trace').textContent = `analysis load failed: ${e.message}`;
    }
  }
  ev.target.value = '';
};

function clearSelection() {
  UI.sel = null;
  $('sel-popover').hidden = true;
  document.querySelectorAll('.tl-select').forEach((el) => { el.hidden = true; });
}

function updateSelOverlay() {
  if (!UI.sel) return;
  const strip = $(UI.sel.kind === 0 ? 'strip-t' : 'strip-s');
  const el = strip.querySelector('.tl-select');
  const v = UI.sel.kind === 0 ? UI.tlT : UI.tlS;
  const w = strip.clientWidth;
  const x0 = ((UI.sel.lo - v.lo) / (v.hi - v.lo)) * w;
  const x1 = ((UI.sel.hi - v.lo) / (v.hi - v.lo)) * w;
  el.style.left = `${Math.max(0, x0)}px`;
  el.style.width = `${Math.max(0, Math.min(w, x1) - Math.max(0, x0))}px`;
  el.hidden = x1 < 0 || x0 > w;
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
  const setView = (raw) => {
    if (!UI.meta) return;
    const v = kind === 0
      ? clampView(raw, UI.meta.tMin, Math.max(UI.meta.tMax, UI.meta.tMin + 1), 1e-9)
      : clampView(raw, 0, Math.max(UI.meta.n, 1), 4);
    if (kind === 0) UI.tlT = v; else UI.tlS = v;
    UI.tlLocalAt = performance.now();
    worker.postMessage({ type: 'tlview', kind, lo: v.lo, hi: v.hi });
    updateSelOverlay();
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
      `<b>${name ? `“${esc(name)}”  ` : ''}id ${info.id}</b>${info.site ? `  <span style="color:${CAT[(info.siteIdx ?? 0) % 12]}">${esc(info.site)}</span>` : ''}${tag ? `  <span style="color:${tag.color}">⬤ ${esc(tag.name)}</span>` : ''}`,
      `${info.addr} – ${info.end}  <span class="g">${fmtBytes(info.size)}</span>${info.usable ? ` <span class="dim">(usable ${fmtBytes(info.usable)})</span>` : ''}`,
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
    ['id', info.id],
    ['range', `${info.addr} – ${info.end}`],
    ['size', `${fmtBytes(info.size)} (${fmtNum(info.size)} B)`],
    info.usable ? ['usable', fmtBytes(info.usable)] : null,
    ['site', info.site ?? '—'],
    ['thread', info.thr ?? '—'],
    ['born', `seq ${fmtNum(info.seq)} · t ${fmtTime(info.t)}`],
    ['dies', info.deathSeq !== null ? `seq ${fmtNum(info.deathSeq)} · t ${fmtTime(info.deathT)}` : 'never (leak?)'],
  ].filter(Boolean);
  let html = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${esc(String(v))}</span></div>`).join('');
  if (info.stack) {
    html += `<div class="row"><span class="k">stack</span><span>${esc(info.stack)}</span></div>`;
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
    if (v) UI.names.set(info.e, { name: v, id: info.id, addr: info.addr });
    else UI.names.delete(info.e);
    buildNamesSection();
    sendNames();
    // keep the enclosing window's title in sync with the name
    const t = root.closest('.panel')?.querySelector('.ph-t');
    if (t) t.textContent = detailTitle(info);
  };
  q('.d-tag-apply').onclick = () => {
    const id = tagIdFor(q('.d-tag').value);
    worker.postMessage({ type: 'tag-event', e: info.e, tag: id });
    info.tag = id;
    buildLegend();
  };
  const curColor = UI.allocColors.get(info.e);
  if (curColor) q('.d-color').value = curColor;
  q('.d-color').oninput = () => {
    UI.allocColors.set(info.e, q('.d-color').value);
    worker.postMessage({ type: 'alloc-color', e: info.e, rgb: parseInt(q('.d-color').value.slice(1), 16) });
    buildNamesSection();
  };
  q('.d-color-clear').onclick = () => {
    UI.allocColors.delete(info.e);
    worker.postMessage({ type: 'alloc-color', e: info.e, rgb: null });
    buildNamesSection();
  };
}

function detailTitle(info) {
  const name = UI.names.get(info.e)?.name;
  return name ? `Allocation · ${name}` : 'Allocation';
}

// When the live panel (re)opens, start from its default bottom-left spot and
// cascade up-right past any pinned windows sitting there, so a fresh window
// never lands on top of an existing one.
function placeLivePanel(panel) {
  panel.style.left = '';
  panel.style.top = '';
  panel.style.right = '';
  panel.style.bottom = '';
  const r = panel.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  const pins = [...document.querySelectorAll('.pinned-detail')].map((w) => w.getBoundingClientRect());
  const clash = () => pins.some((p) => Math.abs(p.left - x) < 48 && Math.abs(p.top - y) < 48);
  let moved = false;
  while (clash() && y > 40) {
    x += 28;
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
  UI.detailInfo = info;
  panel.querySelector('.ph-t').textContent = detailTitle(info);
  buildDetailBody($('detail-body'), info);
  const wasHidden = panel.hidden;
  panel.hidden = false;
  if (wasHidden) placeLivePanel(panel);
  raisePanel(panel);
}

// Pin the current allocation window: it stays exactly where it is (as a
// pinned window, orange pin), and the next selection opens a fresh live
// Allocation panel. Clicking a pinned window's pin returns it to the live
// panel; × closes it. Any number of windows can be pinned.
$('d-pin').onclick = () => {
  const info = UI.detailInfo;
  if (!info) return;
  const live = $('detail-panel');
  const r = live.getBoundingClientRect();
  // identical chrome to the live panel — the orange pin is the only tell
  const win = document.createElement('div');
  win.className = 'panel pinned-detail';
  win.innerHTML = `<div class="panel-head"><span class="ph-t">${esc(detailTitle(info))}</span>
      <span class="head-actions">
        <button class="d-pin pinned" title="Unpin — return this to the live Allocation panel">📌</button>
        <button class="panel-close">×</button>
      </span></div>
    <div class="panel-body detail-body"></div>`;
  document.body.appendChild(win);
  buildDetailBody(win.querySelector('.panel-body'), info);
  // take over the live panel's exact spot: visually the window just stays
  win.style.left = `${r.left}px`;
  win.style.top = `${r.top}px`;
  win.style.right = 'auto';
  win.style.bottom = 'auto';
  win.querySelector('.panel-close').onclick = () => win.remove();
  win.querySelector('.d-pin').onclick = () => {
    const rr = win.getBoundingClientRect();
    win.remove();
    fillDetailPanel(info);
    live.style.left = `${rr.left}px`;
    live.style.top = `${rr.top}px`;
    live.style.right = 'auto';
    live.style.bottom = 'auto';
  };
  makePanelWindow(win);
  raisePanel(win);
  live.hidden = true;
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
