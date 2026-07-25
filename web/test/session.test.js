// The session round-trip: buildSession -> applySession -> buildSession must
// be a fixed point. Session shape is what a refactor breaks most easily and
// what a user notices last (a restored layout that quietly lost a field), so
// this is the test the rest of the split leans on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, El } from './dom-stub.js';

const doc = installDom();

const { initSession, buildSession, applySession } = await import('../session.js');
const { drawersState } = await import('../shell/drawers.js');

const PANEL_IDS = ['play-panel', 'layout-panel', 'appearance-panel', 'filter-panel',
  'analysis-panel', 'warnings-panel', 'events-panel'];

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
  input('f-size-min', { value: '1k' });
  input('f-size-max', { value: '1m' });

  // filter panel: fmode radios plus site/thread checkboxes
  const fp = doc.getElementById('filter-panel');
  for (const v of ['0', '1', '2']) {
    const r = new El('input');
    r.setAttribute('type', 'radio');
    r.setAttribute('name', 'fmode');
    r.setAttribute('value', v);
    r.checked = v === '2';
    fp.appendChild(r);
  }
  for (const [attr, states] of [['data-site', [true, false, true]], ['data-thr', [false, true]]]) {
    states.forEach((on, i) => {
      const b = new El('input');
      b.setAttribute(attr, String(i));
      b.checked = on;
      fp.appendChild(b);
    });
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
    PANEL_IDS,
    allocSizeFormat: () => (doc.getElementById('alloc-size-format').value === 'hex' ? 'hex' : 'human'),
    rowBytesValue: () => parseInt(doc.getElementById('row-bytes').value, 16) || 0,
    sendCollapseMin: noop,
    buildLegend: noop,
    sendAllocSizeFormat: noop,
    resetEventsPanel: noop,
    sendXView: noop,
    buildAddrRangesSection: noop,
    sendFilter: noop,
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
    addrRanges: [{ lo: '0x1000', hi: '0x2000' }],
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
  assert.equal(h.version, 1);
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
  assert.deepEqual(h.filter.sites, [true, false, true]);
  assert.deepEqual(h.filter.thrs, [false, true]);
  assert.equal(h.filter.fmode, '2');
  assert.equal(h.filter.sizeMin, '1k');
  assert.equal(h.filter.sizeMax, '1m');
  assert.deepEqual(h.filter.addrRanges, [{ lo: '0x1000', hi: '0x2000' }]);
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
  doc.getElementById('f-size-min').value = '';
  doc.getElementById('f-size-max').value = '';
  doc.querySelectorAll('#filter-panel input[data-site]').forEach((b) => { b.checked = false; });
  doc.querySelectorAll('#filter-panel input[data-thr]').forEach((b) => { b.checked = true; });
  doc.querySelectorAll('#filter-panel input[name=fmode]').forEach((r) => { r.checked = r.getAttribute('value') === '0'; });
  ui.xview = { zoom: 1, pan: 0 };
  ui.crop = null;
  ui.addrRanges = [];
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

test('applySession drops address ranges that are not valid addresses', () => {
  const s = buildSession();
  s.heap.filter.addrRanges = [
    { lo: '0x10', hi: '0x20' },
    { lo: 'nonsense', hi: '0x20' },
    { lo: '0x10', hi: '' },
  ];
  applySession(s);
  assert.deepEqual(ui.addrRanges, [{ lo: '0x10', hi: '0x20' }]);
});

test('applySession restores drawer docking and widths', () => {
  const s = buildSession();
  s.drawers = { left: ['filter-panel'], right: ['events-panel'], widthLeft: 420, widthRight: 260 };
  applySession(s);

  assert.equal(doc.getElementById('drawer-left').style.width, '420px');
  assert.equal(doc.getElementById('drawer-right').style.width, '260px');
  assert.deepEqual(drawersState.left, ['filter-panel']);
  assert.deepEqual(drawersState.right, ['events-panel']);
  assert.equal(doc.getElementById('filter-panel').dataset.dockSide, 'left');
  assert.equal(doc.getElementById('events-panel').dataset.dockSide, 'right');

  // and the docking survives a build/apply cycle
  const again = buildSession();
  assert.deepEqual(again.drawers.left, ['filter-panel']);
  assert.deepEqual(again.drawers.right, ['events-panel']);
  assert.equal(again.drawers.widthLeft, 420);
});

test('applySession seeks to the saved playhead', () => {
  posted.length = 0;
  const s = buildSession();
  s.heap.playhead = 777;
  applySession(s);
  assert.deepEqual(posted.filter((m) => m.type === 'seek'), [{ type: 'seek', seq: 777 }]);
});
