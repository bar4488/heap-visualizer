// The shell's panel API (shell/layout.ts) over the dock engine, and the
// engine-free plans behind its default layout and its read path for pre-dock
// sessions. The engine here is test/fake-dockview.ts: what is pinned is the
// bookkeeping — which window is open where, hooks, toggles, focus, adoption,
// the session round trip — while pointer gestures and pixels are a person's
// to check in the browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, El } from './dom-stub.ts';
import { createFakeDockview } from './fake-dockview.ts';

const doc: any = installDom();

const { layout, defaultPlan, legacyPlan } = await import('../shell/layout.ts');

function panelEl(id = null) {
  const el = id ? doc.getElementById(id) : new El('div');
  el.classList.add('panel');
  const head = new El('div');
  head.classList.add('panel-head');
  const title = new El('span');
  title.classList.add('ph-t');
  const close = new El('button');
  close.classList.add('panel-close');
  head.appendChild(title);
  head.appendChild(close);
  el.appendChild(head);
  return el;
}

const opened = [];
const closed = [];
const toggleBtn = doc.getElementById('btn-a');

layout.register('view-t', { title: 'T', defaultLocation: { dock: 'center', open: true }, size: 80, build: () => doc.getElementById('view-t') });
layout.register('view-map', {
  title: 'Map', closable: false, defaultLocation: { dock: 'center', open: true }, build: () => doc.getElementById('view-map'),
});
layout.register('a-panel', {
  title: 'A', toggle: 'btn-a', defaultLocation: { dock: 'right', open: true }, build: () => panelEl('a-panel'),
  onOpen: () => opened.push('a'), onClose: () => closed.push('a'),
});
layout.register('b-panel', { title: 'B', defaultLocation: { dock: 'right', open: true }, build: () => panelEl('b-panel') });
layout.register('l-panel', { title: 'L', defaultLocation: { dock: 'left', open: true }, build: () => panelEl('l-panel') });
layout.register('c-panel', { title: 'C', defaultLocation: { dock: null, open: false }, build: () => panelEl('c-panel') });
layout.register('t-panel', {
  title: 'Transient', persist: false, defaultLocation: { dock: null, open: false }, build: () => panelEl('t-panel'),
});
layout.register('pin', {
  title: 'Pinned', singleton: false, persist: false,
  build: (key) => { const el = panelEl(); el.dataset.k = key; return el; },
});

const api: any = layout.init(new El('main'), { createDockview: createFakeDockview });

const el = (type, key = '') => layout.element(type, key);
const where = (type, key = '') => layout.location(type, key);
const edgeIds = (side) => api.getGroup(`edge-${side}`).panels.map((p) => p.id);

test('register adopts a singleton: parked and hidden, titled, labelled', () => {
  const a = el('a-panel');
  assert.equal(a.querySelector('.ph-t').textContent, 'A');
  assert.equal(a.getAttribute('role'), 'region');
  assert.equal(a.getAttribute('aria-labelledby'), a.querySelector('.ph-t').id);
  assert.equal(a.querySelector('.panel-close').getAttribute('aria-label'), 'Close A');
  assert.equal(toggleBtn.getAttribute('aria-controls'), 'a-panel');
  // a view is not a window: no region role, nothing for Escape to close
  assert.equal(el('view-map').getAttribute('role'), null);
  assert.throws(() => layout.register('a-panel', { title: 'x', build: () => new El() }), /twice/);
  assert.throws(() => layout.open('nope'), /no such panel type/);
});

test('resetLayout: views stacked in the center, windows in their edge in order, defaults open', () => {
  layout.resetLayout();
  assert.deepEqual(where('view-t'), { dock: 'center', open: true });
  assert.deepEqual(where('view-map'), { dock: 'center', open: true });
  assert.deepEqual(edgeIds('right'), ['a-panel', 'b-panel']);
  assert.deepEqual(edgeIds('left'), ['l-panel']);
  assert.equal(api.getGroup('edge-right').activePanel.id, 'a-panel', 'the first tab is in front');
  assert.equal(layout.isOpen('c-panel'), false);
  assert.equal(el('c-panel').hidden, true, 'a closed window is parked, hidden');
  assert.equal(el('a-panel').hidden, false);
  assert.equal(api.isEdgeGroupVisible('right'), true);
  assert.equal(api.isEdgeGroupVisible('bottom'), false, 'an empty edge is hidden');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(api.getGroup(api.getPanel('view-t').group.id).size, { height: 80 }, 'a view with a declared height gets it');
});

test('open/close/toggle own visibility, the edge, the toggle state and the hooks', () => {
  layout.resetLayout();
  opened.length = 0;
  closed.length = 0;

  layout.close('a-panel');
  assert.equal(el('a-panel').hidden, true);
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  layout.close('a-panel'); // already closed: no second hook
  assert.deepEqual(closed, ['a']);
  layout.close('b-panel');
  assert.equal(api.isEdgeGroupVisible('right'), false, 'an edge with nothing open vanishes');

  // reopening returns it to the edge it was in
  layout.open('a-panel');
  assert.deepEqual(where('a-panel'), { dock: 'right', open: true });
  assert.equal(api.isEdgeGroupVisible('right'), true);
  assert.equal(api.getGroup('edge-right').api.isCollapsed(), false, 'an edge that fills up opens expanded');
  layout.open('a-panel'); // already open: no second open hook
  assert.deepEqual(opened, ['a']);

  // the close button is the shell's
  el('a-panel').querySelector('.panel-close').onclick();
  assert.equal(layout.isOpen('a-panel'), false);
});

test('a toggle brings an open window that is out of sight to the front, and closes one in sight', () => {
  layout.resetLayout();
  opened.length = 0;
  assert.equal(layout.isShown('b-panel'), false, 'B is a tab behind A');
  layout.toggle('b-panel');
  assert.equal(layout.isOpen('b-panel'), true);
  assert.equal(layout.isShown('b-panel'), true);
  layout.toggle('b-panel');
  assert.equal(layout.isOpen('b-panel'), false);

  // a collapsed edge: the toolbar toggle expands it rather than closing, and
  // the window coming back into sight runs its open hooks (a list catches up)
  api.getGroup('edge-right').api.collapse();
  assert.equal(layout.isShown('a-panel'), false);
  opened.length = 0;
  toggleBtn.onclick();
  assert.equal(layout.isOpen('a-panel'), true);
  assert.equal(api.getGroup('edge-right').api.isCollapsed(), false);
  assert.deepEqual(opened, ['a']);
  toggleBtn.onclick();
  assert.equal(layout.isOpen('a-panel'), false);
});

test('Escape inside a window closes it, unless something inside used the key', () => {
  layout.open('c-panel');
  let prevented = false;
  el('c-panel').emit('keydown', {
    key: 'Escape', defaultPrevented: true, preventDefault() {}, stopPropagation() {},
  });
  assert.equal(layout.isOpen('c-panel'), true);
  el('c-panel').emit('keydown', {
    key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true; }, stopPropagation() {},
  });
  assert.equal(layout.isOpen('c-panel'), false);
  assert.equal(prevented, true);
});

test('focus moves into a window opened with focus, and back to the opener on close', () => {
  const opener = new El('button');
  let focused = null;
  opener.focus = () => { focused = opener; };
  const c = el('c-panel');
  c.focus = () => { focused = c; doc.activeElement = c; };
  doc.activeElement = opener;
  layout.open('c-panel', '', { focus: true });
  assert.equal(focused, c);
  layout.close('c-panel');
  assert.equal(focused, opener);
  doc.activeElement = undefined;
});

test('a window that opens floating floats; one placed `at` a viewport point floats there', () => {
  layout.open('c-panel', '', { at: { left: 120, top: 90 } });
  assert.deepEqual(where('c-panel'), { dock: null, open: true });
  const box = api.getPanel('c-panel').group.api.boundingBox;
  assert.equal(box.left, 120);
  assert.equal(box.top, 90);
  layout.close('c-panel');
  // closed floating, it reopens floating where it was
  layout.open('c-panel');
  assert.equal(api.getPanel('c-panel').group.api.boundingBox.left, 120);
  layout.close('c-panel');
});

test('multi-instance windows are type + key: built on open, removed on close, opened in place', () => {
  layout.resetLayout();
  const p1 = layout.open('pin', '7', { place: layout.placeOf('a-panel') });
  assert.equal(p1.dataset.k, '7');
  assert.equal(p1.dataset.instance, 'pin:7');
  assert.deepEqual(where('pin', '7'), { dock: 'right', open: true }, 'in the place of the window it pinned');
  layout.open('pin', '9');
  assert.deepEqual(layout.instancesOf('pin').map((i) => i.key), ['7', '9']);
  assert.equal(layout.open('pin', '7'), p1, 'opening an open instance returns it');

  layout.close('pin', '7');
  assert.equal(layout.isOpen('pin', '7'), false);
  assert.equal(p1.parentElement, null, 'a closed instance is removed, not parked');
  layout.closeAll('pin');
  assert.deepEqual(layout.instancesOf('pin'), []);
});

test('reset keeps a transient window open and moves it to float; persisted ones go to their default', () => {
  layout.resetLayout();
  layout.open('t-panel', '', { dock: 'left' });
  layout.close('l-panel');
  layout.resetLayout();
  assert.deepEqual(where('t-panel'), { dock: null, open: true });
  assert.deepEqual(where('l-panel'), { dock: 'left', open: true });
  layout.close('t-panel');
});

test('serialize -> restore puts every window back, and a saved pinned window keeps its slot', () => {
  layout.resetLayout();
  layout.open('pin', '3', { dock: 'left' });
  layout.open('c-panel', '', { dock: 'bottom' });
  layout.close('b-panel');
  const saved = layout.serialize();
  assert.equal(saved.version, 2);

  layout.resetLayout();
  layout.closeAll('pin');
  layout.restore(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(where('c-panel'), { dock: 'bottom', open: true });
  assert.equal(layout.isOpen('b-panel'), false);
  // the pinned window's content is a worker round-trip away: its slot waits
  assert.deepEqual(edgeIds('left'), ['l-panel', 'pin:3']);
  assert.equal(layout.isOpen('pin', '3'), false);
  layout.open('pin', '3', { restoring: true, data: {} });
  assert.deepEqual(where('pin', '3'), { dock: 'left', open: true });
  assert.deepEqual(layout.serialize(), saved, 'a fixed point');

  // a slot no window comes back for is dropped
  layout.closeAll('pin');
  layout.restore(JSON.parse(JSON.stringify(saved)));
  layout.dropPlaceholders();
  assert.deepEqual(edgeIds('left'), ['l-panel']);
});

test('a transient window a session saw open, but that is closed now, is not restored (no empty window)', () => {
  layout.resetLayout();
  layout.open('t-panel', '', { dock: 'left' });
  const saved = layout.serialize();
  layout.close('t-panel');
  layout.restore(JSON.parse(JSON.stringify(saved)));
  assert.equal(layout.isOpen('t-panel'), false);
  assert.deepEqual(edgeIds('left'), ['l-panel']);
  // open now, it stays open across the restore
  layout.open('t-panel', '', { dock: 'left' });
  layout.restore(JSON.parse(JSON.stringify(saved)));
  assert.equal(layout.isOpen('t-panel'), true);
  layout.close('t-panel');
});

test('opening an open window in another window\'s place moves it there (unpin into the live window)', () => {
  layout.resetLayout();
  layout.open('t-panel', '', { at: { left: 50, top: 60 } });
  layout.open('pin', '5', { at: { left: 400, top: 300 } });
  const place = layout.placeOf('pin', '5');
  layout.close('pin', '5');
  layout.open('t-panel', '', { place });
  const box = api.getPanel('t-panel').group.api.boundingBox;
  assert.deepEqual([box.left, box.top], [400, 300]);
  // without a place, an open window stays where it is
  layout.open('t-panel');
  assert.equal(api.getPanel('t-panel').group.api.boundingBox.left, 400);
  layout.close('t-panel');
});

test('a restore cannot lose the view that must always exist, and a broken one falls back to the default', () => {
  layout.resetLayout();
  const saved = layout.serialize();
  saved.dock.groups = saved.dock.groups.map((g) => ({ ...g, views: g.views.filter((v) => v !== 'view-map') }));
  layout.restore(saved);
  assert.deepEqual(where('view-map'), { dock: 'center', open: true });

  layout.close('a-panel');
  layout.restore({ version: 2, dock: { garbage: true } });
  assert.equal(layout.isOpen('a-panel'), true, 'reset to the default');
});

const TYPES = [
  { type: 'view-t', singleton: true, persist: true, home: 'center' as const, open: true },
  { type: 'a-panel', singleton: true, persist: true, home: 'right' as const, open: true },
  { type: 'b-panel', singleton: true, persist: true, home: 'right' as const, open: true },
  { type: 'l-panel', singleton: true, persist: true, home: 'left' as const, open: true },
  { type: 'c-panel', singleton: true, persist: true, home: null, open: false },
  { type: 'n-panel', singleton: true, persist: true, home: 'bottom' as const, open: true },
  { type: 't-panel', singleton: true, persist: false, home: null, open: false },
  { type: 'pin', singleton: false, persist: false, home: null, open: false },
];

test('the default plan follows the declarations', () => {
  assert.deepEqual(defaultPlan(TYPES), {
    center: ['view-t'],
    edges: { left: { ids: ['l-panel'] }, right: { ids: ['a-panel', 'b-panel'] }, bottom: { ids: ['n-panel'] } },
    floating: [],
    homes: { 'view-t': 'center', 'a-panel': 'right', 'b-panel': 'right', 'l-panel': 'left', 'c-panel': null, 'n-panel': 'bottom' },
  });
});

test('a pre-dock session (drawers and floating windows) reads as a plan', () => {
  const plan = legacyPlan({
    windows: {
      'a-panel': { hidden: false, left: '', top: '' },
      'b-panel': { hidden: true },
      'l-panel': { hidden: false, left: '412px', top: '96px' },
      'c-panel': { hidden: false, left: '30px', top: '40px' },
      'gone-panel': { hidden: false },
    },
    drawers: {
      left: ['a-panel', 'pin:12', 'nope:1'], right: ['b-panel'],
      widthLeft: 420, widthRight: 260, collapsedLeft: true, collapsedRight: false,
      sizes: { 'a-panel': 2 },
    },
  }, TYPES);
  // drawers became edges, docked pinned windows keep their slot, and a window
  // docked but closed reopens where it was docked
  assert.deepEqual(plan.edges.left, { ids: ['a-panel', 'pin:12'], size: 420, collapsed: true });
  assert.deepEqual(plan.edges.right, { ids: [], size: 260, collapsed: false });
  assert.equal(plan.homes['b-panel'], 'right');
  // undocked windows float where they were — a saved layout overrides the
  // default wholly, so L, docked by default, floats
  assert.deepEqual(plan.floating, [
    { id: 'l-panel', at: { left: 412, top: 96 } },
    { id: 'c-panel', at: { left: 30, top: 40 } },
  ]);
  // what the old session never knew about takes its default
  assert.deepEqual(plan.center, ['view-t']);
  assert.deepEqual(plan.edges.bottom, { ids: ['n-panel'] });
});

test('restoring a pre-dock session through the shell docks and floats as it said', () => {
  layout.resetLayout();
  layout.restore({
    windows: { 'a-panel': { hidden: false }, 'b-panel': { hidden: false }, 'l-panel': { hidden: true }, 'c-panel': { hidden: false, left: '50px', top: '60px' } },
    drawers: { left: ['b-panel', 'pin:5'], right: [], widthLeft: 333, widthRight: 300, collapsedLeft: false, collapsedRight: false },
  });
  assert.deepEqual(edgeIds('left'), ['b-panel', 'pin:5']);
  assert.equal(api.getGroup('edge-left').size.width, 333);
  assert.deepEqual(where('a-panel'), { dock: null, open: true });
  assert.equal(layout.isOpen('l-panel'), false);
  assert.equal(api.getPanel('c-panel').group.api.boundingBox.left, 50);
  layout.open('pin', '5', { restoring: true, dock: 'left', data: {} });
  assert.deepEqual(edgeIds('left'), ['b-panel', 'pin:5']);
  assert.equal(layout.serialize().version, 2, 'and it is written back as a dock layout');
  layout.closeAll('pin');
});

test('the bottom edge group reads top-down: its tab strip sits above its content', () => {
  assert.equal(api.getGroup('edge-bottom').api.getHeaderPosition(), 'top');
  // the side edges keep the engine's placement
  assert.equal(api.getGroup('edge-left').api.getHeaderPosition(), 'left');
});
