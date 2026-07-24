// The boundary module: it serializes shell state (window geometry, drawer
// layout) *and* heap state (view, crop, filters, playhead) into the one
// per-trace session blob, and reads it back.
//
// Everything it needs from the heap layer arrives through initSession(deps)
// rather than by import — main.js still owns those functions, and injecting
// them keeps the dependency visible instead of hidden in a shared scope. It
// is also what makes the round-trip testable without a browser: a test
// supplies a fake `deps` and a stub DOM.
//
// NOTE: the persisted shape here is deliberately unchanged from the
// pre-split version — same keys, same `heapVisualizerSession: 1` marker.
// Namespacing the heap-owned fields under a domain key with a version is a
// separate change, to be made against these tests rather than alongside the
// move.

import { $ } from './shell/dom.js';
import { applyDrawersState, dockPanelAt } from './shell/drawers.js';
import { normAddr } from './heap/addr.js';

let d = null;

// deps: { ui, post, PANEL_IDS, allocSizeFormat, rowBytesValue, sendCollapseMin,
//         buildLegend, sendAllocSizeFormat, resetEventsPanel, sendXView,
//         buildAddrRangesSection, sendFilter, setCrop, requestAllocInfo,
//         createPinnedWindow, buildMarks, applyMarks }
export function initSession(deps) {
  d = deps;
  scheduleSessionAutosave();
  window.addEventListener('beforeunload', saveSessionNow);
}

export function sessionKey() {
  return d.ui.fileName ? `heapviz:session:${d.ui.fileName}` : null;
}

export function buildSession() {
  const windows = {};
  for (const id of d.PANEL_IDS) {
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
    allocSizeFormat: d.allocSizeFormat(),
    showAll: $('show-all').checked,
    evFiltered: $('ev-filtered').checked,
    sizeLabels: $('show-sizes').checked,
    addrLabels: $('show-addrs').checked,
    xview: d.ui.xview,
    crop: d.ui.crop,
    filter: {
      fmode: fmode ? fmode.value : '1',
      sizeMin: $('f-size-min').value,
      sizeMax: $('f-size-max').value,
      // checkbox states by index — meaningful only against the same trace's
      // site/thread list, which is exactly what the file-name-scoped key gives us
      sites: [...document.querySelectorAll('#filter-panel input[data-site]')].map((b) => b.checked),
      thrs: [...document.querySelectorAll('#filter-panel input[data-thr]')].map((b) => b.checked),
      addrRanges: d.ui.addrRanges,
    },
    playhead: d.ui.state ? d.ui.state.seq : 0,
    windows,
    drawers: d.ui.drawers || null,
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

export function applySession(obj) {
  if (!obj || obj.heapVisualizerSession !== 1) return;
  if (obj.rowBytes !== undefined) {
    $('row-bytes').value = obj.rowBytes;
    const v = d.rowBytesValue();
    if (v > 0) d.post({ type: 'set', key: 'rowBytes', value: v });
  }
  if (obj.collapseMin !== undefined) { $('collapse-min').value = obj.collapseMin; d.sendCollapseMin(); }
  if (obj.rowPx !== undefined) {
    $('row-px').value = obj.rowPx;
    d.post({ type: 'set', key: 'rowPx', value: +$('row-px').value });
  }
  if (obj.colorMode !== undefined) {
    $('color-mode').value = obj.colorMode;
    d.post({ type: 'set', key: 'colorMode', value: +$('color-mode').value });
    d.buildLegend();
  }
  if (obj.allocSizeFormat !== undefined) {
    $('alloc-size-format').value = obj.allocSizeFormat === 'hex' ? 'hex' : 'human';
    d.sendAllocSizeFormat();
  }
  // (a legacy per-trace overlapMode is deliberately ignored here — overlap
  // display is a global preference now, see savePrefs/restorePrefs)
  if (obj.evFiltered !== undefined) {
    $('ev-filtered').checked = !!obj.evFiltered;
    d.resetEventsPanel();
  }
  if (obj.showAll !== undefined) {
    $('show-all').checked = obj.showAll;
    d.post({ type: 'set', key: 'showAll', value: obj.showAll });
  }
  if (obj.sizeLabels !== undefined) {
    $('show-sizes').checked = obj.sizeLabels;
    d.post({ type: 'set', key: 'sizeLabels', value: obj.sizeLabels });
  }
  if (obj.addrLabels !== undefined) {
    $('show-addrs').checked = obj.addrLabels;
    d.post({ type: 'set', key: 'addrLabels', value: obj.addrLabels });
  }
  if (obj.xview) { d.ui.xview = obj.xview; d.sendXView(); }
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
    d.ui.addrRanges = (f.addrRanges || []).filter((r) => normAddr(r.lo) && normAddr(r.hi));
    d.buildAddrRangesSection();
    d.sendFilter();
  }
  if (obj.windows) {
    for (const id of d.PANEL_IDS) {
      const w = obj.windows[id];
      const p = $(id);
      if (!w || !p) continue;
      p.hidden = w.hidden;
      if (w.left) { p.style.left = w.left; p.style.top = w.top; p.style.right = w.right; p.style.bottom = w.bottom; }
    }
  }
  if (obj.crop) d.setCrop(obj.crop.lo, obj.crop.hi);
  if (obj.playhead !== undefined) d.post({ type: 'seek', seq: obj.playhead });
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
    const info = await d.requestAllocInfo(pw.e);
    if (!info) continue; // stale/unknown event (e.g. mismatched trace): skip
    const win = d.createPinnedWindow(info, null);
    win.style.left = pw.left; win.style.top = pw.top; win.style.right = pw.right; win.style.bottom = pw.bottom;
    if (pw.dockSide) dockPanelAt(win, pw.dockSide, null);
  }
}

let lastSessionJson = null;

// a new trace invalidates the "nothing moved since last write" shortcut in
// saveSessionNow — the previous snapshot describes a different trace
export function resetSessionSnapshot() {
  lastSessionJson = null;
}

export function saveSessionNow() {
  const key = sessionKey();
  if (!key || !d.ui.loaded) return;
  try {
    const json = JSON.stringify(buildSession());
    // the periodic autosave fires while idle too; skip the write (and the
    // storage churn) when nothing in the snapshot actually moved
    if (json === lastSessionJson) return;
    lastSessionJson = json;
    localStorage.setItem(key, json);
  } catch { /* storage full/unavailable: silently skip */ }
}

export function marksKey() {
  return d.ui.fileName ? `heapviz:marks:${d.ui.fileName}` : null;
}

// marks (tags/bookmarks/addr marks/names/colors) also auto-persist to
// localStorage alongside the session — the manual Save…/Load… buttons are
// still there for a portable/shareable file, but there's no reason a plain
// refresh should lose work that was never explicitly exported
export async function saveMarksAutosave() {
  const key = marksKey();
  if (!key || !d.ui.loaded) return;
  try {
    localStorage.setItem(key, JSON.stringify(await d.buildMarks()));
  } catch { /* storage full/unavailable: silently skip */ }
}

// returns true when a marks blob was applied (it carries its own session
// snapshot, so the caller must not also run restoreSession — see onLoaded)
export function restoreMarksAutosave() {
  const key = marksKey();
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.heapVisualizerAnalysis !== 1) return false;
    d.applyMarks(obj, true);
    // a pre-session marks blob still needs the standalone session restored
    return !!obj.session;
  } catch { /* corrupt/unavailable: ignore, nothing to restore */ }
  return false;
}

// cheap periodic autosave rather than hooking every single input's change
// event — a full session snapshot is a handful of DOM reads, negligible next
// to render/scroll work, and this keeps every future settable from needing
// to remember to call a save function
let sessionSaveTimer = null;
function scheduleSessionAutosave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setInterval(() => {
    if (!d.ui.loaded) return;
    saveSessionNow();
    if (d.ui.marksDirty) saveMarksAutosave();
  }, 2000);
  // a background autosave should never be the reason a process stays alive.
  // No-op in the browser (setInterval returns a number); under `node --test`
  // it is what lets the run exit instead of hanging on this timer.
  sessionSaveTimer.unref?.();
}

export function restoreSession() {
  const key = sessionKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) applySession(JSON.parse(raw));
  } catch { /* corrupt/unavailable: ignore, defaults stand */ }
}
