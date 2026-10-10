// The boundary module: it serializes shell state (the dock layout: views,
// windows, edge groups, floating windows) *and* heap state (view, crop,
// filters, playhead) into the one per-trace session blob, and reads it back.
//
// Everything it needs from the heap layer arrives through initSession(deps)
// rather than by import — main.ts still owns those functions, and injecting
// them keeps the dependency visible instead of hidden in a shared scope. It
// is also what makes the round-trip testable without a browser: a test
// supplies a fake `deps` and a stub DOM.
//
// The blob's top level is an envelope: workspace state under `shell` (the
// shell's own serialization, with its own `version`), and everything whose
// meaning comes from a heap trace under `heap`, which carries its own
// `version` so heap state can change shape without the envelope moving. Two
// old shapes still read, each through one read path rather than a migration
// framework: the flat shape (every heap field at the top level, no `heap`
// key), and the pre-dock shell (`windows` and `drawers` at the top level),
// which the shell converts into a dock layout.

import { $, $1 } from './shell/dom.ts';
import { layout } from './shell/layout.ts';

let d = null;

// deps: { ui, post, allocSizeFormat, rowBytesValue, sendCollapseMin,
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

// the filter language a persisted source is written in, bumped when a source
// written by an older build would no longer check, so an old source is read
// back as no filter rather than restored broken.
//
// Version 2 renamed the scalar `tag` field to the set-typed `tags` (T016).
// Version 3 is the Python-shaped surface (T042): `and`/`or`/`not`, `in` for
// every membership, `range(lo, hi)`, `is None`, and every field reached
// through `alloc`, `malloc` or `free`. Nothing written before it checks, and
// there is no translator — E019 says why.
export const FILTER_LANGUAGE_VERSION = 4;

// The top level's `shell` is the shell's own serialization (shell/layout.ts)
// — this module puts it in the envelope and hands it back, and does not read
// inside it.
export function buildSession() {
  return {
    heapVisualizerSession: 1,
    shell: layout.serialize(),
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
      languageVersion: FILTER_LANGUAGE_VERSION,
      source: d.ui.filterApplied,
      mode: d.ui.filterMode,
    },
    playhead: d.ui.state ? d.ui.state.seq : 0,
    // pinned allocation windows: re-fetched by creator event index on
    // restore (see applySession), since only the trace — not the info blob
    // itself — is worth persisting. Where each one sits is in the shell's
    // saved dock, under the instance id `pinned-detail:<e>`. (Entries written
    // before the dock also carry `dockSide` and floating `left`/`top`.)
    pinned: layout.instancesOf('pinned-detail').map(({ key }) => ({ e: +key })),
  };
}

// The order below is deliberate: heap settings, then crop and playhead, then
// the layout, then pinned windows. Rearranging the dock resizes the canvases,
// so it must keep happening after the view messages rather than before them.
export function applySession(obj) {
  if (!obj || obj.heapVisualizerSession !== 1) return;
  const h = readHeapSection(obj);
  if (h) applyHeapSettings(h);
  if (h) applyHeapView(h);
  // a blob written before the dock has the shell's `windows` and `drawers`
  // at the top level instead of a `shell` section
  layout.restore(obj.shell ?? { windows: obj.windows, drawers: obj.drawers });
  if (h) restorePinnedWindows(h.pinned);
  else layout.dropPlaceholders();
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
    if (f.languageVersion !== FILTER_LANGUAGE_VERSION || typeof f.source !== 'string') return;
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
// A restore spans one worker round-trip per window, so a newer restore or a
// newly loaded trace can arrive in between; either one ends this one rather
// than letting it recreate windows for events of a trace no longer shown.
let pinnedRestoreGeneration = 0;

// The restored layout already holds a placeholder in each saved pinned
// window's slot; recreating the window fills it, and whatever is left
// unfilled at the end (an event this trace does not have) is dropped. Windows
// pinned now that the session does not list were closed by the restore.
async function restorePinnedWindows(pinned) {
  const generation = ++pinnedRestoreGeneration;
  if (!pinned || !pinned.length) {
    layout.dropPlaceholders();
    return;
  }
  const meta = d.ui.meta;
  for (const pw of pinned) {
    const info = await d.requestAllocInfo(pw.e);
    if (generation !== pinnedRestoreGeneration || d.ui.meta !== meta || !d.ui.loaded) return;
    if (!info) continue; // stale/unknown event (e.g. mismatched trace): skip
    d.createPinnedWindow(info, {
      at: pw.left ? { left: pw.left, top: pw.top } : undefined,
      dock: pw.dockSide === 'left' || pw.dockSide === 'right' ? pw.dockSide : undefined,
      restoring: true,
    });
  }
  layout.dropPlaceholders();
}

let lastSessionJson = null;

// a new trace invalidates the "nothing moved since last write" shortcut in
// saveSessionNow — the previous snapshot describes a different trace
export function resetSessionSnapshot() {
  lastSessionJson = null;
  pinnedRestoreGeneration++;
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
  if (d.isServerAnalysis?.()) return;
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
    // The blob's session snapshot is as old as the last marks change; the
    // session's own key is written every two seconds and on unload. The newer
    // one is applied (once: applyMarks applies the session it is given), or
    // a window moved after the last rename would come back where it was.
    let session = obj.session;
    try {
      const own = sessionKey() ? localStorage.getItem(sessionKey()) : null;
      if (own) session = JSON.parse(own);
    } catch { /* corrupt: the blob's own snapshot stands */ }
    d.applyMarks({ ...obj, session }, true);
    // a pre-session marks blob still needs the standalone session restored
    return !!session;
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
