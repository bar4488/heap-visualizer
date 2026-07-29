// The session round-trip: buildSession -> applySession -> buildSession must
// be a fixed point. Session shape is what a refactor breaks most easily and
// what a user notices last (a restored layout that quietly lost a field), so
// this is the test the rest of the split leans on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, El } from './dom-stub.ts';

const doc = installDom();

const { initSession, buildSession, applySession } = await import('../session.ts');
const {
  drawersState, dockPanel, dockPanelAt, refreshDrawerDividers, setDrawerCollapsed,
} = await import('../shell/drawers.ts');
const { heapPanels } = await import('../heap/panels.ts');

// the panel list comes from the domain's table, not a copy of it
const PANELS = heapPanels();
const PANEL_IDS = PANELS.map((p) => p.id);

// --- fixture ---------------------------------------------------------------

function input(id, props = {}) {
  const el = new El('input');
  Object.assign(el, props);
  return doc._put(id, el);
}

function buildFixture() {
  // toolbar / layout inputs
  input('row-bytes', { value: '0x1000' });
  input('collapse-min', { value: '4' });
  input('row-px', { value: '3' });
  input('color-mode', { value: '2' });
  input('alloc-size-format', { value: 'hex' });
  input('show-all', { checked: true });
  input('ev-filtered', { checked: true });
  input('show-sizes', { checked: false });
  input('show-addrs', { checked: true });
  input('filter-source', { value: 'size >= 1KiB && size <= 1MiB' });

  // filter panel: presentation mode is separate from the expression
  const fp = doc.getElementById('filter-panel');
  for (const v of ['1', '2']) {
    const r = new El('input');
    r.setAttribute('type', 'radio');
    r.setAttribute('name', 'fmode');
    r.setAttribute('value', v);
    r.checked = v === '2';
    fp.appendChild(r);
  }

  // panels as windows, with a couple carrying explicit float geometry
  for (const id of PANEL_IDS) {
    const p = doc.getElementById(id);
    p.classList.add('panel');
  }
  Object.assign(doc.getElementById('play-panel').style,
    { left: '12px', top: '34px', right: 'auto', bottom: 'auto' });
  doc.getElementById('warnings-panel').hidden = true;

  // drawers
  doc.getElementById('drawer-left').classList.add('drawer');
  doc.getElementById('drawer-right').classList.add('drawer');
}

function makeDeps(ui, posted) {
  const noop = () => {};
  return {
    ui,
    post: (m) => posted.push(m),
    panels: PANELS,
    allocSizeFormat: () => (doc.getElementById('alloc-size-format').value === 'hex' ? 'hex' : 'human'),
    rowBytesValue: () => parseInt(doc.getElementById('row-bytes').value, 16) || 0,
    sendCollapseMin: noop,
    buildLegend: noop,
    sendAllocSizeFormat: noop,
    resetEventsPanel: noop,
    sendXView: noop,
    applyFilterSource: (source) => {
      ui.filterDraft = source;
      ui.filterApplied = source;
      doc.getElementById('filter-source').value = source;
      return Promise.resolve(true);
    },
    setCrop: (lo, hi) => { ui.crop = { lo, hi }; },
    requestAllocInfo: async () => null,
    createPinnedWindow: () => new El('div'),
    buildMarks: async () => ({}),
    applyMarks: noop,
  };
}

function makeUI() {
  return {
    fileName: 'demo.heapl',
    loaded: true,
    state: { seq: 4321, n: 100000 },
    xview: { zoom: 2.5, pan: 0.25 },
    crop: { lo: 100, hi: 900 },
    filterDraft: 'size >= 1KiB && size <= 1MiB',
    filterApplied: 'size >= 1KiB && size <= 1MiB',
    filterMode: 2,
    marksDirty: false,
    drawers: drawersState,
  };
}

buildFixture();

const posted = [];
const ui = makeUI();
initSession(makeDeps(ui, posted));

// --- tests -----------------------------------------------------------------

test('buildSession captures every field the format promises', () => {
  const s = buildSession();
  assert.equal(s.heapVisualizerSession, 1);
  const h = s.heap;
  assert.equal(h.version, 2);
  assert.equal(h.rowBytes, '0x1000');
  assert.equal(h.collapseMin, '4');
  assert.equal(h.rowPx, '3');
  assert.equal(h.colorMode, '2');
  assert.equal(h.allocSizeFormat, 'hex');
  assert.equal(h.showAll, true);
  assert.equal(h.evFiltered, true);
  assert.equal(h.sizeLabels, false);
  assert.equal(h.addrLabels, true);
  assert.deepEqual(h.xview, { zoom: 2.5, pan: 0.25 });
  assert.deepEqual(h.crop, { lo: 100, hi: 900 });
  assert.equal(h.playhead, 4321);
  assert.equal(h.filter.languageVersion, 2);
  assert.equal(h.filter.source, 'size >= 1KiB && size <= 1MiB');
  assert.equal(h.filter.mode, 2);
  assert.deepEqual(Object.keys(s.windows).sort(), [...PANEL_IDS].sort());
  assert.equal(s.windows['warnings-panel'].hidden, true);
  assert.deepEqual(s.windows['play-panel'],
    { hidden: false, left: '12px', top: '34px', right: 'auto', bottom: 'auto' });
});

test('the top level is shell state only — no heap concept escapes the heap key', () => {
  const s = buildSession();
  assert.deepEqual(Object.keys(s).sort(),
    ['drawers', 'heap', 'heapVisualizerSession', 'windows']);
});

// scrambles everything the session owns, so a field applySession forgets to
// restore shows up as a difference rather than passing by luck
function scramble() {
  doc.getElementById('row-bytes').value = '0x40';
  doc.getElementById('collapse-min').value = '99';
  doc.getElementById('row-px').value = '11';
  doc.getElementById('color-mode').value = '0';
  doc.getElementById('alloc-size-format').value = 'human';
  doc.getElementById('show-all').checked = false;
  doc.getElementById('ev-filtered').checked = false;
  doc.getElementById('show-sizes').checked = true;
  doc.getElementById('show-addrs').checked = false;
  doc.getElementById('filter-source').value = '';
  doc.querySelectorAll('#filter-panel input[name=fmode]').forEach((r) => { r.checked = r.getAttribute('value') === '1'; });
  ui.xview = { zoom: 1, pan: 0 };
  ui.crop = null;
  ui.filterDraft = '';
  ui.filterApplied = '';
  ui.filterMode = 1;
  ui.state = { seq: 0, n: 100000 };
  Object.assign(doc.getElementById('play-panel').style,
    { left: '999px', top: '999px', right: '', bottom: '' });
  doc.getElementById('warnings-panel').hidden = false;
}

test('buildSession -> applySession -> buildSession is a fixed point', () => {
  const before = buildSession();
  scramble();

  applySession(before);
  // playhead is applied by posting a seek; the UI state the worker would send
  // back is what buildSession reads, so mirror it here
  ui.state = { seq: before.heap.playhead, n: 100000 };

  assert.deepEqual(buildSession(), before);
});

// the shape written before the heap fields were namespaced: everything at the
// top level, no `heap` key, no version
function flatten(s) {
  const { version, ...heap } = s.heap;
  return { heapVisualizerSession: 1, ...heap, windows: s.windows, drawers: s.drawers };
}

test('a session written in the old flat shape restores identically', () => {
  const before = buildSession();
  const old = flatten(before);
  scramble();

  applySession(old);
  ui.state = { seq: old.playhead, n: 100000 };

  assert.deepEqual(buildSession(), before);
});

test('a heap section at an unknown version is skipped, and the shell layout still restores', () => {
  const before = buildSession();
  scramble();
  const scrambled = buildSession();

  applySession({ ...before, heap: { ...before.heap, version: 99 } });

  const after = buildSession();
  // shell state came back...
  assert.deepEqual(after.windows, before.windows);
  // ...and nothing from the unreadable heap section was applied
  assert.deepEqual(after.heap, scrambled.heap);
});

test('applySession ignores a blob that is not a session', () => {
  const before = buildSession();
  applySession(null);
  applySession(undefined);
  applySession({});
  applySession({ heapVisualizerSession: 2, rowBytes: '0xdead' });
  assert.deepEqual(buildSession(), before);
});

test('applySession ignores a filter with an unknown language version', () => {
  const s = buildSession();
  s.heap.filter.languageVersion = 99;
  s.heap.filter.source = 'size > 0';
  ui.filterApplied = '';
  applySession(s);
  assert.equal(ui.filterApplied, '');
});

// a version-1 source can say `tag == "x"`, which no longer checks (T016)
test('applySession ignores a filter written in language version 1', () => {
  const s = buildSession();
  s.heap.filter.languageVersion = 1;
  s.heap.filter.source = 'tag == "hot"';
  ui.filterApplied = '';
  applySession(s);
  assert.equal(ui.filterApplied, '');
});

test('applySession restores drawer docking and widths', () => {
  const s = buildSession();
  s.drawers = {
    left: ['filter-panel'], right: ['events-panel'],
    widthLeft: 420, widthRight: 260,
    collapsedLeft: true, collapsedRight: false,
  };
  applySession(s);

  assert.equal(doc.getElementById('drawer-left').style.width, '420px');
  assert.equal(doc.getElementById('drawer-right').style.width, '260px');
  assert.deepEqual(drawersState.left, ['filter-panel']);
  assert.deepEqual(drawersState.right, ['events-panel']);
  assert.equal(doc.getElementById('filter-panel').dataset.dockSide, 'left');
  assert.equal(doc.getElementById('events-panel').dataset.dockSide, 'right');
  assert.equal(drawersState.collapsedLeft, true);
  assert.equal(drawersState.collapsedRight, false);
  assert.equal(doc.getElementById('drawer-left').classList.contains('collapsed'), true);

  // and the docking survives a build/apply cycle
  const again = buildSession();
  assert.deepEqual(again.drawers.left, ['filter-panel']);
  assert.deepEqual(again.drawers.right, ['events-panel']);
  assert.equal(again.drawers.widthLeft, 420);
  assert.equal(again.drawers.collapsedLeft, true);
});

test('a saved drawer layout wholly overrides panels docked by default', () => {
  for (const p of PANELS.filter((p) => p.dock)) {
    dockPanel(doc.getElementById(p.id), p.dock);
  }
  assert.equal(doc.getElementById('layout-panel').dataset.dockSide, 'right');

  const s = buildSession();
  s.drawers = {
    left: ['events-panel'], right: [],
    widthLeft: 300, widthRight: 300,
    collapsedLeft: false, collapsedRight: false,
  };
  applySession(s);

  assert.equal(doc.getElementById('layout-panel').dataset.dockSide, undefined);
  assert.equal(doc.getElementById('appearance-panel').dataset.dockSide, undefined);
  assert.equal(doc.getElementById('filter-panel').dataset.dockSide, undefined);
  assert.equal(doc.getElementById('analysis-panel').dataset.dockSide, undefined);
  assert.deepEqual(drawersState.left, ['events-panel']);
  assert.deepEqual(drawersState.right, []);
});

test('session docking preserves a collapsed drawer, while a user drop expands it', () => {
  const win = new El('div');
  win.classList.add('panel');
  doc.body.appendChild(win);

  setDrawerCollapsed('left', true);
  dockPanelAt(win, 'left', null, false);
  assert.equal(drawersState.collapsedLeft, true);

  dockPanelAt(win, 'left', null);
  assert.equal(drawersState.collapsedLeft, false);

  win.remove();
  refreshDrawerDividers('left');
});

test('applySession seeks to the saved playhead', () => {
  posted.length = 0;
  const s = buildSession();
  s.heap.playhead = 777;
  applySession(s);
  assert.deepEqual(posted.filter((m) => m.type === 'seek'), [{ type: 'seek', seq: 777 }]);
});
