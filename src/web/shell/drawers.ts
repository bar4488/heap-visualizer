// Shell: dockable left/right drawers. Panels float by default (panels.ts);
// this adds an alternate home where any panel can stack, get hidden as a
// group, and be resized — without changing anything about how floating
// panels behave.
//
// No domain knowledge: a drawer holds panel elements by id and never asks
// what is inside one.

import { $, $$ } from './dom.ts';
import { raisePanel } from './panels.ts';

// no manual show/hide control: a drawer is visible exactly when it has a
// docked window in it, empty otherwise — see refreshDrawerDividers
//
// Mutated in place, never replaced, so a holder of the reference (main.ts
// keeps it as UI.drawers for the session snapshot) always sees current state.
export const drawersState = { left: [], right: [], widthLeft: 300, widthRight: 300 };

const panelFloatRect = new Map(); // panel element -> its floating {left,top,right,bottom}, for undock

export function drawerEl(side) { return $(side === 'left' ? 'drawer-left' : 'drawer-right'); }

export function refreshDrawerDividers(side) {
  const dr = drawerEl(side);
  $$('.drawer-vresize', dr).forEach((d) => d.remove());
  // a docked-but-closed (×'d) panel stays a DOM child so re-opening it from
  // the toolbar still works, but it shouldn't hold the drawer open or get a
  // divider of its own
  const panels = [...dr.children].filter((c) => c.classList.contains('panel') && !c.hidden);
  panels.forEach((p, i) => {
    p.style.flex = '1 1 0';
    if (i > 0) {
      const div = document.createElement('div');
      div.className = 'drawer-vresize';
      dr.insertBefore(div, p);
      wireVResize(div, panels[i - 1], p);
    }
  });
  dr.hidden = panels.length === 0;
}

// Drag the divider between two stacked panels. Snapshot every visible panel at
// its current pixel height first, then move height only between the two panels
// adjacent to the handle; otherwise flexbox redistributes the delta across all
// docked panels in the drawer when there are three or more.
export function wireVResize(div, panelA, panelB) {
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const panels = [...div.parentElement.children]
      .filter((c) => c.classList.contains('panel') && !c.hidden);
    panels.forEach((p) => {
      p.style.flex = `0 0 ${p.getBoundingClientRect().height}px`;
    });
    const startAH = panelA.getBoundingClientRect().height;
    const startBH = panelB.getBoundingClientRect().height;
    const totalH = startAH + startBH;
    const minH = Math.min(60, totalH / 2);
    const move = (ev) => {
      const ah = Math.max(minH, Math.min(totalH - minH, startAH + (ev.clientY - startY)));
      panelA.style.flex = `0 0 ${ah}px`;
      panelB.style.flex = `0 0 ${totalH - ah}px`;
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
}

export function wireDrawerWidthResize(side) {
  const dr = drawerEl(side);
  const handle = document.createElement('div');
  handle.className = 'drawer-resize';
  dr.appendChild(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = dr.getBoundingClientRect().width;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(160, Math.min(600, side === 'left' ? startW + dx : startW - dx));
      dr.style.width = `${w}px`;
      drawersState[side === 'left' ? 'widthLeft' : 'widthRight'] = w;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
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

// the docked panel (if any) just before which `p` should land, given a
// pointer y position — null means "append at the end"
const dndIndicator = document.createElement('div');
dndIndicator.id = 'dnd-indicator';
dndIndicator.hidden = true;

// appends the drag indicator and wires both drawers' width handles; called
// from main.ts at the point in startup where this used to run inline
export function initDrawers() {
  document.body.appendChild(dndIndicator);
  wireDrawerWidthResize('left');
  wireDrawerWidthResize('right');
}

// shows an insertion-line preview at the position `p` would land in `side`'s
// drawer for a drop at `clientY`, and returns the panel to insert before
// (null = append at the end). Note: dr.children always includes the
// permanent .drawer-resize width handle, so "empty" is judged by panel count.
export function showDropPreview(p, side, clientY) {
  const dr = drawerEl(side);
  dr.hidden = false; // reveal as a preview even if currently empty
  $$('.drawer.drop-target').forEach((d) => { if (d !== dr) d.classList.remove('drop-target'); });
  dr.classList.add('drop-target');
  const panels = [...dr.children].filter((c) => c.classList.contains('panel') && !c.hidden && c !== p);
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
  $$('.drawer.drop-target').forEach((d) => d.classList.remove('drop-target'));
}

export function dockPanelAt(p, side, beforeEl) {
  const oldSide = p.dataset.dockSide;
  if (!oldSide) {
    panelFloatRect.set(p, { left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom });
  }
  p.classList.add('docked');
  p.dataset.dockSide = side;
  p.hidden = false;
  drawerEl(side).insertBefore(p, beforeEl || null);
  // id-keyed bookkeeping is only for session persistence of the panels that
  // have a stable id — windows created dynamically at runtime have none, and
  // dock/reorder/undock fine without being tracked here
  if (oldSide && oldSide !== side && p.id) {
    const oldArr = drawersState[oldSide];
    const oi = oldArr.indexOf(p.id);
    if (oi >= 0) oldArr.splice(oi, 1);
  }
  if (p.id) {
    // rebuild from actual DOM order: correct for both a fresh dock and a
    // same-drawer reorder, no manual index bookkeeping needed
    drawersState[side] = [...drawerEl(side).children]
      .filter((c) => c.classList.contains('panel') && c.id)
      .map((c) => c.id);
  }
  refreshDrawerDividers(side);
  if (oldSide && oldSide !== side) refreshDrawerDividers(oldSide);
}

export function dockPanel(p, side) {
  dockPanelAt(p, side, null);
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
  if (p.id) {
    const arr = drawersState[side === 'left' ? 'left' : 'right'];
    const i = arr.indexOf(p.id);
    if (i >= 0) arr.splice(i, 1);
  }
  refreshDrawerDividers(side);
  raisePanel(p);
}

// re-dock panels and restore drawer width/visibility from a saved session
export function applyDrawersState(d) {
  if (!d) return;
  // in-place reset: same fields the old `UI.drawers = {…}` assigned, but the
  // object identity is stable (see drawersState)
  drawersState.left = [];
  drawersState.right = [];
  drawersState.widthLeft = d.widthLeft || 300;
  drawersState.widthRight = d.widthRight || 300;
  drawerEl('left').style.width = `${drawersState.widthLeft}px`;
  drawerEl('right').style.width = `${drawersState.widthRight}px`;
  // dockPanel pushes into drawersState.left/right itself and shows the drawer
  // (via refreshDrawerDividers) as soon as it has content
  (d.left || []).forEach((id) => { if ($(id)) dockPanel($(id), 'left'); });
  (d.right || []).forEach((id) => { if ($(id)) dockPanel($(id), 'right'); });
}

// the shell's own panel-window factory, bound to this drawer implementation
// so callers don't have to assemble the dock API at each call site
export const dock = {
  undockPanel, dropSideAt, refreshDrawerDividers, showDropPreview, clearDropPreview, dockPanelAt,
};
