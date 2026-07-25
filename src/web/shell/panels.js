// Shell: panels as draggable windows: drag by the header, and keep a z-stack
// where the last panel opened or dragged sits on top.
//
// Nothing here knows what a panel contains. The drag path can end in a dock,
// which is drawers.js's job — passed in as `dock` rather than imported, so
// panels.js and drawers.js never form an import cycle.

import { $ } from './dom.js';

let panelZ = 40;

export function raisePanel(p) {
  p.style.zIndex = ++panelZ;
}

export function showPanel(id) {
  const p = $(id);
  p.hidden = false;
  raisePanel(p);
}

export function makePanelWindow(p, dock) {
  // any interaction with a window brings it to the front
  p.addEventListener('pointerdown', () => raisePanel(p));
  const head = p.querySelector('.panel-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // header buttons/inputs (close, save, follow…) still work normally
    if (e.target.closest('button, input, select, a')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const r = p.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let moved = false;
    let dropSide = null;
    let dropRef = null;
    let zoneSide = null; // last side reported by dropSideAt, for edge-transition detection

    const floatTo = (ev) => {
      p.style.left = `${Math.min(innerWidth - 60, Math.max(4 - r.width + 60, ev.clientX - dx))}px`;
      p.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    };
    const move = (ev) => {
      if ((ev.buttons & 1) === 0) {
        finish();
        return;
      }
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        // pick up immediately: a docked panel pops out of its drawer the
        // instant a drag starts (rather than only on drop), so it's always
        // obviously "in your hand" and never looks stuck mid-drag — it only
        // re-docks if actually dropped on a drawer, below
        if (p.classList.contains('docked')) dock.undockPanel(p);
        p.classList.add('dragging');
      }
      // keep the window tracking the cursor continuously, even while
      // hovering a drop zone — it used to freeze there, which read as stuck
      floatTo(ev);
      const side = dock.dropSideAt(ev.clientX);
      // refreshDrawerDividers rebuilds divider elements (and their pointer
      // listeners) from scratch — only run it on an actual zone change, not
      // every pointermove tick, or it visibly stutters the drag
      if (side !== zoneSide) {
        if (zoneSide) dock.refreshDrawerDividers(zoneSide);
        zoneSide = side;
      }
      if (side) {
        dropSide = side;
        dropRef = dock.showDropPreview(p, side, ev.clientY);
      } else {
        dropSide = null;
        dock.clearDropPreview();
      }
    };
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (head.hasPointerCapture?.(e.pointerId)) head.releasePointerCapture(e.pointerId);
      dock.clearDropPreview();
      p.classList.remove('dragging');
      if (moved && dropSide) dock.dockPanelAt(p, dropSide, dropRef);
      // normalizes hidden state for whichever drawer(s) were touched, and is
      // a harmless no-op for any that weren't
      dock.refreshDrawerDividers('left');
      dock.refreshDrawerDividers('right');
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });
}
