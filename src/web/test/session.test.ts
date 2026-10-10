// The session round-trip: buildSession -> applySession -> buildSession must
// be a fixed point. Session shape is what a refactor breaks most easily and
// what a user notices last (a restored layout that quietly lost a field), so
// this is the test the rest of the split leans on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDom, El } from './dom-stub.ts';
import { createFakeDockview } from './fake-dockview.ts';

const doc = installDom();

const {
  initSession, buildSession, applySession, resetSessionSnapshot, HEAP_SESSION_VERSION,
} = await import('../session.ts');
const { heapPanels } = await import('../heap/panels.ts');
const { layout } = await import('../shell/layout.ts');

// the panel list comes from the domain's table, not a copy of it
const PANELS = heapPanels();
function pinnedEl() {
  const el = new El('div');
  el.classList.add('panel', 'pinned-detail');
  return el;
}

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
  input('filter-source', { value: 'alloc.size >= 1KiB and alloc.size <= 1MiB' });

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

  // the views and windows, declared to the shell the way main.ts does, in a
  // dock (a stand-in engine), with Play floating at an explicit spot
  for (const p of PANELS) {
    if (!p.multi && p.dock !== 'center') doc.getElementById(p.id).classList.add('panel');
    layout.register(p.id, {
      title: p.title,
      singleton: !p.multi,
      persist: p.persist !== false,
      closable: p.closable !== false,
      defaultLocation: { dock: p.dock, open: p.open },
      build: p.multi ? pinnedEl : () => doc.getElementById(p.id),
    });
  }
  layout.init(new El('main'), { createDockview: createFakeDockview });
  layout.resetLayout();
  layout.open('play-panel', '', { at: { left: 12, top: 34 } });
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
    filterDraft: 'alloc.size >= 1KiB and alloc.size <= 1MiB',
    filterApplied: 'alloc.size >= 1KiB and alloc.size <= 1MiB',
    filterMode: 2,
    marksDirty: false,
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
  assert.equal(h.filter.languageVersion, 4);
  assert.equal(h.filter.source, 'alloc.size >= 1KiB and alloc.size <= 1MiB');
  assert.equal(h.filter.mode, 2);
  // the shell's section is the dock's own serialization, opaque here
  assert.equal(s.shell.version, 3);
  assert.ok(s.shell.dock);
});

test('the top level is an envelope — no heap concept escapes the heap key', () => {
  const s = buildSession();
  assert.deepEqual(Object.keys(s).sort(), ['heap', 'heapVisualizerSession', 'shell']);
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
  layout.resetLayout();
  layout.open('warnings-panel', '', { dock: 'left' });
  layout.close('filter-panel');
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
  return { heapVisualizerSession: 1, ...heap, shell: s.shell };
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
  assert.deepEqual(after.shell, before.shell);
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

// an older source is read back as no filter rather than restored broken: a
// version-1 source says `tag == "x"` (T016), and a version-2 one is written in
// the pre-Python surface (T042)
test('applySession ignores a filter written in an older language version', () => {
  const s = buildSession();
  s.heap.filter.languageVersion = 2;
  s.heap.filter.source = 'size >= 1KiB && tags contains "hot"';
  ui.filterApplied = '';
  applySession(s);
  assert.equal(ui.filterApplied, '');
});

// A session written before the dock (shell version 1): the shell's
// `windows` and `drawers` at the top level, pinned windows' slots in the
// drawer order and their geometry in the heap section.
function v1Session() {
  const windows = {};
  for (const p of PANELS) {
    if (p.persist === false || p.multi || p.dock === 'center') continue;
    windows[p.id] = { hidden: false, left: '', top: '', right: '', bottom: '' };
  }
  windows['warnings-panel'] = { hidden: true, left: '', top: '', right: '', bottom: '' };
  windows['play-panel'] = { hidden: false, left: '40px', top: '50px', right: 'auto', bottom: 'auto' };
  return {
    heapVisualizerSession: 1,
    windows,
    drawers: {
      left: ['filter-panel', 'pinned-detail:42'], right: ['events-panel'],
      widthLeft: 420, widthRight: 260,
      collapsedLeft: true, collapsedRight: false,
      sizes: { 'filter-panel': 2 },
    },
    heap: {
      version: HEAP_SESSION_VERSION,
      rowBytes: '0x2000',
      playhead: 12,
      pinned: [
        { e: 42, dockSide: 'left', left: '', top: '' },
        { e: 7, dockSide: null, left: '300px', top: '200px', right: 'auto', bottom: 'auto' },
      ],
    },
  };
}

test('a v1 session (drawers, floating windows, pinned) reads into a dock layout and writes back as v3', async () => {
  const restoreUi = { ...makeUI(), meta: {} };
  initSession({
    ...makeDeps(restoreUi, []),
    requestAllocInfo: async (e) => ({ e }),
    createPinnedWindow: (info, place) => layout.open('pinned-detail', String(info.e), { data: info, ...place }),
  });
  applySession(v1Session());
  await new Promise((resolve) => setTimeout(resolve, 0));

  // drawers became edge groups, in order, with their width and collapse
  assert.deepEqual(layout.location('filter-panel'), { dock: 'left', open: true });
  assert.deepEqual(layout.location('events-panel'), { dock: 'right', open: true });
  assert.deepEqual(layout.location('pinned-detail', '42'), { dock: 'left', open: true });
  const shell = buildSession().shell;
  const left = shell.dock.grid.root.data[0];
  assert.deepEqual(left.data.views, ['filter-panel', 'pinned-detail:42']);
  assert.deepEqual(shell.edges.left, { collapsed: true, size: 420, groups: { [left.data.id]: 420 } });
  // windows the old drawers did not dock float, closed ones stay closed
  assert.deepEqual(layout.location('layout-panel'), { dock: null, open: true });
  assert.equal(layout.isOpen('warnings-panel'), false);
  assert.deepEqual(shell.dock.floatingGroups.find((g) => g.data.views.includes('play-panel')).position.left, 40);
  assert.deepEqual(layout.location('pinned-detail', '7'), { dock: null, open: true });
  // the views the old session never placed take their default
  assert.deepEqual(layout.location('addr-scroll'), { dock: 'center', open: true });
  // and it is written back in the current shape
  assert.equal(shell.version, 3);
  assert.deepEqual(buildSession().heap.pinned, [{ e: 42 }, { e: 7 }]);

  // which round-trips
  const v2 = buildSession();
  layout.resetLayout();
  layout.closeAll('pinned-detail');
  applySession(JSON.parse(JSON.stringify(v2)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(buildSession().shell, v2.shell);

  layout.closeAll('pinned-detail');
  initSession(makeDeps(ui, posted));
});

// A session written with the engine's own edge groups (shell version 2: one
// group per side, outside the grid), as the app saved it — the edges come
// back as columns and rows of the one grid, collapse and sizes kept.
test('a v2 session (edge groups) reads into the one grid and writes back as v3', async () => {
  const shell = JSON.parse(readFileSync(new URL('./fixtures/shell-v2.json', import.meta.url), 'utf8'));
  assert.equal(shell.version, 2);
  layout.resetLayout();
  applySession({ heapVisualizerSession: 1, heap: { version: HEAP_SESSION_VERSION, pinned: [] }, shell });
  assert.deepEqual(layout.location('events-panel'), { dock: 'left', open: true });
  for (const id of ['layout-panel', 'appearance-panel', 'filter-panel', 'analysis-panel']) {
    assert.deepEqual(layout.location(id), { dock: 'right', open: true }, id);
  }
  assert.deepEqual(layout.location('addr-scroll'), { dock: 'center', open: true });
  assert.deepEqual(layout.location('strip-t'), { dock: 'center', open: true });
  // the right edge was collapsed: its windows are open but out of sight
  assert.equal(layout.isShown('layout-panel'), false);
  assert.equal(layout.isShown('events-panel'), true);
  const out = buildSession().shell;
  assert.equal(out.version, 3);
  assert.equal(out.dock.edgeGroups, undefined);
  assert.equal(out.edges.right.collapsed, true);
  assert.equal(out.edges.right.size, 300);
  assert.equal(out.edges.left.collapsed, false);
  // panels this build has no window for (another domain's) are not restored
  assert.equal(out.dock.panels['intervals-state'], undefined);
  // and the v3 it was written as round-trips
  layout.resetLayout();
  applySession(JSON.parse(JSON.stringify(buildSessionWith(out))));
  assert.deepEqual(buildSession().shell, out);
});

function buildSessionWith(shell) {
  return { ...buildSession(), shell };
}

test('a v1 drawer layout wholly overrides panels docked by default', () => {
  const s = v1Session();
  s.drawers = { left: ['events-panel'], right: [], widthLeft: 300, widthRight: 300, collapsedLeft: false, collapsedRight: false } as any;
  s.heap.pinned = [];
  layout.resetLayout();
  assert.deepEqual(layout.location('layout-panel'), { dock: 'right', open: true });
  applySession(s);
  for (const id of ['layout-panel', 'appearance-panel', 'filter-panel', 'analysis-panel']) {
    assert.deepEqual(layout.location(id), { dock: null, open: true }, id);
  }
  assert.deepEqual(layout.location('events-panel'), { dock: 'left', open: true });
});

test('applySession seeks to the saved playhead', () => {
  posted.length = 0;
  const s = buildSession();
  s.heap.playhead = 777;
  applySession(s);
  assert.deepEqual(posted.filter((m) => m.type === 'seek'), [{ type: 'seek', seq: 777 }]);
});

test('a pinned-window restore stops when a new trace loads mid-restore', async () => {
  const pending = [];
  const created = [];
  const restoreUi = { ...makeUI(), meta: {} };
  initSession({
    ...makeDeps(restoreUi, []),
    requestAllocInfo: (e) => new Promise((resolve) => pending.push(() => resolve({ e }))),
    createPinnedWindow: (info) => { created.push(info.e); return new El('div'); },
  });
  const blob = {
    heapVisualizerSession: 1,
    heap: { version: HEAP_SESSION_VERSION, pinned: [{ e: 1 }, { e: 2 }] },
  };
  const drain = async () => {
    while (pending.length) {
      pending.shift()();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  // control: an undisturbed restore recreates every window
  applySession(blob);
  await drain();
  assert.deepEqual(created, [1, 2]);

  // a new trace (onLoaded resets the session snapshot) ends the old restore
  created.length = 0;
  applySession(blob);
  resetSessionSnapshot();
  await drain();
  assert.deepEqual(created, []);

  // so does a newer restore: only its windows are created
  applySession(blob);
  applySession({ ...blob, heap: { ...blob.heap, pinned: [{ e: 3 }] } });
  await drain();
  assert.deepEqual(created, [3]);

  initSession(makeDeps(ui, posted));
});
