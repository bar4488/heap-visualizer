// Shell: panels as draggable windows: drag by the header, and keep a z-stack
// where the last panel opened or dragged sits on top.
//
// Nothing here knows what a panel contains. The drag path can end in a dock,
// which is drawers.js's job — passed in as `dock` rather than imported, so
// panels.ts and drawers.ts never form an import cycle.

// Every window lives in one z band, below every overlay (tooltip 50, selection
// popover 60, progress/drop 100, search 110, welcome 140 — see style.css).
// The stack is renormalized on every raise rather than counted upward, so no
// number of clicks can carry a window above the overlays. A drag is drawn at
// the band's very top, with the drop preview just beneath it.
export const WINDOW_Z_BASE = 10;
export const WINDOW_Z_MAX = 45; // .panel.dragging is 48, the drop preview 46/47

const stack = []; // bottom -> top; windows that left the document are pruned

/** The z-index for the window at `index` in a stack of any length. */
export function windowZ(index) {
  return Math.min(WINDOW_Z_MAX, WINDOW_Z_BASE + index);
}

export function raisePanel(p) {
  const i = stack.indexOf(p);
  if (i >= 0) stack.splice(i, 1);
  stack.push(p);
  for (let j = stack.length - 1; j >= 0; j--) {
    if (!stack[j].parentElement) stack.splice(j, 1);
  }
  stack.forEach((el, j) => {
    const z = String(windowZ(j));
    if (el.style.zIndex !== z) el.style.zIndex = z;
  });
}

// how far a floating window may leave the viewport: its header must stay
// grabbable, so at least this much of it stays on screen horizontally, and
// its top edge stays within the viewport
const KEEP_X = 60;
const KEEP_Y = 40;

/**
 * Clamp a floating window's top-left so its header stays reachable in a
 * `vw` × `vh` viewport. `width` is the window's rendered width, or 0 when it
 * is not known (a closed window), in which case its left edge is kept on
 * screen.
 */
export function clampWindowPosition(left, top, width, vw, vh) {
  const minX = width > 0 ? Math.min(0, KEEP_X - width) + 4 : 0;
  const maxX = Math.max(minX, vw - KEEP_X);
  const maxY = Math.max(0, vh - KEEP_Y);
  return {
    left: Math.min(maxX, Math.max(minX, left)),
    top: Math.min(maxY, Math.max(0, top)),
  };
}

/**
 * Pull a floating window back on screen if a restore or a viewport resize
 * left it unreachable. Only a window placed by explicit left/top px is
 * touched; one still at its stylesheet position is anchored to the viewport
 * already. A closed window is left alone — its width is not known until it is
 * shown, and opening one clamps it. Returns whether it moved.
 */
export function clampPanelToViewport(p) {
  if (p.hidden) return false;
  const left = parseFloat(p.style.left);
  const top = parseFloat(p.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
  const width = p.getBoundingClientRect().width;
  const c = clampWindowPosition(left, top, width, innerWidth, innerHeight);
  if (c.left === left && c.top === top) return false;
  p.style.left = `${c.left}px`;
  p.style.top = `${c.top}px`;
  p.style.right = 'auto';
  p.style.bottom = 'auto';
  return true;
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
    // where the window came from, so Escape can put it back
    const origin = {
      side: p.dataset.dockSide || null,
      next: dock.nextDockedSibling(p),
      left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom,
    };
    let moved = false;
    let dropSide = null;
    let dropRef = null;

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
      if (side) {
        dropSide = side;
        dropRef = dock.showDropPreview(p, side, ev.clientY);
      } else {
        dropSide = null;
        dock.clearDropPreview();
      }
    };
    // Escape mid-drag puts the window back exactly where it was picked up
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancelled = true;
      finish();
    };
    let finished = false;
    let cancelled = false;
    function finish() {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', key, true);
      if (head.hasPointerCapture?.(e.pointerId)) head.releasePointerCapture(e.pointerId);
      dock.clearDropPreview();
      p.classList.remove('dragging');
      if (cancelled) {
        if (!moved) return;
        // a docked window's own styles still hold its floating spot, so
        // restoring them first is also what re-docking records for undock
        p.style.left = origin.left; p.style.top = origin.top;
        p.style.right = origin.right; p.style.bottom = origin.bottom;
        if (origin.side) dock.dockPanelAt(p, origin.side, origin.next, false);
      } else if (moved && dropSide) {
        dock.dockPanelAt(p, dropSide, dropRef);
      }
      dock.refreshDrawerDividers('left');
      dock.refreshDrawerDividers('right');
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', key, true);
  });
}
