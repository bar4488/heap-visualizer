// Heap domain: the user-authored analysis layer — tags, allocation names and
// colors, time marks (bookmarks), address marks and saved filters — plus the `.heapa` file
// these are saved to and loaded from.
//
// This is durable, user-authored data, distinct from the transient view state
// in session.ts and from the shell's workspace state. The `.heapa` blob folds
// a session snapshot in, so the one manually-exported file is a complete
// picture rather than just the marks.
//
// What it needs from main.ts arrives through initAnalysis(deps): the worker
// send, the shared UI state, and the handful of render/refresh functions that
// still live there.

import { $, $$, setHtml, delegate } from '../shell/dom.ts';
import { showPanel } from '../shell/panels.ts';
import { esc, fmtNum } from '../fmt.ts';
import { request } from '../rpc.ts';
import { buildSession, applySession } from '../session.ts';
import { changeAnalysis, persistentId, readAnalysis, replaceStandaloneAnalysis, type AnalysisDocument } from '../analysis-port.ts';

let d = null;
let canonical: AnalysisDocument | null = null;
let changeQueue: Promise<AnalysisDocument | null> = Promise.resolve(null);

// deps: { ui, post, CAT, DEFAULT_ROW_BYTES, fmtTime, buildLegend, buildFilterPanel,
//         sendNames, rowBytesValue, setRowBytesInput, sendCollapseMin }
export function initAnalysis(deps) {
  d = deps;
  wireAnalysisPanel();
}

export async function loadCanonicalAnalysis() {
  canonical = await readAnalysis();
  projectCanonicalAnalysis();
}

export async function seedStandaloneAnalysis() {
  const tagged = await requestTagsDump();
  const tags = Object.fromEntries(d.ui.tags.map((tag, index) => {
    tag.id ||= `tag-${index + 1}`;
    return [tag.id, { name: tag.name, color: tag.color }];
  }));
  const allocations = {};
  for (const [creator, value] of d.ui.names) allocations[creator] = { ...(allocations[creator] || {}), name: value.name };
  for (const [creator, color] of d.ui.allocColors) allocations[creator] = { ...(allocations[creator] || {}), color };
  for (const [numeric, creators] of Object.entries(tagged)) {
    const id = d.ui.tags[+numeric - 1]?.id;
    if (!id) continue;
    for (const creator of creators) {
      const value = allocations[creator] ||= {};
      (value.tags ||= []).push(id);
    }
  }
  const withIds = (values, prefix) => Object.fromEntries(values.map((value, index) => {
    value.id ||= `${prefix}-${index + 1}`;
    const { id, ...rest } = value;
    return [id, rest];
  }));
  canonical = await replaceStandaloneAnalysis({
    version: 1,
    revision: 0,
    allocations,
    tags,
    bookmarks: withIds(d.ui.bookmarks, 'bookmark'),
    addressMarks: withIds(d.ui.addrMarks, 'address'),
    savedFilters: withIds(d.ui.savedFilters, 'filter'),
  });
  projectCanonicalAnalysis();
}

export function commitCanonicalAnalysis(change) {
  const run = async () => {
    if (!canonical) canonical = await readAnalysis();
    canonical = await changeAnalysis(canonical, change);
    projectCanonicalAnalysis();
    markDirty();
    return canonical;
  };
  changeQueue = changeQueue.then(run, run);
  return changeQueue;
}

function commit(change) {
  void commitCanonicalAnalysis(change).catch((error) => {
    $('st-info').textContent = `analysis change failed: ${(error as Error).message}`;
  });
}

export function tagPersistentId(id) { return d.ui.tags[id - 1]?.id || null; }

export async function commitTagMembers(id) {
  const tag = d.ui.tags[id - 1];
  if (!tag) return;
  const tagged = await requestTagsDump();
  await commitCanonicalAnalysis({ type: 'replaceTagMembers', tagId: tag.id, creators: tagged[String(id)] || [] });
}

export async function replaceAllocationTags(creator, numericIds) {
  const tagIds = numericIds.map(tagPersistentId).filter(Boolean);
  await commitCanonicalAnalysis({ type: 'replaceAllocationTags', creator, tagIds });
}

function projectCanonicalAnalysis() {
  if (!canonical) return;
  d.ui.tags = Object.entries(canonical.tags).map(([id, tag]) => ({ id, ...tag }));
  const previousNames = d.ui.names;
  d.ui.names = new Map();
  d.ui.allocColors = new Map();
  for (const [creator, value] of Object.entries(canonical.allocations)) {
    const e = +creator;
    if (value.name) {
      const previous = previousNames.get(e);
      d.ui.names.set(e, { name: value.name, id: previous?.id ?? e, addr: previous?.addr ?? '' });
    }
    if (value.color) d.ui.allocColors.set(e, value.color);
  }
  d.ui.bookmarks = Object.entries(canonical.bookmarks).map(([id, value]) => ({ id, ...value }));
  d.ui.addrMarks = Object.entries(canonical.addressMarks).map(([id, value]) => ({ id, ...value }));
  d.ui.savedFilters = Object.entries(canonical.savedFilters).map(([id, value]) => ({ id, ...value }));
  sendAddrMarks();
  syncTagDatalist();
  buildMarksPanel();
  d.buildFilterPanel();
  d.buildLegend();
  updateMarkers();
}

// tracks whether marks changed since the last save/load/autosave — drives
// the periodic marks autosave, not a refresh warning: marks (like
// session/layout state) now auto-persist to localStorage, so there's nothing
// a plain refresh can actually lose
export function markDirty() { d.ui.marksDirty = true; }

export function normalizeSavedFilters(value) {
  if (!Array.isArray(value)) return [];
  const byName = new Map();
  for (const entry of value) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.source !== 'string') continue;
    const name = entry.name.trim();
    if (name) byName.set(name, { name, source: entry.source });
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export async function tagIdFor(name) {
  name = name.trim();
  if (!name) return 0;
  let i = d.ui.tags.findIndex((t) => t.name === name);
  if (i === -1) {
    const color = d.CAT[d.ui.tags.length % 12];
    await commitCanonicalAnalysis({ type: 'putTag', id: persistentId('tag'), name, color });
    i = d.ui.tags.findIndex((t) => t.name === name);
  }
  return i + 1;
}

export function syncTagDatalist() {
  $$('datalist.tag-names, #tag-names').forEach((dl) => {
    dl.innerHTML = d.ui.tags.map((t) => `<option value="${esc(t.name)}">`).join('');
  });
}

export function sendTagColors() {
  d.post({
    type: 'tag-colors',
    colors: d.ui.tags.map((t) => parseInt(t.color.slice(1), 16)),
  });
  d.post({ type: 'tag-labels', labels: d.ui.tags.map((t) => t.name) });
}

export function buildMarksPanel() {
  buildBookmarksSection();
  buildAddrMarksSection();
  buildNamesSection();
}

export function buildBookmarksSection() {
  const list = $('an-bookmarks');
  if (!d.ui.bookmarks.length) {
    setHtml(list, '<div class="empty">none — press “＋ mark” (or m) to bookmark the current position</div>');
    return;
  }
  setHtml(list, d.ui.bookmarks.map((b, i) => `<div class="an-row">
      <input type="text" class="grow" data-bmname="${i}" value="${esc(b.name)}">
      <span class="pos" data-bmgo="${i}" title="jump in time — the address view stays where it is">seq ${fmtNum(b.seq)} · ${d.fmtTime(b.t)}</span>
      <button class="x" data-bmloc="${i}" title="jump in time and center where that event happened">⌖</button>
      <button class="x" data-bmdel="${i}">×</button>
    </div>`).join(''));
}

export function buildTagsSection() {
  const list = $('tags-list');
  if (!d.ui.tags.length) {
    setHtml(list, '<div class="empty">none — shift-drag a range on a timeline, or tag an allocation from its panel</div>');
    return;
  }
  let html = d.ui.tags.map((t, i) => `<div class="an-row">
      <input type="color" data-tagcolor="${i + 1}" value="${t.color}">
      <input type="text" class="grow" data-tagname="${i + 1}" value="${esc(t.name)}">
      <span class="count">${fmtNum(d.ui.tagCounts[i + 1] || 0)}</span>
      <button class="x" data-tagdel="${i + 1}" title="delete tag (untags its allocations)">×</button>
    </div>`).join('');
  setHtml(list, html);
}

export function deleteTag(id) {
  const tag = d.ui.tags[id - 1];
  return tag ? commitCanonicalAnalysis({ type: 'deleteTag', id: tag.id }) : Promise.resolve(canonical);
}

// ---------------------------------------------------------------------------
// names & per-allocation colors
// ---------------------------------------------------------------------------

export function buildNamesSection() {
  const list = $('an-names');
  const entries = [...d.ui.names.entries()];
  if (!entries.length) {
    setHtml(list, '<div class="empty">none — click an allocation and name it in its panel</div>');
    return;
  }
  setHtml(list, entries.map(([e, v]) => `<div class="an-row">
      <input type="color" data-ncolor="${e}" value="${d.ui.allocColors.get(e) || '#3fb950'}" title="highlight color">
      <input type="text" class="grow" data-nname="${e}" value="${esc(v.name)}">
      <span class="pos" data-ngo="${e}" title="select and jump to birth">id ${v.id} · ${v.addr}</span>
      <button class="x" data-ndel="${e}">×</button>
    </div>`).join(''));
}

// ---------------------------------------------------------------------------
// address marks
// ---------------------------------------------------------------------------

export function sendAddrMarks() {
  d.post({
    type: 'addr-marks',
    marks: d.ui.addrMarks.map((m) => {
      const a = BigInt(m.addr);
      return { lo: Number(a & 0xffffffffn), hi: Number((a >> 32n) & 0xffffffffn) };
    }),
  });
}

export function gotoAddr(addrHex) {
  const a = BigInt(addrHex);
  d.post({
    type: 'goto-addr',
    lo: Number(a & 0xffffffffn),
    hi: Number((a >> 32n) & 0xffffffffn),
  });
}

export function addAddrMark(addrHex) {
  commit({ type: 'putAddressMark', id: persistentId('address'), name: `addr ${d.ui.addrMarks.length + 1}`, addr: addrHex });
  $('st-info').textContent = `marked ${addrHex} — rename it in the Marks panel`;
  showPanel('analysis-panel');
  markDirty();
}

export function buildAddrMarksSection() {
  const list = $('an-addrmarks');
  if (!d.ui.addrMarks.length) {
    setHtml(list, '<div class="empty">none — shift-click the address map to mark an address</div>');
    return;
  }
  setHtml(list, d.ui.addrMarks.map((m, i) => `<div class="an-row">
      <input type="text" class="grow" data-amname="${i}" value="${esc(m.name)}">
      <span class="pos" data-amgo="${i}" title="center on this address">${esc(m.addr)}</span>
      <button class="x" data-amdel="${i}">×</button>
    </div>`).join(''));
}

// screen-space y of each address mark, reported by the worker with each frame
let lastAddrMarkYs = [];

export function setAddrMarkYs(ys) {
  lastAddrMarkYs = ys;
}

export function renderAddrMarkLines() {
  const box = $('addr-mark-lines');
  const html = d.ui.addrMarks.map((m, i) => {
    const y = lastAddrMarkYs[i];
    if (y === null || y === undefined) return '';
    return `<div class="amark" style="top:${y}px" data-am="${i}" data-label="⚑ ${esc(m.name)} ${esc(m.addr)}"></div>`;
  }).join('');
  setHtml(box, html);
}

// ---------------------------------------------------------------------------
// time marks (bookmarks)
// ---------------------------------------------------------------------------

export function addBookmark() {
  if (!d.ui.state) return;
  const b = { name: `mark ${d.ui.bookmarks.length + 1}`, seq: d.ui.state.seq, t: d.ui.state.t };
  commit({ type: 'putBookmark', id: persistentId('bookmark'), ...b });
  $('st-info').textContent = `bookmarked seq ${fmtNum(b.seq)} · ${d.fmtTime(b.t)} — rename it in the Marks panel`;
  showPanel('analysis-panel');
  markDirty();
}

export function updateMarkers() {
  for (const [stripId, kind] of [['strip-t', 0], ['strip-s', 1]] as [string, number][]) {
    const strip = $(stripId);
    const marks = strip.querySelector('.tl-marks');
    const v = kind === 0 ? d.ui.tlT : d.ui.tlS;
    const w = strip.clientWidth;
    const html = d.ui.bookmarks.map((b, i) => {
      const val = kind === 0 ? b.t : b.seq;
      const x = ((val - v.lo) / (v.hi - v.lo)) * w;
      if (x < 0 || x > w) return '';
      return `<div class="mark" style="left:${x}px" data-bm="${i}" data-label="⚑ ${esc(b.name)}" title="${esc(b.name)} — click: jump in time · shift+click: also center the place"></div>`;
    }).join('');
    if (!setHtml(marks, html)) continue;
    $$('.mark', marks).forEach((el) => {
      // plain click: time only (stay at the same address); shift+click: also
      // center where the event happened
      el.onclick = (ev) => d.post({
        type: ev.shiftKey ? 'jump' : 'seek',
        seq: d.ui.bookmarks[+el.dataset.bm].seq,
      });
    });
  }
}

// ---------------------------------------------------------------------------
// analysis save / load (`.heapa`)
// ---------------------------------------------------------------------------

// fetch alloc_info for a creator event directly (not via pixel pick) — used
// to recreate pinned allocation windows from a saved session
export function requestAllocInfo(e) {
  return request('alloc-info', { e }).then((m) => m.info);
}

function requestTagsDump() {
  return request('tags-dump').then((m) => m.tags);
}

export async function buildMarks() {
  const taggedEvents = await requestTagsDump();
  return {
    heapVisualizerAnalysis: 1,
    saved: new Date().toISOString(),
    trace: {
      file: d.ui.fileName || null,
      title: d.ui.meta.title,
      n: d.ui.meta.n,
      tMin: d.ui.meta.tMin,
      tMax: d.ui.meta.tMax,
    },
    playhead: d.ui.state ? d.ui.state.seq : 0,
    rowBytes: d.rowBytesValue() || d.DEFAULT_ROW_BYTES,
    collapseMin: $('collapse-min').value.trim(),
    colorMode: +$('color-mode').value,
    tags: d.ui.tags.map((t) => ({ name: t.name, color: t.color })),
    taggedEvents,
    names: [...d.ui.names.entries()].map(([e, v]) => ({ e, name: v.name, id: v.id, addr: v.addr })),
    allocColors: [...d.ui.allocColors.entries()],
    bookmarks: d.ui.bookmarks,
    addrMarks: d.ui.addrMarks,
    savedFilters: d.ui.savedFilters,
    // layout/filters/crop/drawers/window positions — folded in so the one
    // manually-exported file is a complete snapshot, not just the "marks"
    session: buildSession(),
  };
}

export async function saveMarks() {
  if (!d.ui.loaded) return;
  const obj = await buildMarks();
  const base = (d.ui.fileName || 'trace').replace(/\.(heapl|jsonl|json|txt)$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  a.download = `${base}.heapa.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('st-info').textContent = `marks saved to ${a.download}`;
  d.ui.marksDirty = false;
}

// `quiet` suppresses the "not a marks file" message: the autosave restore
// path calls this with whatever localStorage holds and expects a silent no.
export function applyMarks(obj, quiet?) {
  if (!obj || obj.heapVisualizerAnalysis !== 1) {
    if (!quiet) $('st-trace').textContent = 'not a heap-visualizer marks file';
    return;
  }
  if (!d.ui.loaded) {
    $('st-trace').textContent = 'load the matching trace first, then load the marks';
    return;
  }
  if (obj.trace && obj.trace.n !== d.ui.meta.n) {
    $('st-info').textContent =
      `⚠ analysis was saved for a trace with ${fmtNum(obj.trace.n)} events (this one has ${fmtNum(d.ui.meta.n)}) — applying anyway`;
  }
  // clear existing per-alloc colors, then rebuild everything from the file
  for (const e of d.ui.allocColors.keys()) {
    d.post({ type: 'alloc-color', e, rgb: null });
  }
  d.post({ type: 'tags-clear' });
  d.ui.tags = (obj.tags || []).map((t, i) => ({
    name: t.name || `tag ${i + 1}`,
    color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : d.CAT[i % 12],
  }));
  sendTagColors();
  for (const [tagStr, events] of Object.entries(obj.taggedEvents || {})) {
    const tag = +tagStr;
    if (tag >= 1 && tag <= d.ui.tags.length && Array.isArray(events)) {
      d.post({ type: 'tag-events', tag, events });
    }
  }
  d.ui.names = new Map((obj.names || []).map((r) => [r.e, { name: r.name, id: r.id, addr: r.addr }]));
  d.sendNames();
  d.ui.allocColors = new Map((obj.allocColors || []).filter(([, c]) => /^#[0-9a-f]{6}$/i.test(c)));
  for (const [e, c] of d.ui.allocColors) {
    d.post({ type: 'alloc-color', e, rgb: parseInt(c.slice(1), 16) });
  }
  d.ui.bookmarks = (obj.bookmarks || []).map((b) => ({ name: String(b.name), seq: b.seq | 0, t: +b.t }));
  d.ui.addrMarks = (obj.addrMarks || []).filter((m) => /^0x[0-9a-f]+$/i.test(m.addr))
    .map((m) => ({ name: String(m.name), addr: m.addr.toLowerCase() }));
  d.ui.savedFilters = normalizeSavedFilters(obj.savedFilters);
  sendAddrMarks();
  if (obj.rowBytes) {
    d.setRowBytesInput(obj.rowBytes);
    d.post({ type: 'set', key: 'rowBytes', value: obj.rowBytes });
  }
  if (obj.collapseMin) {
    $('collapse-min').value = String(obj.collapseMin);
    d.sendCollapseMin();
  }
  if (obj.colorMode !== undefined) {
    $('color-mode').value = String(obj.colorMode);
    d.post({ type: 'set', key: 'colorMode', value: obj.colorMode });
  }
  if (obj.playhead !== undefined) {
    d.post({ type: 'seek', seq: obj.playhead });
  }
  syncTagDatalist();
  buildMarksPanel();
  d.buildFilterPanel();
  d.buildLegend();
  updateMarkers();
  // layout/filters/crop/drawers/window positions, if this file has them
  // (buildMarks folds in buildSession()) — applied last so they win over the
  // legacy rowBytes/collapseMin/colorMode/playhead fields above
  applySession(obj.session);
  if (!quiet) {
    showPanel('analysis-panel');
    $('st-info').textContent =
      `marks loaded: ${d.ui.tags.length} tags, ${d.ui.names.size} names, ${d.ui.bookmarks.length} time marks, ${d.ui.addrMarks.length} addr marks`;
  }
  d.ui.marksDirty = false;
}

// ---------------------------------------------------------------------------
// panel wiring — all delegated, so the build*Section functions can rebuild
// their markup without rewiring per-row handlers
// ---------------------------------------------------------------------------

function wireAnalysisPanel() {
  delegate($('an-bookmarks'), 'change', {
    bmname: (inp, i) => {
      const bookmark = d.ui.bookmarks[+i];
      commit({ type: 'putBookmark', id: bookmark.id, name: inp.value.trim() || `mark ${+i + 1}`, seq: bookmark.seq, t: bookmark.t });
    },
  });
  delegate($('an-bookmarks'), 'click', {
    // time-only: anchored seek keeps the current address in the viewport
    bmgo: (_, i) => d.post({ type: 'seek', seq: d.ui.bookmarks[+i].seq }),
    // time + place: centers the allocation the event touched
    bmloc: (_, i) => d.post({ type: 'jump', seq: d.ui.bookmarks[+i].seq }),
    bmdel: (_, i) => {
      commit({ type: 'deleteBookmark', id: d.ui.bookmarks[+i].id });
    },
  });

  delegate($('tags-list'), 'change', {
    tagname: (inp, id) => {
      const v = inp.value.trim();
      const tag = d.ui.tags[+id - 1];
      if (v && tag) commit({ type: 'putTag', id: tag.id, name: v, color: tag.color });
    },
  });
  delegate($('tags-list'), 'change', {
    tagcolor: (inp, id) => {
      const tag = d.ui.tags[+id - 1];
      if (tag) commit({ type: 'putTag', id: tag.id, name: tag.name, color: inp.value });
    },
  });
  delegate($('tags-list'), 'click', {
    tagdel: (_, id) => deleteTag(+id),
  });

  delegate($('an-names'), 'change', {
    ncolor: (inp, e) => {
      commit({ type: 'setAllocationColor', creator: +e, color: inp.value });
    },
  });
  delegate($('an-names'), 'change', {
    nname: (inp, e) => {
      const v = inp.value.trim();
      commit({ type: 'setAllocationName', creator: +e, name: v || null });
    },
  });
  delegate($('an-names'), 'click', {
    // select, jump to birth, and open the allocation info window
    ngo: (_, e) => d.post({ type: 'jump', seq: +e + 1, select: true }),
    ndel: (_, e) => {
      commit({ type: 'setAllocationName', creator: +e, name: null });
      if (d.ui.allocColors.has(+e)) commit({ type: 'setAllocationColor', creator: +e, color: null });
    },
  });

  delegate($('an-addrmarks'), 'change', {
    amname: (inp, i) => {
      const mark = d.ui.addrMarks[+i];
      commit({ type: 'putAddressMark', id: mark.id, name: inp.value.trim() || `addr ${+i + 1}`, addr: mark.addr });
    },
  });
  delegate($('an-addrmarks'), 'click', {
    amgo: (_, i) => gotoAddr(d.ui.addrMarks[+i].addr),
    amdel: (_, i) => {
      commit({ type: 'deleteAddressMark', id: d.ui.addrMarks[+i].id });
    },
  });

  delegate($('addr-mark-lines'), 'click', {
    am: (_, i) => gotoAddr(d.ui.addrMarks[+i].addr),
  });

  $('btn-mark').onclick = addBookmark;
  $('an-save').onclick = saveMarks;
  $('an-load').onclick = () => $('analysis-file').click();
  $('analysis-file').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (f) {
      try {
        applyMarks(JSON.parse(await f.text()), false);
      } catch (e) {
        $('st-trace').textContent = `marks load failed: ${(e as Error).message}`;
      }
    }
    ev.target.value = '';
  };
}
