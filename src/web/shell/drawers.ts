// Shell: dockable left/right drawers. Panels enter this layer as ordinary
// floating elements; the domain may dock any of them here, where they can
// stack, get hidden as a group, and be resized — without changing anything
// about how floating panels behave.
//
// No domain knowledge: a drawer holds panel elements by instance key (the
// `data-instance` the layout assigns, or the element id) and never asks what
// is inside one.

import { $, $$ } from './dom.ts';
import { raisePanel } from './panels.ts';

export type Side = 'left' | 'right';

// A drawer exists exactly when it has a docked window in it, empty otherwise
// (see refreshDrawerDividers). Separately from that, one that does have content
// can be *collapsed* to a rail from its bar — which hides its windows without
// closing or undocking them, so the way to get the screen back is not to
// dismantle the layout.
//
// `sizes` holds each docked window's share of its drawer's height, as a flex
// weight keyed by instance key (1 when absent). Weights rather than pixels:
// opening or closing a neighbor, or resizing the viewport, redistributes the
// space in proportion instead of freezing anyone at a stale height.
//
// `widthLeft`/`widthRight` are the widths the user asked for. What is shown is
// that, clamped so the views keep MIN_VIEWS_WIDTH (see drawerWidthFor).
//
// Mutated in place, never replaced, so a holder of the reference always sees
// current state.
export const drawersState = {
  left: [], right: [], widthLeft: 300, widthRight: 300, collapsedLeft: false, collapsedRight: false,
  sizes: {} as Record<string, number>,
};

export const DRAWER_MIN_WIDTH = 160;
export const DRAWER_MAX_WIDTH = 600;
export const DRAWER_DEFAULT_WIDTH = 300;
export const COLLAPSED_WIDTH = 30;
/** The views never get narrower than this because of a drawer (also in style.css). */
export const MIN_VIEWS_WIDTH = 320;

const panelFloatRect = new Map(); // panel element -> its floating {left,top,right,bottom}, for undock

// the drawer order a restored session asked for, so a window that is created
// later (a pinned allocation window, after its worker round-trip) still lands
// in its saved slot
const savedOrder = { left: [], right: [] };

export function drawerEl(side) { return $(side === 'left' ? 'drawer-left' : 'drawer-right'); }

/** The key a docked window is persisted under. */
export function panelKey(p) { return p.dataset.instance || p.id || ''; }

const widthField = (side) => (side === 'left' ? 'widthLeft' : 'widthRight');
const other = (side): Side => (side === 'left' ? 'right' : 'left');

/**
 * The width a drawer is shown at: what was asked for, held to the drawer's own
 * limits and to the room left once the views keep their minimum. `room` is the
 * width available to this drawer (viewport minus the other drawer, the guide
 * and the views' minimum), or null when it is not known.
 */
export function clampDrawerWidth(asked, room = null) {
  let w = Number.isFinite(asked) && asked > 0 ? asked : DRAWER_DEFAULT_WIDTH;
  w = Math.min(DRAWER_MAX_WIDTH, w);
  if (room !== null && Number.isFinite(room)) w = Math.min(w, room);
  return Math.max(DRAWER_MIN_WIDTH, Math.round(w));
}

function shownWidth(side) {
  const dr = drawerEl(side);
  if (dr.hidden) return 0;
  if (dr.classList.contains('collapsed')) return COLLAPSED_WIDTH;
  return clampDrawerWidth(drawersState[widthField(side)]);
}

function roomFor(side) {
  const vw = typeof innerWidth === 'number' ? innerWidth : 0;
  if (!vw) return null;
  const guide = $('guide');
  const guideW = guide && !guide.hidden ? guide.getBoundingClientRect().width : 0;
  return vw - guideW - shownWidth(other(side)) - MIN_VIEWS_WIDTH;
}

export function drawerWidthFor(side) {
  return clampDrawerWidth(drawersState[widthField(side)], roomFor(side));
}

/** Show both drawers at their clamped widths (after a resize, restore or dock). */
export function applyDrawerWidths() {
  for (const side of ['left', 'right'] as Side[]) {
    const w = `${drawerWidthFor(side)}px`;
    const dr = drawerEl(side);
    if (dr.style.width !== w) dr.style.width = w;
  }
}

/** The visible windows docked in `side`, top to bottom. */
export function dockedPanels(side, includeClosed = false) {
  return [...drawerEl(side).children]
    .filter((c) => c.classList.contains('panel') && (includeClosed || !c.hidden));
}

function weightOf(p) {
  const w = drawersState.sizes[panelKey(p)];
  return Number.isFinite(w) && w > 0 ? w : 1;
}

function applyWeight(p) {
  const f = `${+weightOf(p).toFixed(4)} 1 0`;
  if (p.style.flex !== f) p.style.flex = f;
}

export function refreshDrawerDividers(side) {
  const dr = drawerEl(side);
  $$('.drawer-vresize', dr).forEach((d) => d.remove());
  // a docked-but-closed (×'d) panel stays a DOM child so re-opening it from
  // the toolbar still works, but it shouldn't hold the drawer open or get a
  // divider of its own
  const panels = dockedPanels(side);
  panels.forEach((p, i) => {
    applyWeight(p);
    if (i > 0) {
      const div = document.createElement('div');
      div.className = 'drawer-vresize';
      dr.insertBefore(div, p);
      wireVResize(div, panels[i - 1], p);
    }
  });
  dr.hidden = panels.length === 0;
  refreshRail(side, panels);
  applyDrawerWidths();
}

const titleOf = (p) => (p.querySelector('.ph-t')?.textContent || '').trim() || 'Window';

/**
 * Move `frac` of the pair's combined weight from B to A (negative: A to B),
 * keeping each at least `minFrac` of the pair. Pure: returns the new weights.
 */
export function shiftWeights(wA, wB, frac, minFrac = 0.1) {
  const total = wA + wB;
  const a = Math.min(total * (1 - minFrac), Math.max(total * minFrac, wA + frac * total));
  return [a, total - a];
}

// Drag the divider between two stacked panels: height moves only between the
// two panels adjacent to the handle, as a change in their flex weights, so
// every other panel keeps its share and nothing is frozen at a pixel height.
export function wireVResize(div, panelA, panelB) {
  div.setAttribute('role', 'separator');
  div.setAttribute('aria-orientation', 'horizontal');
  div.setAttribute('tabindex', '0');
  div.setAttribute('aria-label', `Resize ${titleOf(panelA)} and ${titleOf(panelB)}`);
  div.title = 'Drag, or focus and use ↑/↓, to share the height between these windows';
  const set = (a, b) => {
    drawersState.sizes[panelKey(panelA)] = a;
    drawersState.sizes[panelKey(panelB)] = b;
    applyWeight(panelA);
    applyWeight(panelB);
    div.setAttribute('aria-valuenow', String(Math.round((100 * a) / (a + b))));
  };
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startAH = panelA.getBoundingClientRect().height;
    const startBH = panelB.getBoundingClientRect().height;
    const totalH = startAH + startBH;
    const wA = weightOf(panelA);
    const wB = weightOf(panelB);
    const minH = Math.min(60, totalH / 2);
    const move = (ev) => {
      if (totalH <= 0) return;
      const ah = Math.max(minH, Math.min(totalH - minH, startAH + (ev.clientY - startY)));
      const W = wA + wB;
      set((W * ah) / totalH, (W * (totalH - ah)) / totalH);
    };
    const up = () => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', up);
      if (div.hasPointerCapture?.(e.pointerId)) div.releasePointerCapture(e.pointerId);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', up);
  });
  div.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const [a, b] = shiftWeights(weightOf(panelA), weightOf(panelB), e.key === 'ArrowUp' ? -0.05 : 0.05);
    set(a, b);
  });
}

export function wireDrawerWidthResize(side) {
  const dr = drawerEl(side);
  const handle = document.createElement('div');
  handle.className = 'drawer-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', `Resize the ${side} drawer`);
  handle.title = 'Drag, or focus and use ←/→, to resize this drawer';
  dr.appendChild(handle);
  const setWidth = (w) => {
    drawersState[widthField(side)] = clampDrawerWidth(w, roomFor(side));
    applyDrawerWidths();
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = dr.getBoundingClientRect().width;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      setWidth(side === 'left' ? startW + dx : startW - dx);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const grow = (e.key === 'ArrowRight') === (side === 'left');
    setWidth(drawerWidthFor(side) + (grow ? 16 : -16));
  });
}

// dropSideAt/showDropPreview/clearDropPreview drive the drag-and-drop dock
// path (see makePanelWindow): dock at a specific position, reorder within
// the same drawer, or move between drawers, all by dragging a panel's header
export function dropSideAt(clientX) {
  const leftDr = drawerEl('left');
  const rightDr = drawerEl('right');
  if (!leftDr.hidden && clientX <= leftDr.getBoundingClientRect().right) return 'left';
  if (!rightDr.hidden && clientX >= rightDr.getBoundingClientRect().left) return 'right';
  // activation zone at the screen edge, so a currently-empty (hidden) drawer
  // can still be dropped into
  const EDGE = 44;
  if (clientX <= EDGE) return 'left';
  if (clientX >= innerWidth - EDGE) return 'right';
  return null;
}

// the insertion line, for a drop between windows of an open drawer
const dndIndicator = document.createElement('div');
dndIndicator.id = 'dnd-indicator';
dndIndicator.hidden = true;
// the drop zone, for a drop into an empty or collapsed drawer: drawn over the
// workspace where the drawer will appear, so previewing it reflows nothing
const dndZone = document.createElement('div');
dndZone.id = 'dnd-zone';
dndZone.hidden = true;

// appends the drag previews, gives each drawer its bar, and wires both
// drawers' width handles and the viewport clamp
export function initDrawers() {
  document.body.appendChild(dndIndicator);
  document.body.appendChild(dndZone);
  addDrawerBar('left');
  addDrawerBar('right');
  wireDrawerWidthResize('left');
  wireDrawerWidthResize('right');
  applyDrawerWidths();
}

const collapseButtons = new Map(); // side -> its collapse toggle
const rails = new Map(); // side -> the collapsed rail's title list

// The bar sits above the docked windows and holds the collapse toggle, and —
// while collapsed — the titles of the windows docked there. It is created
// here rather than written into index.html so the whole drawer mechanism
// stays in one file, the same way the width handle is.
function addDrawerBar(side) {
  const dr = drawerEl(side);
  const bar = document.createElement('div');
  bar.className = 'drawer-bar';
  const btn = document.createElement('button');
  btn.className = 'drawer-collapse';
  btn.onclick = () => setDrawerCollapsed(side, !isDrawerCollapsed(side));
  bar.appendChild(btn);
  const rail = document.createElement('div');
  rail.className = 'drawer-rail';
  bar.appendChild(rail);
  // first child: refreshDrawerDividers only ever inserts dividers before
  // panels, and panels are appended after, so it stays at the top
  dr.insertBefore(bar, dr.children[0] || null);
  collapseButtons.set(side, btn);
  rails.set(side, rail);
  setDrawerCollapsed(side, isDrawerCollapsed(side));
}

// one vertical title per visible docked window; clicking one expands the
// drawer, so the rail says what is in there and is a way back to it
function refreshRail(side, panels) {
  const rail = rails.get(side);
  if (!rail) return;
  rail.innerHTML = '';
  for (const p of panels) {
    const item = document.createElement('button');
    item.className = 'drawer-rail-item';
    item.textContent = titleOf(p);
    item.title = `Show ${titleOf(p)}`;
    item.onclick = () => setDrawerCollapsed(side, false);
    rail.appendChild(item);
  }
}

const collapsedField = (side) => (side === 'left' ? 'collapsedLeft' : 'collapsedRight');

export function isDrawerCollapsed(side) { return !!drawersState[collapsedField(side)]; }

// Collapsing is a pure display change: nothing is closed, undocked or
// reordered, and the drawer keeps its width so expanding puts it back exactly
// as it was. The chevron always points the way the drawer will move.
export function setDrawerCollapsed(side, on) {
  drawersState[collapsedField(side)] = !!on;
  drawerEl(side).classList.toggle('collapsed', !!on);
  const btn = collapseButtons.get(side);
  if (!btn) return;
  const away = side === 'left' ? '›' : '‹';
  const toward = side === 'left' ? '‹' : '›';
  btn.textContent = on ? away : toward;
  btn.title = on ? 'Show this drawer' : 'Collapse this drawer, keeping its windows docked';
  btn.setAttribute('aria-label', on ? `Expand the ${side} drawer` : `Collapse the ${side} drawer`);
  btn.setAttribute('aria-expanded', String(!on));
  applyDrawerWidths();
}

// shows a preview of where `p` would land in `side`'s drawer for a drop at
// `clientY`, and returns the panel to insert before (null = append at the
// end). An open drawer gets an insertion line; an empty or collapsed one an
// overlay where it will appear — the drawer itself is never un-hidden or
// resized by a preview, so nothing reflows mid-drag.
export function showDropPreview(p, side, clientY) {
  const dr = drawerEl(side);
  $$('.drawer.drop-target').forEach((d) => { if (d !== dr) d.classList.remove('drop-target'); });
  if (dr.hidden || dr.classList.contains('collapsed')) {
    dr.classList.remove('drop-target');
    dndIndicator.hidden = true;
    const ws = $('workspace').getBoundingClientRect();
    const w = drawerWidthFor(side);
    const guide = $('guide');
    const guideRight = guide && !guide.hidden ? guide.getBoundingClientRect().right : ws.left;
    const left = side === 'left' ? guideRight : ws.right - w;
    dndZone.style.left = `${left}px`;
    dndZone.style.top = `${ws.top}px`;
    dndZone.style.width = `${w}px`;
    dndZone.style.height = `${ws.height}px`;
    dndZone.hidden = false;
    return null;
  }
  dndZone.hidden = true;
  dr.classList.add('drop-target');
  const panels = dockedPanels(side).filter((c) => c !== p);
  const ref = panels.find((cand) => {
    const cr = cand.getBoundingClientRect();
    return clientY < cr.top + cr.height / 2;
  }) || null;
  let rect;
  let y;
  if (ref) {
    rect = ref.getBoundingClientRect();
    y = rect.top;
  } else if (panels.length) {
    rect = panels[panels.length - 1].getBoundingClientRect();
    y = rect.bottom;
  } else {
    rect = dr.getBoundingClientRect();
    y = rect.top + 6;
  }
  dndIndicator.style.left = `${rect.left}px`;
  dndIndicator.style.width = `${rect.width}px`;
  dndIndicator.style.top = `${y - 1}px`;
  dndIndicator.hidden = false;
  return ref;
}

export function clearDropPreview() {
  dndIndicator.hidden = true;
  dndZone.hidden = true;
  $$('.drawer.drop-target').forEach((d) => d.classList.remove('drop-target'));
}

/** The docked window after `p` in its drawer (any, open or closed), or null. */
export function nextDockedSibling(p) {
  if (!p.dataset.dockSide) return null;
  const all = dockedPanels(p.dataset.dockSide, true);
  return all[all.indexOf(p) + 1] || null;
}

function syncOrder(side) {
  drawersState[side] = dockedPanels(side, true).map(panelKey).filter(Boolean);
}

export function dockPanelAt(p, side, beforeEl, expand = true) {
  const oldSide = p.dataset.dockSide;
  if (!oldSide) {
    panelFloatRect.set(p, { left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom });
  }
  p.classList.add('docked');
  p.dataset.dockSide = side;
  // open/closed is the window's own state and docking does not change it: a
  // closed docked window keeps its slot (it is how the toolbar returns it to
  // its place), and the default layout docks windows it means to leave closed
  drawerEl(side).insertBefore(p, beforeEl || null);
  // A user drop into a collapsed drawer means "put it there", which is only
  // observable if the drawer opens up again. Session restoration passes
  // expand=false: recreating a saved pinned window must not undo the saved
  // collapsed state.
  if (expand && !p.hidden) setDrawerCollapsed(side, false);
  // rebuild from actual DOM order: correct for both a fresh dock and a
  // same-drawer reorder, no manual index bookkeeping needed
  syncOrder(side);
  if (oldSide && oldSide !== side) syncOrder(oldSide);
  refreshDrawerDividers(side);
  if (oldSide && oldSide !== side) refreshDrawerDividers(oldSide);
}

export function dockPanel(p, side) {
  dockPanelAt(p, side, null);
}

/**
 * Dock a window that a restored session placed in `side`, in the slot the
 * session saved for it among whatever is already docked there. For a window
 * created after the drawers were restored (a pinned allocation window).
 */
export function dockRestored(p, side) {
  const order = savedOrder[side];
  const at = order.indexOf(panelKey(p));
  let ref = null;
  if (at >= 0) {
    ref = dockedPanels(side, true).find((c) => {
      const i = order.indexOf(panelKey(c));
      return i > at;
    }) || null;
  }
  dockPanelAt(p, side, ref, false);
}

export function undockPanel(p) {
  const side = p.dataset.dockSide;
  if (!side) return;
  delete p.dataset.dockSide;
  p.classList.remove('docked');
  p.style.flex = '';
  document.body.appendChild(p);
  const r = panelFloatRect.get(p);
  if (r) {
    p.style.left = r.left; p.style.top = r.top; p.style.right = r.right; p.style.bottom = r.bottom;
  }
  panelFloatRect.delete(p);
  syncOrder(side);
  refreshDrawerDividers(side);
  raisePanel(p);
}

function readSizes(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

// re-dock panels and restore drawer width/visibility from a saved session
export function applyDrawersState(d) {
  if (!d) return;
  // A saved layout replaces the current one rather than adding to it: a panel
  // docked right now and absent from the save — which is what a session
  // written before the default layout docked anything looks like — has to end
  // up floating, or the default would show through a restore.
  const left = Array.isArray(d.left) ? d.left.filter((k) => typeof k === 'string') : [];
  const right = Array.isArray(d.right) ? d.right.filter((k) => typeof k === 'string') : [];
  const wanted = new Set([...left, ...right]);
  for (const side of ['left', 'right']) {
    for (const p of dockedPanels(side, true)) {
      if (!wanted.has(panelKey(p))) undockPanel(p);
    }
  }
  savedOrder.left = left;
  savedOrder.right = right;
  // in-place reset: the object identity is stable (see drawersState)
  drawersState.left = [];
  drawersState.right = [];
  drawersState.widthLeft = clampDrawerWidth(d.widthLeft);
  drawersState.widthRight = clampDrawerWidth(d.widthRight);
  drawersState.sizes = readSizes(d.sizes);
  // docking pushes into drawersState.left/right itself and shows the drawer
  // (via refreshDrawerDividers) as soon as it has content
  const byKey = (k) => $$('.panel').find((p) => panelKey(p) === k) || null;
  for (const side of ['left', 'right'] as Side[]) {
    for (const k of savedOrder[side]) {
      const p = byKey(k);
      if (p) dockPanelAt(p, side, null, false);
    }
  }
  setDrawerCollapsed('left', !!d.collapsedLeft);
  setDrawerCollapsed('right', !!d.collapsedRight);
  refreshDrawerDividers('left');
  refreshDrawerDividers('right');
}

/** The drawer layout as the session stores it. */
export function snapshotDrawers() {
  const keep = new Set([...drawersState.left, ...drawersState.right]);
  const sizes = {};
  for (const [k, v] of Object.entries(drawersState.sizes)) if (keep.has(k) && v !== 1) sizes[k] = +v.toFixed(4);
  return {
    left: [...drawersState.left],
    right: [...drawersState.right],
    widthLeft: drawersState.widthLeft,
    widthRight: drawersState.widthRight,
    collapsedLeft: drawersState.collapsedLeft,
    collapsedRight: drawersState.collapsedRight,
    sizes,
  };
}

// the shell's own panel-window factory, bound to this drawer implementation
// so callers don't have to assemble the dock API at each call site
export const dock = {
  undockPanel, dropSideAt, refreshDrawerDividers, showDropPreview, clearDropPreview, dockPanelAt,
  nextDockedSibling,
};
