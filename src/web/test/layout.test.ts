// The shell's panel API (shell/layout.ts) and the drawer state behind it: the
// state model a later layout engine has to reproduce, and the clamps that keep
// a restored or resized layout reachable. Pointer gestures and pixels are a
// person's to check; what is pinned here is the bookkeeping.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, El } from './dom-stub.ts';

const doc: any = installDom();
const g = globalThis as any;

const { layout } = await import('../shell/layout.ts');
const {
  drawersState, clampDrawerWidth, shiftWeights, DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH,
} = await import('../shell/drawers.ts');
const {
  raisePanel, windowZ, clampWindowPosition, WINDOW_Z_MAX,
} = await import('../shell/panels.ts');

doc.getElementById('drawer-left').classList.add('drawer');
doc.getElementById('drawer-right').classList.add('drawer');

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
  // the stub has no pointer capture; dragging is not exercised here
  head.setPointerCapture = () => {};
  return el;
}

const opened = [];
const closed = [];
const toggleBtn = doc.getElementById('btn-a');

layout.register('a-panel', {
  title: 'A', toggle: 'btn-a', defaultLocation: { dock: 'right', open: true }, build: () => panelEl('a-panel'),
  onOpen: () => opened.push('a'), onClose: () => closed.push('a'),
});
layout.register('b-panel', {
  title: 'B', defaultLocation: { dock: 'right', open: true }, build: () => panelEl('b-panel'),
});
layout.register('c-panel', {
  title: 'C', defaultLocation: { dock: null, open: false }, build: () => panelEl('c-panel'),
});
layout.register('pin', {
  title: 'Pinned', singleton: false, persist: false, build: (key) => { const el = panelEl(); el.dataset.k = key; return el; },
});

const el = (type, key = '') => layout.element(type, key);

test('register adopts a singleton: title, close button label, region role', () => {
  const a = el('a-panel');
  assert.equal(a.querySelector('.ph-t').textContent, 'A');
  assert.equal(a.getAttribute('role'), 'region');
  assert.equal(a.getAttribute('aria-labelledby'), a.querySelector('.ph-t').id);
  assert.equal(a.querySelector('.panel-close').getAttribute('aria-label'), 'Close A');
  assert.throws(() => layout.register('a-panel', { title: 'x', build: () => new El() }), /twice/);
  assert.throws(() => layout.open('nope'), /no such panel type/);
});

test('resetLayout docks by the declarations, in order, and opens the defaults', () => {
  layout.resetLayout();
  assert.deepEqual(drawersState.right, ['a-panel', 'b-panel']);
  assert.equal(layout.isOpen('a-panel'), true);
  assert.equal(layout.isOpen('c-panel'), false);
  assert.equal(el('c-panel').dataset.dockSide, undefined);
  assert.equal(doc.getElementById('drawer-right').hidden, false);
  assert.equal(doc.getElementById('drawer-left').hidden, true);
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');
});

test('open/close/toggle own visibility, the drawer, the toggle state and the hooks', () => {
  layout.resetLayout();
  opened.length = 0;
  closed.length = 0;

  layout.close('a-panel');
  assert.equal(el('a-panel').hidden, true);
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  layout.close('a-panel'); // already closed: no second hook
  assert.deepEqual(closed, ['a']);

  // the closed window keeps its dock slot
  assert.equal(el('a-panel').dataset.dockSide, 'right');
  layout.close('b-panel');
  assert.equal(doc.getElementById('drawer-right').hidden, true, 'a drawer with nothing open vanishes');

  layout.toggle('a-panel');
  assert.equal(layout.isOpen('a-panel'), true);
  assert.equal(doc.getElementById('drawer-right').hidden, false);
  layout.open('a-panel'); // already open: no second hook
  assert.deepEqual(opened, ['a']);

  // the toolbar button is wired by the shell
  toggleBtn.onclick();
  assert.equal(layout.isOpen('a-panel'), false);
  toggleBtn.onclick();
  assert.equal(layout.isOpen('a-panel'), true);

  // so is the close button
  el('a-panel').querySelector('.panel-close').onclick();
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

test('multi-instance windows are type + key: built on open, removed on close', () => {
  const p1 = layout.open('pin', '7', { at: { left: 100, top: 120 } });
  layout.open('pin', '9');
  assert.equal(p1.dataset.k, '7');
  assert.equal(p1.dataset.instance, 'pin:7');
  assert.equal(p1.style.left, '100px');
  assert.deepEqual(layout.instancesOf('pin').map((i) => i.key), ['7', '9']);
  assert.equal(layout.open('pin', '7'), p1, 'opening an open instance returns it');

  layout.close('pin', '7');
  assert.equal(layout.isOpen('pin', '7'), false);
  assert.equal(p1.parentElement, null);
  layout.closeAll('pin');
  assert.deepEqual(layout.instancesOf('pin'), []);
});

test('a docked instance keeps its saved slot when it is recreated after a restore', () => {
  layout.resetLayout();
  layout.restoreDrawers({
    left: [], right: ['a-panel', 'pin:3', 'b-panel'],
    widthLeft: 300, widthRight: 300, collapsedLeft: false, collapsedRight: true,
  });
  // the pinned window arrives later (after a worker round-trip)
  layout.open('pin', '3', { dock: 'right', restoring: true });
  assert.deepEqual(drawersState.right, ['a-panel', 'pin:3', 'b-panel']);
  assert.equal(drawersState.collapsedRight, true, 'restoring does not expand');
  assert.deepEqual(layout.serialize().drawers.right, ['a-panel', 'pin:3', 'b-panel']);

  // reveal does expand: the point is to see it
  layout.reveal('pin', '3');
  assert.equal(drawersState.collapsedRight, false);
  layout.closeAll('pin');
  assert.deepEqual(drawersState.right, ['a-panel', 'b-panel']);
});

test('docked heights are weights that survive a neighbour closing and reopening, and persist', () => {
  layout.resetLayout();
  layout.restoreDrawers({
    left: [], right: ['a-panel', 'b-panel'], widthLeft: 300, widthRight: 300,
    collapsedLeft: false, collapsedRight: false, sizes: { 'a-panel': 3, 'b-panel': 1, bogus: -2 },
  });
  assert.equal(el('a-panel').style.flex, '3 1 0');
  layout.close('b-panel');
  layout.open('b-panel');
  assert.equal(el('a-panel').style.flex, '3 1 0');
  assert.equal(el('b-panel').style.flex, '1 1 0');
  assert.deepEqual(layout.serialize().drawers.sizes, { 'a-panel': 3 });

  const [a, b] = shiftWeights(3, 1, 0.05);
  assert.ok(Math.abs(a + b - 4) < 1e-9 && a > 3);
  assert.deepEqual(shiftWeights(1, 1, 5), [1.8, 0.19999999999999996], 'held to the minimum share');

  layout.resetLayout();
  assert.deepEqual(layout.serialize().drawers.sizes, {}, 'reset evens the heights');
});

test('restored floating positions and drawer widths are clamped to the viewport', () => {
  layout.resetLayout();
  layout.restoreWindows({ 'c-panel': { hidden: false, left: '5000px', top: '-300px', right: 'auto', bottom: 'auto' } });
  layout.restoreDrawers({
    left: [], right: ['a-panel'], widthLeft: 300, widthRight: 5000, collapsedLeft: false, collapsedRight: false,
  });
  assert.equal(el('c-panel').style.left, `${g.innerWidth - 60}px`);
  assert.equal(el('c-panel').style.top, '0px');
  assert.equal(drawersState.widthRight, DRAWER_MAX_WIDTH);

  // a narrower viewport later: the drawer shrinks to leave the views room,
  // the window comes back on screen, and the asked-for width is kept
  g.innerWidth = 700;
  layout.clampFloating();
  assert.equal(doc.getElementById('drawer-right').style.width, `${700 - 320}px`);
  assert.equal(el('c-panel').style.left, '640px');
  assert.equal(drawersState.widthRight, DRAWER_MAX_WIDTH);
  g.innerWidth = 1280;
  layout.clampFloating();
  assert.equal(doc.getElementById('drawer-right').style.width, `${DRAWER_MAX_WIDTH}px`);

  // a closed window is clamped when it opens, once its size is known
  layout.restoreWindows({ 'c-panel': { hidden: true, left: '9000px', top: '20px', right: 'auto', bottom: 'auto' } });
  layout.restoreDrawers(null);
  assert.equal(el('c-panel').style.left, '9000px');
  layout.open('c-panel');
  assert.equal(el('c-panel').style.left, `${g.innerWidth - 60}px`);
});

test('the clamps themselves', () => {
  assert.equal(clampDrawerWidth(5000), DRAWER_MAX_WIDTH);
  assert.equal(clampDrawerWidth(10), DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(undefined), 300);
  assert.equal(clampDrawerWidth(450, 200), 200);
  assert.equal(clampDrawerWidth(450, 20), DRAWER_MIN_WIDTH, 'never below the minimum; CSS shrinks it further');
  // a 400px-wide window may hang off the left edge, but keeps 60px on screen
  assert.deepEqual(clampWindowPosition(-1000, 50, 400, 1280, 800), { left: -336, top: 50 });
  assert.deepEqual(clampWindowPosition(2000, 2000, 400, 1280, 800), { left: 1220, top: 760 });
});

test('the z-stack stays in its band however many times windows are raised', () => {
  const a = el('a-panel');
  const b = el('b-panel');
  for (let i = 0; i < 500; i++) raisePanel(i % 2 ? a : b);
  assert.ok(+a.style.zIndex <= WINDOW_Z_MAX && +b.style.zIndex <= WINDOW_Z_MAX);
  assert.ok(+a.style.zIndex > +b.style.zIndex, 'the last raised is on top');
  assert.equal(windowZ(1000), WINDOW_Z_MAX);
  assert.ok(WINDOW_Z_MAX < 50, 'below the tooltip');
});
