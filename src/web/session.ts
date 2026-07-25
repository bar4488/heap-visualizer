// The boundary module: it serializes shell state (window geometry, drawer
// layout) *and* heap state (view, crop, filters, playhead) into the one
// per-trace session blob, and reads it back.
//
// Everything it needs from the heap layer arrives through initSession(deps)
// rather than by import — main.ts still owns those functions, and injecting
// them keeps the dependency visible instead of hidden in a shared scope. It
// is also what makes the round-trip testable without a browser: a test
// supplies a fake `deps` and a stub DOM.
//
// The blob's top level is shell-owned workspace state — panel window geometry
// and drawer layout. Everything whose meaning comes from a heap trace lives
// under the `heap` key, which carries its own `version` so heap state can
// change shape without the shell's envelope moving. Blobs written in the old
// flat shape (every field at the top level, no `heap` key) still read, and
// there is one read path for that one old shape — not a migration framework.

import { $, $$, $1 } from './shell/dom.ts';
import { applyDrawersState, dockPanelAt } from './shell/drawers.ts';

let d = null;

// deps: { ui, post, panels, allocSizeFormat, rowBytesValue, sendCollapseMin,
//         buildLegend, sendAllocSizeFormat, resetEventsPanel, sendXView,
//         applyFilterSource, setCrop, requestAllocInfo,
//         createPinnedWindow, buildMarks, applyMarks }
export function initSession(deps) {
  d = deps;
  scheduleSessionAutosave();
  window.addEventListener('beforeunload', saveSessionNow);
}

export function sessionKey() {
  return d.ui.fileName ? `heapviz:session:${d.ui.fileName}` : null;
}

// the shape version of the `heap` section, bumped when its fields change
// shape in a way a reader must know about
export const HEAP_SESSION_VERSION = 2;

export function buildSession() {
  const windows = {};
  for (const { id } of d.panels) {
    const p = $(id);
    windows[id] = { hidden: p.hidden, left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom };
  }
  return {
    heapVisualizerSession: 1,
    windows,
    drawers: d.ui.drawers || null,
    heap: buildHeapSession(),
  };
}

function buildHeapSession() {
  return {
    version: HEAP_SESSION_VERSION,
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
      languageVersion: 1,
      source: d.ui.filterApplied,
      mode: d.ui.filterMode,
    },
    playhead: d.ui.state ? d.ui.state.seq : 0,
    // pinned allocation windows: re-fetched by creator event index on
    // restore (see applySession), since only the trace — not the info blob
    // itself — is worth persisting
    pinned: $$('.pinned-detail').map((win) => ({
      e: +win.dataset.e,
      dockSide: win.dataset.dockSide || null,
      left: win.style.left, top: win.style.top, right: win.style.right, bottom: win.style.bottom,
    })),
  };
}

// The interleaving below is deliberate: heap settings, then window geometry,
// then crop and playhead, then drawers, then pinned windows. That is the order
// the flat shape was applied in, and docking a drawer resizes the canvas, so
// it must keep happening after the view messages rather than before them.
export function applySession(obj) {
  if (!obj || obj.heapVisualizerSession !== 1) return;
  const h = readHeapSection(obj);
  if (h) applyHeapSettings(h);
  applyWindows(obj);
  if (h) applyHeapView(h);
  applyDrawersState(obj.drawers);
  if (h) restorePinnedWindows(h.pinned);
}

// the heap section, or null when there is none to trust. A blob in the old
// flat shape has no `heap` key and carries the heap fields at the top level —
// returning the envelope itself is the whole of that read path. A `heap`
// section at an unknown version was written by a newer build: skip it rather
// than half-apply fields whose meaning may have moved, and let the shell's own
// layout restore around the heap defaults.
function readHeapSection(obj) {
  if (obj.heap === undefined) return obj;
  if (!obj.heap || obj.heap.version !== HEAP_SESSION_VERSION) return null;
  return obj.heap;
}

function applyWindows(obj) {
  if (!obj.windows) return;
  for (const { id } of d.panels) {
    const w = obj.windows[id];
    const p = $(id);
    if (!w || !p) continue;
    p.hidden = w.hidden;
    if (w.left) { p.style.left = w.left; p.style.top = w.top; p.style.right = w.right; p.style.bottom = w.bottom; }
  }
}

function applyHeapSettings(obj) {
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
    if (f.languageVersion !== 1 || typeof f.source !== 'string') return;
    d.ui.filterMode = f.mode === 2 ? 2 : 1;
    const fr = $1(`input[name=fmode][value="${d.ui.filterMode}"]`);
    if (fr) fr.checked = true;
    d.ui.filterDraft = f.source;
    $('filter-source').value = f.source;
    void d.applyFilterSource(f.source);
  }
}

function applyHeapView(obj) {
  if (obj.crop) d.setCrop(obj.crop.lo, obj.crop.hi);
  if (obj.playhead !== undefined) d.post({ type: 'seek', seq: obj.playhead });
}

// re-fetches each pinned allocation's info by creator event index (the trace
// itself, not the info blob, is what's persisted) and recreates its window,
// docked or floating exactly as saved
async function restorePinnedWindows(pinned) {
  if (!pinned || !pinned.length) return;
  $$('.pinned-detail').forEach((w) => w.remove()); // avoid dupes on repeated restore
  for (const pw of pinned) {
    const info = await d.requestAllocInfo(pw.e);
    if (!info) continue; // stale/unknown event (e.g. mismatched trace): skip
    const win = d.createPinnedWindow(info, null);
    win.style.left = pw.left; win.style.top = pw.top; win.style.right = pw.right; win.style.bottom = pw.bottom;
    if (pw.dockSide) dockPanelAt(win, pw.dockSide, null, false);
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
