// The `.heapa` round-trip: buildMarks -> applyMarks -> buildMarks over the
// analysis data (tags, names, per-allocation colors, time marks, address
// marks), plus the validation applyMarks does on a file off disk.
//
// Note on scope: applyMarks rebuilds state from the fields it knows and does
// *not* carry unknown fields through. That is current behavior and what these
// tests pin; spec/07-analysis makes no forward-compatibility promise.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, El } from './dom-stub.js';

const doc = installDom();

const { initRpc, handleReply } = await import('../rpc.js');
const { initSession } = await import('../session.js');
const analysis = await import('../heap/analysis.js');
const { heapPanels } = await import('../heap/panels.js');

const PANELS = heapPanels();

const CAT = ['#58a6ff', '#3fb950', '#f2cc60', '#ff7b72', '#bc8cff', '#39c5cf',
  '#f778ba', '#d29922', '#7ee787', '#ffa657', '#79c0ff', '#d2a8ff'];

// --- fixture ---------------------------------------------------------------

const posted = [];

// the engine's authoritative tag->events map, as `tags-dump` would report it
let tagsDump = { 1: [10, 11], 2: [20] };

// a worker stand-in that answers rpc requests inline
initRpc({
  postMessage(m) {
    posted.push(m);
    if (m.type === 'tags-dump') queueMicrotask(() => handleReply({ reqId: m.reqId, tags: tagsDump }));
    if (m.type === 'alloc-info') queueMicrotask(() => handleReply({ reqId: m.reqId, info: null }));
  },
});

function seedDom() {
  for (const id of ['row-bytes', 'row-px', 'alloc-size-format', 'show-all', 'ev-filtered',
    'show-sizes', 'show-addrs', 'f-size-min', 'f-size-max']) {
    doc._put(id, new El('input'));
  }
  doc._put('collapse-min', new El('input')).value = '4';
  doc._put('color-mode', new El('input')).value = '2';
  for (const { id } of PANELS) doc.getElementById(id).classList.add('panel');

  // the two timeline strips each own a .tl-marks layer that updateMarkers fills
  for (const id of ['strip-t', 'strip-s']) {
    const strip = doc.getElementById(id);
    const marks = new El('div');
    marks.classList.add('tl-marks');
    strip.appendChild(marks);
  }
  // datalist the tag name inputs autocomplete against
  const dl = doc._put('tag-names', new El('datalist'));
  dl.classList.add('tag-names');
}

const ui = {
  fileName: 'demo.heapl',
  loaded: true,
  meta: { title: 'demo', n: 1000, tMin: 0, tMax: 5000, unit: 'ns' },
  state: { seq: 250, n: 1000 },
  tlT: { lo: 0, hi: 5000 },
  tlS: { lo: 0, hi: 1000 },
  xview: { zoom: 1, pan: 0 },
  crop: null,
  addrRanges: [],
  marksDirty: false,
  tags: [],
  tagCounts: {},
  untaggedVisible: true,
  names: new Map(),
  allocColors: new Map(),
  bookmarks: [],
  addrMarks: [],
  drawers: null,
};

seedDom();

const noop = () => {};
initSession({
  ui,
  post: (m) => posted.push(m),
  panels: PANELS,
  allocSizeFormat: () => 'human',
  rowBytesValue: () => 0x1000,
  sendCollapseMin: noop,
  buildLegend: noop,
  sendAllocSizeFormat: noop,
  resetEventsPanel: noop,
  sendXView: noop,
  buildAddrRangesSection: noop,
  sendFilter: noop,
  setCrop: noop,
  requestAllocInfo: analysis.requestAllocInfo,
  createPinnedWindow: () => new El('div'),
  buildMarks: analysis.buildMarks,
  applyMarks: analysis.applyMarks,
});

analysis.initAnalysis({
  ui,
  post: (m) => posted.push(m),
  CAT,
  DEFAULT_ROW_BYTES: 0x1000,
  fmtTime: (t) => `${t} ns`,
  buildLegend: noop,
  sendFilter: noop,
  sendNames: noop,
  rowBytesValue: () => 0x1000,
  setRowBytesInput: noop,
  sendCollapseMin: noop,
});

function seedAnalysisState() {
  ui.tags = [
    { name: 'leaky', color: '#ff7b72', visible: true },
    { name: 'pool', color: '#3fb950', visible: false },
  ];
  ui.names = new Map([
    [10, { name: 'session buffer', id: 3, addr: '0x7f0010' }],
    [20, { name: 'lru cache', id: 9, addr: '0x7f0200' }],
  ]);
  ui.allocColors = new Map([[10, '#bc8cff']]);
  ui.bookmarks = [
    { name: 'before spike', seq: 100, t: 1200 },
    { name: 'after spike', seq: 400, t: 3400 },
  ];
  ui.addrMarks = [
    { name: 'arena base', addr: '0x7f0000' },
    { name: 'guard page', addr: '0x7fffff' },
  ];
}

// --- tests -----------------------------------------------------------------

test('buildMarks captures the analysis layer and folds in a session', async () => {
  seedAnalysisState();
  const m = await analysis.buildMarks();

  assert.equal(m.heapVisualizerAnalysis, 1);
  assert.equal(m.trace.file, 'demo.heapl');
  assert.equal(m.trace.n, 1000);
  assert.equal(m.playhead, 250);
  assert.deepEqual(m.tags, [
    { name: 'leaky', color: '#ff7b72', visible: true },
    { name: 'pool', color: '#3fb950', visible: false },
  ]);
  assert.deepEqual(m.taggedEvents, tagsDump);
  assert.deepEqual(m.names, [
    { e: 10, name: 'session buffer', id: 3, addr: '0x7f0010' },
    { e: 20, name: 'lru cache', id: 9, addr: '0x7f0200' },
  ]);
  assert.deepEqual(m.allocColors, [[10, '#bc8cff']]);
  assert.equal(m.bookmarks.length, 2);
  assert.equal(m.addrMarks.length, 2);
  // the exported file is a complete snapshot, not just the marks
  assert.equal(m.session.heapVisualizerSession, 1);
  assert.ok(typeof m.saved === 'string' && m.saved.endsWith('Z'));
});

test('buildMarks -> applyMarks -> buildMarks is a fixed point', async () => {
  seedAnalysisState();
  const before = await analysis.buildMarks();

  // wipe the analysis layer, then restore it from the blob
  ui.tags = [];
  ui.names = new Map();
  ui.allocColors = new Map();
  ui.bookmarks = [];
  ui.addrMarks = [];
  analysis.applyMarks(before, true);

  const after = await analysis.buildMarks();
  // `saved` is a fresh timestamp each call; everything else must match
  delete before.saved;
  delete after.saved;
  assert.deepEqual(after, before);
});

test('applyMarks rejects a blob that is not an analysis file', () => {
  seedAnalysisState();
  const tagsBefore = [...ui.tags];
  analysis.applyMarks(null, true);
  analysis.applyMarks({}, true);
  analysis.applyMarks({ heapVisualizerAnalysis: 2, tags: [] }, true);
  assert.deepEqual(ui.tags, tagsBefore);
  assert.equal(doc.getElementById('st-trace').textContent, '');
});

test('applyMarks reports a non-analysis file when not loading quietly', () => {
  analysis.applyMarks({ nope: true });
  assert.match(doc.getElementById('st-trace').textContent, /not a heap-visualizer marks file/);
  doc.getElementById('st-trace').textContent = '';
});

test('applyMarks falls back to a palette color for a malformed tag color', () => {
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    tags: [
      { name: 'ok', color: '#123abc', visible: true },
      { name: 'bad', color: 'rebeccapurple', visible: true },
      { color: '#ffffff' },
    ],
  }, true);
  assert.equal(ui.tags[0].color, '#123abc');
  assert.equal(ui.tags[1].color, CAT[1]);
  // a tag with no name gets a positional default rather than undefined
  assert.equal(ui.tags[2].name, 'tag 3');
  // visible defaults to true when the field is absent
  assert.equal(ui.tags[2].visible, true);
});

test('applyMarks drops address marks that are not hex addresses, and lowercases the rest', () => {
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    addrMarks: [
      { name: 'good', addr: '0X7FAB' },
      { name: 'bad', addr: 'not-an-address' },
      { name: 'alsobad', addr: '' },
    ],
  }, true);
  assert.deepEqual(ui.addrMarks, [{ name: 'good', addr: '0x7fab' }]);
});

test('applyMarks drops per-allocation colors that are not #rrggbb', () => {
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    allocColors: [[1, '#aabbcc'], [2, 'red'], [3, '#fff']],
  }, true);
  assert.deepEqual([...ui.allocColors.entries()], [[1, '#aabbcc']]);
});

test('applyMarks coerces bookmark fields to their declared types', () => {
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    bookmarks: [{ name: 42, seq: '17', t: '900' }],
  }, true);
  assert.deepEqual(ui.bookmarks, [{ name: '42', seq: 17, t: 900 }]);
});

test('applyMarks warns but still applies when the trace event count differs', () => {
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    trace: { n: 999999 },
    tags: [{ name: 'x', color: '#111111', visible: true }],
  }, true);
  assert.match(doc.getElementById('st-info').textContent, /applying anyway/);
  assert.equal(ui.tags.length, 1);
});

test('applyMarks refuses to apply before a trace is loaded', () => {
  ui.loaded = false;
  ui.tags = [];
  analysis.applyMarks({ heapVisualizerAnalysis: 1, tags: [{ name: 'x', color: '#111111' }] }, true);
  assert.deepEqual(ui.tags, []);
  assert.match(doc.getElementById('st-trace').textContent, /load the matching trace first/);
  ui.loaded = true;
});

test('applyMarks only forwards tag-events for tags that exist', () => {
  posted.length = 0;
  analysis.applyMarks({
    heapVisualizerAnalysis: 1,
    tags: [{ name: 'one', color: '#111111', visible: true }],
    taggedEvents: { 1: [5, 6], 2: [7], 0: [8], 1.5: 'nope' },
  }, true);
  const sent = posted.filter((m) => m.type === 'tag-events');
  assert.deepEqual(sent, [{ type: 'tag-events', tag: 1, events: [5, 6] }]);
});

test('applyMarks clears the dirty flag', () => {
  ui.marksDirty = true;
  analysis.applyMarks({ heapVisualizerAnalysis: 1 }, true);
  assert.equal(ui.marksDirty, false);
});
