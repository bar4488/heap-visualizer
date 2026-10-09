// Shell: the panel API. The one door domain code uses to show, hide, place and
// persist windows. It owns every panel's visibility, its drawer bookkeeping,
// its placement on open, its toolbar toggle and close button, focus and
// Escape, and the layout part of the session — so a later layout engine (a
// split/tab tree, or a library) replaces what is behind this file and nothing
// in front of it.
//
// Domain code declares a panel *type* with `layout.register(type, spec)` and
// then speaks only in types and keys: `open`, `close`, `toggle`, `reveal`,
// `isOpen`, and `onOpen`/`onClose` hooks. It never writes `.hidden` or
// `dataset.dockSide` on a panel, and never refreshes a drawer.
//
// A type is a singleton (one element, which `build` returns — usually one
// already in index.html) or multi-instance (`build(key, data)` makes a fresh
// element per key, and `close` removes it). Instances are addressed by
// `type + key`; a singleton's key is ignored. The instance id — the type, or
// `type:key` — is what the drawer order and heights persist under.
//
// Still domain-agnostic: no panel is named here.

import { $ } from './dom.ts';
import {
  raisePanel, makePanelWindow, clampPanelToViewport,
} from './panels.ts';
import {
  dock, drawerEl, dockPanelAt, dockRestored, undockPanel, refreshDrawerDividers, applyDrawersState,
  snapshotDrawers, applyDrawerWidths, drawersState, setDrawerCollapsed, isDrawerCollapsed,
  DRAWER_DEFAULT_WIDTH, type Side,
} from './drawers.ts';

export type Placement = { dock: Side | null; open: boolean };

/** A floating position, as numbers (px) or as the CSS strings a session stored. */
export type At = { left?: number | string; top?: number | string; right?: number | string; bottom?: number | string };

export type PanelSpec = {
  title: string;
  /** One element for the type (default), or one per key. */
  singleton?: boolean;
  /** Where it starts, and whether it starts open (SHELL-008). A function is read each time it is applied. */
  defaultLocation?: Placement | (() => Placement);
  /** The element for an instance: the existing element for a singleton, a new one per key otherwise. */
  build: (key: string, data?: any) => any;
  /** Whether its open state and geometry are part of the session's `windows` (default: singletons). */
  persist?: boolean;
  /** The toolbar button that toggles it, or null. */
  toggle?: string | null;
  /**
   * Place it in the free workspace beside the drawers when it opens floating,
   * cascading past open windows of the `avoid` types.
   */
  autoPlace?: { avoid?: string[] } | null;
  onOpen?: (key: string, el: any) => void;
  onClose?: (key: string, el: any) => void;
};

export type OpenOptions = {
  /** Move keyboard focus into the window (and back to the opener when it closes). */
  focus?: boolean;
  /** Passed to `build` when this opens a new multi-instance window. */
  data?: any;
  /** Float it at this position. */
  at?: At;
  /** Ignore its last floating position and auto-place it from scratch. */
  freshPosition?: boolean;
  /** Dock it in a drawer (or float it with null) as it opens. */
  dock?: Side | null;
  /** Docking replays a restored session: keep the saved slot and collapsed state. */
  restoring?: boolean;
};

type Registered = PanelSpec & { singleton: boolean; persist: boolean };
type Instance = { type: string; key: string; id: string; el: any };

const types = new Map<string, Registered>();
const instances = new Map<string, Instance>(); // by instance id, in creation order
const openHooks = new Map<string, ((key: string, el: any) => void)[]>();
const closeHooks = new Map<string, ((key: string, el: any) => void)[]>();
const openers = new Map<string, any>(); // instance id -> element focus returns to

const instanceId = (t: Registered, type: string, key: string) => (t.singleton ? type : `${type}:${key}`);

function spec(type: string): Registered {
  const t = types.get(type);
  if (!t) throw new Error(`no such panel type: ${type}`);
  return t;
}

function find(type: string, key = ''): Instance | null {
  return instances.get(instanceId(spec(type), type, key)) || null;
}

function defaultsOf(t: Registered): Placement {
  const d = typeof t.defaultLocation === 'function' ? t.defaultLocation() : t.defaultLocation;
  return { dock: d?.dock ?? null, open: !!d?.open };
}

function hooks(map, type) {
  if (!map.has(type)) map.set(type, []);
  return map.get(type);
}

function syncToggle(type: string) {
  const t = types.get(type);
  if (!t?.toggle) return;
  const btn = $(t.toggle);
  if (btn) btn.setAttribute('aria-pressed', String(isOpen(type)));
}

let titleSeq = 0;

// Everything a window gets from the shell, once, when it becomes an instance.
function adopt(type: string, t: Registered, key: string, el: any): Instance {
  const id = instanceId(t, type, key);
  el.dataset.instance = id;
  el.dataset.panelType = type;
  if (!el.classList.contains('panel')) el.classList.add('panel');
  const head = el.querySelector('.panel-head');
  const titleEl = el.querySelector('.ph-t');
  if (titleEl && t.singleton) titleEl.textContent = t.title;
  if (titleEl) {
    if (!titleEl.id) titleEl.id = `panel-title-${++titleSeq}`;
    el.setAttribute('aria-labelledby', titleEl.id);
  }
  el.setAttribute('role', 'region');
  el.setAttribute('tabindex', '-1');
  const close = head?.querySelector('.panel-close');
  if (close) {
    close.setAttribute('aria-label', `Close ${t.title}`);
    close.onclick = () => closeInstance(instances.get(id));
  }
  // Escape closes the window that has focus — unless something inside it
  // (a completion list, an open menu) already used the key
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    closeInstance(instances.get(id));
  });
  if (head) makePanelWindow(el, dock);
  const inst = { type, key, id, el };
  instances.set(id, inst);
  return inst;
}

/** Declare a panel type. A singleton's element is adopted immediately. */
function register(type: string, s: PanelSpec) {
  if (types.has(type)) throw new Error(`panel type registered twice: ${type}`);
  const singleton = s.singleton !== false;
  const t: Registered = { ...s, singleton, persist: s.persist ?? singleton };
  types.set(type, t);
  if (s.onOpen) hooks(openHooks, type).push(s.onOpen);
  if (s.onClose) hooks(closeHooks, type).push(s.onClose);
  if (singleton) {
    const el = s.build(type);
    if (!el) throw new Error(`panel type ${type} built no element`);
    adopt(type, t, type, el);
  }
  if (t.toggle) {
    const btn = $(t.toggle);
    if (singleton) btn.setAttribute('aria-controls', type);
    btn.onclick = () => toggle(type, '', { focus: true });
    syncToggle(type);
  }
}

function hasManualPosition(el) {
  return !!(el.style.left || el.style.top || el.style.right || el.style.bottom);
}

function px(v) { return typeof v === 'number' ? `${v}px` : v; }

function setAt(el, at: At) {
  el.style.left = px(at.left ?? '');
  el.style.top = px(at.top ?? '');
  el.style.right = at.right === undefined ? 'auto' : px(at.right);
  el.style.bottom = at.bottom === undefined ? 'auto' : px(at.bottom);
}

// Keep a window that opens floating in the usable workspace beside any open
// drawer. `reset` starts it from its stylesheet spot; either way it then
// cascades up-right past open windows of the `avoid` types sitting there.
function placeInWorkspace(el, reset: boolean, avoid: string[]) {
  if (reset) {
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
  }
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  const gap = 10;
  const leftDr = drawerEl('left');
  const rightDr = drawerEl('right');
  let minX = gap;
  let maxX = Math.max(gap, innerWidth - r.width - gap);
  if (!leftDr.hidden) minX = Math.max(minX, leftDr.getBoundingClientRect().right + gap);
  if (!rightDr.hidden) maxX = Math.min(maxX, rightDr.getBoundingClientRect().left - r.width - gap);
  if (maxX < minX) {
    // Very narrow layouts may not have enough room between two drawers; keep
    // the window visible and prefer the space nearest the left drawer.
    const visibleMax = Math.max(gap, innerWidth - r.width - gap);
    minX = Math.min(minX, visibleMax);
    maxX = visibleMax;
  }
  const clampX = (v) => Math.min(maxX, Math.max(minX, v));
  const nx = clampX(x);
  let moved = Math.abs(nx - x) > 0.5;
  x = nx;
  const others = [...instances.values()]
    .filter((i) => avoid.includes(i.type) && i.el !== el && !i.el.hidden && !i.el.dataset.dockSide)
    .map((i) => i.el.getBoundingClientRect());
  const clash = () => others.some((p) => Math.abs(p.left - x) < 48 && Math.abs(p.top - y) < 48);
  while (clash() && y > 40) {
    x = clampX(x + 28);
    y -= 28;
    moved = true;
  }
  if (moved) setAt(el, { left: x, top: y });
}

/** Show a window (creating a multi-instance one), and bring it to the front. */
function open(type: string, key = '', opts: OpenOptions = {}) {
  const t = spec(type);
  let inst = find(type, key);
  if (!inst) {
    if (t.singleton) throw new Error(`panel type ${type} has no element`);
    const el = t.build(key, opts.data);
    el.hidden = true;
    if (!el.parentElement) document.body.appendChild(el);
    inst = adopt(type, t, key, el);
  }
  const { el } = inst;
  const wasOpen = !el.hidden;
  if (opts.focus && !wasOpen) {
    const active = document.activeElement;
    if (active && !el.contains(active)) openers.set(inst.id, active);
  }
  el.hidden = false;
  if (opts.dock !== undefined && opts.dock !== (el.dataset.dockSide || null)) {
    if (!opts.dock) {
      undockPanel(el);
    } else if (opts.restoring) {
      if (opts.at) setAt(el, opts.at);
      dockRestored(el, opts.dock);
    } else {
      dockPanelAt(el, opts.dock, null);
    }
  }
  const side = el.dataset.dockSide;
  if (side) {
    refreshDrawerDividers(side);
  } else {
    if (opts.at) setAt(el, opts.at);
    if (t.autoPlace && (!wasOpen || opts.at)) {
      placeInWorkspace(el, !opts.at && (!!opts.freshPosition || !hasManualPosition(el)), t.autoPlace.avoid || []);
    }
    clampPanelToViewport(el);
  }
  raisePanel(el);
  syncToggle(type);
  if (opts.focus) el.focus?.({ preventScroll: true });
  if (!wasOpen) for (const fn of openHooks.get(type) || []) fn(inst.key, el);
  return el;
}

function closeInstance(inst: Instance | null | undefined) {
  if (!inst) return;
  const { el, type } = inst;
  const t = spec(type);
  if (t.singleton && el.hidden) return;
  const active = document.activeElement;
  const hadFocus = !!active && el.contains(active);
  const side = el.dataset.dockSide;
  if (t.singleton) {
    el.hidden = true;
    if (side) refreshDrawerDividers(side);
  } else {
    if (side) undockPanel(el);
    el.remove();
    instances.delete(inst.id);
  }
  syncToggle(type);
  for (const fn of closeHooks.get(type) || []) fn(inst.key, el);
  const opener = openers.get(inst.id);
  openers.delete(inst.id);
  if (hadFocus && opener && opener.isConnected !== false) opener.focus?.({ preventScroll: true });
}

/** Hide a window; a multi-instance one is removed. */
function close(type: string, key = '') {
  closeInstance(find(type, key));
}

function isOpen(type: string, key = '') {
  const inst = find(type, key);
  return !!inst && !inst.el.hidden;
}

function toggle(type: string, key = '', opts: OpenOptions = {}) {
  if (isOpen(type, key)) close(type, key);
  else open(type, key, opts);
}

/** Open it and make sure it can be seen: a collapsed drawer holding it expands. */
function reveal(type: string, key = '', opts: OpenOptions = {}) {
  const el = open(type, key, opts);
  const side = el.dataset.dockSide;
  if (side && isDrawerCollapsed(side)) setDrawerCollapsed(side, false);
  return el;
}

/** A window's element, or null when that instance does not exist. */
function element(type: string, key = '') {
  return find(type, key)?.el || null;
}

/** The live instances of a type, in creation order. */
function instancesOf(type: string) {
  return [...instances.values()].filter((i) => i.type === type).map(({ key, el }) => ({ key, el }));
}

/** Where an instance is: docked side (or null) and its floating geometry. */
function location(type: string, key = '') {
  const el = element(type, key);
  if (!el) return null;
  return {
    dock: (el.dataset.dockSide || null) as Side | null,
    open: !el.hidden,
    left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom,
  };
}

function closeAll(type: string) {
  for (const { key } of instancesOf(type)) close(type, key);
}

function onOpen(type: string, fn: (key: string, el: any) => void) { hooks(openHooks, type).push(fn); }
function onClose(type: string, fn: (key: string, el: any) => void) { hooks(closeHooks, type).push(fn); }

/**
 * Put every window back where the declarations say (SHELL-008): docked ones
 * in their drawer in registration order, floating ones at their stylesheet
 * spot, drawers at the default width, heights even, nothing collapsed. A
 * persisted window's open state goes back to its default; a transient one
 * (an allocation or event window) keeps its open state and is only moved.
 *
 * `keepFloating` leaves floating windows where they are — the default layout
 * a newly loaded trace starts from, as opposed to the user's Reset layout.
 */
function resetLayout({ keepFloating = false } = {}) {
  const changed = [];
  for (const inst of instances.values()) {
    const t = spec(inst.type);
    if (inst.el.dataset.dockSide) undockPanel(inst.el);
    // (undocking restored its floating spot; re-docking below records the
    // cleared one, so a later undock lands at the stylesheet spot too)
    if (t.singleton && !keepFloating) setAt(inst.el, { left: '', top: '', right: '', bottom: '' });
    if (t.persist) setOpenQuietly(inst, defaultsOf(t).open, changed);
  }
  drawersState.sizes = {};
  drawersState.widthLeft = DRAWER_DEFAULT_WIDTH;
  drawersState.widthRight = DRAWER_DEFAULT_WIDTH;
  const defaults = { left: [], right: [] };
  for (const [type, t] of types) {
    if (!t.singleton) continue;
    const side = defaultsOf(t).dock;
    if (side) defaults[side].push(type);
  }
  applyDrawersState({
    ...defaults,
    widthLeft: DRAWER_DEFAULT_WIDTH,
    widthRight: DRAWER_DEFAULT_WIDTH,
    collapsedLeft: false,
    collapsedRight: false,
  });
  for (const inst of instances.values()) {
    if (!inst.el.dataset.dockSide) clampPanelToViewport(inst.el);
  }
  for (const type of types.keys()) syncToggle(type);
  runHooks(changed);
}

// A wholesale layout change (reset, restore) flips many windows at once: set
// them all first, and run their hooks once the whole layout is in place, so a
// hook that measures its window sees where it actually ended up.
function setOpenQuietly(inst: Instance, on: boolean, changed: Instance[]) {
  if (!inst.el.hidden === on) return;
  inst.el.hidden = !on;
  changed.push(inst);
}

function runHooks(changed: Instance[]) {
  for (const inst of changed) {
    const map = inst.el.hidden ? closeHooks : openHooks;
    for (const fn of map.get(inst.type) || []) fn(inst.key, inst.el);
  }
}

/** The shell's half of the session: `windows` (persisted types) and `drawers`. */
function serialize() {
  const windows = {};
  for (const [type, t] of types) {
    if (!t.persist || !t.singleton) continue;
    const p = find(type).el;
    windows[type] = {
      hidden: p.hidden, left: p.style.left, top: p.style.top, right: p.style.right, bottom: p.style.bottom,
    };
  }
  return { windows, drawers: snapshotDrawers() };
}

// windows whose open state a restoreWindows changed, for restoreDrawers to
// run hooks on once the drawers are in place too
let restoredChanges: Instance[] = [];

/**
 * Open state and floating geometry of the persisted windows, from a session.
 * The drawers are refreshed, and the hooks run, by restoreDrawers, which a
 * restore always calls after this (the session applies view settings in
 * between, before anything resizes the canvases).
 */
function restoreWindows(windows) {
  if (!windows || typeof windows !== 'object') return;
  for (const [type, t] of types) {
    if (!t.persist || !t.singleton) continue;
    const w = windows[type];
    const inst = find(type);
    if (!w || !inst) continue;
    setOpenQuietly(inst, !w.hidden, restoredChanges);
    if (w.left) setAt(inst.el, { left: w.left, top: w.top, right: w.right, bottom: w.bottom });
  }
  for (const type of types.keys()) syncToggle(type);
}

/** Docking, order, widths, heights and collapse, from a session. */
function restoreDrawers(drawers) {
  applyDrawersState(drawers);
  // with no drawer section to apply, windows shown or hidden by
  // restoreWindows still need their drawers brought up to date
  refreshDrawerDividers('left');
  refreshDrawerDividers('right');
  clampFloating();
  const changed = restoredChanges;
  restoredChanges = [];
  runHooks(changed);
}

function restore(snapshot) {
  if (!snapshot) return;
  restoreWindows(snapshot.windows);
  restoreDrawers(snapshot.drawers);
}

/** Pull every floating window back on screen, and the drawers within the viewport. */
function clampFloating() {
  applyDrawerWidths();
  for (const inst of instances.values()) {
    if (!inst.el.dataset.dockSide) clampPanelToViewport(inst.el);
  }
}

let resizeFrame = 0;

/** Viewport-resize handling; call once at startup. */
function init() {
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      clampFloating();
    });
  });
}

export const layout = {
  register, open, close, toggle, reveal, isOpen, element, instancesOf, location, closeAll,
  onOpen, onClose, resetLayout, serialize, restore, restoreWindows, restoreDrawers, clampFloating, init,
};
