// Shell: the panel API. The one door domain code uses to show, hide, place and
// persist windows. It owns every panel's visibility, its placement on open,
// its toolbar toggle and close button, focus and Escape, and the layout part
// of the session. Behind it is Dockview (dockview-core, D014): a grid of
// split/tabbed groups in the center, an edge group on the left, right and
// bottom, and floating groups. Domain code never sees the engine.
//
// Domain code declares a panel *type* with `layout.register(type, spec)` and
// then speaks only in types and keys: `open`, `close`, `toggle`, `reveal`,
// `isOpen`, and `onOpen`/`onClose` hooks. It never writes `.hidden` on a panel
// and never touches a dock group.
//
// A type is a singleton (one element, which `build` returns — usually one
// already in index.html) or multi-instance (`build(key, data)` makes a fresh
// element per key, and `close` removes it). Instances are addressed by
// `type + key`; a singleton's key is ignored. The instance id — the type, or
// `type:key` — is the dock panel id, so it is what the session persists.
//
// Elements are long-lived and adopted, never created by the engine: the views'
// canvases are transferred to the worker once at boot, and the rest of the
// app finds controls with `document.getElementById`. A dock panel's content
// is a wrapper the element is moved into; when the panel goes away the
// element goes back to a hidden parking lot in the document, so a closed
// window's controls still exist. A parked element is `hidden`; an adopted one
// is not. No popout windows: they would take elements out of this document.
//
// Still domain-agnostic: no panel is named here.

import type { DockviewApi } from 'dockview-core';
import { $ } from './dom.ts';
import {
  EDGES, defaultPlan, legacyPlan, type Edge, type Home, type Plan, type TypeInfo,
} from './layout-plan.ts';

export type { Edge, Home } from './layout-plan.ts';

export type Placement = { dock: Home; open: boolean };

/** A floating position in viewport px (numbers, or the CSS strings an old session stored). */
export type At = { left?: number | string; top?: number | string; right?: number | string; bottom?: number | string };

export type PanelSpec = {
  title: string;
  /** One element for the type (default), or one per key. */
  singleton?: boolean;
  /** Where it starts, and whether it starts open (SHELL-008). A function is read each time it is applied. */
  defaultLocation?: Placement | (() => Placement);
  /** The element for an instance: the existing element for a singleton, a new one per key otherwise. */
  build: (key: string, data?: any) => any;
  /** Whether a restored session decides its open state and place (default: singletons). */
  persist?: boolean;
  /** Whether the user can close it (default true). A view that must always exist is not. */
  closable?: boolean;
  /** The toolbar (or menu) button that toggles it, or null. */
  toggle?: string | null;
  /** Its height when it starts stacked in the center (px). */
  size?: number;
  /** Its size when it floats (px). */
  floatSize?: { width: number; height: number };
  /** Float it at the workspace's bottom-left, cascading past open windows of the `avoid` types. */
  autoPlace?: { avoid?: string[] } | null;
  onOpen?: (key: string, el: any) => void;
  onClose?: (key: string, el: any) => void;
};

export type OpenOptions = {
  /** Move keyboard focus into the window (and back to the opener when it closes). */
  focus?: boolean;
  /** Passed to `build` when this opens a new multi-instance window. */
  data?: any;
  /** Float it at this viewport position. */
  at?: At;
  /** Ignore where it last was and place it from scratch. */
  freshPosition?: boolean;
  /** Put it in this edge group, the center, or floating (null). */
  dock?: Home;
  /** Put it where another window is or was (`placeOf`): pin and unpin swap a window in place. */
  place?: Place | null;
  /** Recreating a window a session restored: take its saved slot, change no collapse state. */
  restoring?: boolean;
};

/** The engine factory and theme; main.ts passes dockview-core's, tests a stand-in. */
export type Engine = {
  createDockview: (host: any, options: any) => DockviewApi;
  theme?: any;
};

type Registered = PanelSpec & { singleton: boolean; persist: boolean; closable: boolean };
type Instance = { type: string; key: string; id: string; el: any; open: boolean; seen: boolean };
/** Where a window is or was, so it reopens there; opaque to domain code. */
export type Place = Slot;
type Slot = { edge: Edge } | { center: true } | { group: string } | { float: { left: number; top: number; width: number; height: number } };

const EDGE_SIZE: Record<Edge, number> = { left: 300, right: 300, bottom: 240 };
const FLOAT_SIZE = { width: 340, height: 320 };
const edgeGroupId = (e: Edge) => `edge-${e}`;

const types = new Map<string, Registered>();
const instances = new Map<string, Instance>(); // by instance id, in creation order
const openHooks = new Map<string, ((key: string, el: any) => void)[]>();
const closeHooks = new Map<string, ((key: string, el: any) => void)[]>();
const openers = new Map<string, any>(); // instance id -> element focus returns to
const slots = new Map<string, Slot>(); // instance id -> where it last was
const placeholders = new Map<string, Adopt>(); // saved panels whose window is not back yet

let api: any = null; // DockviewApi; loosely typed so tests can stand in a fake
let host: any = null;
let parking: any = null;
let batch = 0; // >0 while the shell itself rearranges the dock
let syncQueued = false;
let dragging = false;
const edgeWasEmpty: Record<Edge, boolean> = { left: true, right: true, bottom: true };

const instanceId = (t: Registered, type: string, key: string) => (t.singleton ? type : `${type}:${key}`);

function spec(type: string): Registered {
  const t = types.get(type);
  if (!t) throw new Error(`no such panel type: ${type}`);
  return t;
}

function engine() {
  if (!api) throw new Error('layout.init has not been called');
  return api;
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

// ---------------------------------------------------------------------------
// adopting elements

function parkingLot() {
  if (!parking) {
    parking = document.createElement('div');
    parking.id = 'dock-parking';
    parking.hidden = true;
    document.body.appendChild(parking);
  }
  return parking;
}

function park(el) {
  el.hidden = true;
  if (el.parentElement !== parkingLot()) parkingLot().appendChild(el);
}

// The dock's content renderer. It adopts the instance's element rather than
// creating one; with no instance yet (a pinned window a session saved, whose
// content is a worker round-trip away) it is a placeholder holding the slot.
class Adopt {
  readonly element: any;
  readonly id: string;
  inst: Instance | null = null;
  private subs: { dispose(): void }[] = [];

  constructor(id: string) {
    this.id = id;
    this.element = document.createElement('div');
    this.element.className = 'dock-adopt';
    const inst = instances.get(id);
    if (inst) this.take(inst);
    else placeholders.set(id, this);
  }

  take(inst: Instance) {
    this.inst = inst;
    placeholders.delete(this.id);
    this.element.appendChild(inst.el);
    inst.el.hidden = false;
  }

  init(params) {
    const sub = params?.api?.onDidVisibilityChange?.((e) => {
      if (e.isVisible && this.inst) later();
    });
    if (sub) this.subs.push(sub);
  }

  dispose() {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    if (!this.inst) {
      if (placeholders.get(this.id) === this) placeholders.delete(this.id);
      return;
    }
    if (this.inst.el.parentElement === this.element) park(this.inst.el);
  }
}

// A tab with no close button, for a view that must always exist.
class FixedTab {
  readonly element: any;
  private content: any;
  private sub: { dispose(): void } | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'dv-default-tab';
    this.content = document.createElement('div');
    this.content.className = 'dv-default-tab-content';
    this.element.appendChild(this.content);
  }

  init(params) {
    this.content.textContent = params.title || '';
    this.sub = params.api?.onDidTitleChange?.((e) => { this.content.textContent = e.title; }) || null;
  }

  dispose() { this.sub?.dispose(); }
}

let titleSeq = 0;

// Everything a window gets from the shell, once, when it becomes an instance.
function adopt(type: string, t: Registered, key: string, el: any): Instance {
  const id = instanceId(t, type, key);
  el.dataset.instance = id;
  el.dataset.panelType = type;
  const inst: Instance = { type, key, id, el, open: false, seen: false };
  instances.set(id, inst);
  // a window (as opposed to a view) is a labelled region that Escape closes
  if (el.classList.contains('panel')) {
    const head = el.querySelector('.panel-head');
    const titleEl = el.querySelector('.ph-t');
    if (titleEl && t.singleton) titleEl.textContent = t.title;
    if (titleEl) {
      if (!titleEl.id) titleEl.id = `panel-title-${++titleSeq}`;
      el.setAttribute('aria-labelledby', titleEl.id);
      // the tab shows the title; a window that retitles itself (the
      // allocation window names its allocation) retitles its tab
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(() => {
          engineOrNull()?.getPanel(id)?.api.setTitle(titleOf(inst));
        }).observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
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
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !t.closable) return;
      e.preventDefault();
      e.stopPropagation();
      closeInstance(instances.get(id));
    });
  }
  park(el);
  return inst;
}

function engineOrNull() { return api; }

function titleOf(inst: Instance) {
  return inst.el.querySelector?.('.ph-t')?.textContent || spec(inst.type).title;
}

function titleFor(id: string, type: string) {
  const inst = instances.get(id);
  return inst ? titleOf(inst) : spec(type).title;
}

/** Declare a panel type. A singleton's element is adopted (and parked) immediately. */
function register(type: string, s: PanelSpec) {
  if (types.has(type)) throw new Error(`panel type registered twice: ${type}`);
  const singleton = s.singleton !== false;
  const t: Registered = { ...s, singleton, persist: s.persist ?? singleton, closable: s.closable !== false };
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

// ---------------------------------------------------------------------------
// the engine

/**
 * Create the dock in `host` (once, at startup, after nothing else has to be
 * registered first — types can be registered before or after). The edge
 * groups always exist; an empty one is hidden, and shown as a drop target
 * while a panel is dragged.
 */
function init(hostEl: any, eng: Engine) {
  host = hostEl;
  api = eng.createDockview(hostEl, {
    theme: eng.theme,
    defaultRenderer: 'always',
    // (no popouts: a window's controls are found by id, and a popout would
    // move them into another document — so no 'popout' in the tab menu)
    floatingGroupBounds: 'boundedWithinViewport',
    // the map, last in the center column, takes the room a resize adds
    proportionalLayout: false,
    createComponent: (o) => new Adopt(o.id),
    createTabComponent: (o) => (o.name === 'fixed' ? new FixedTab() : undefined),
    createRightHeaderActionComponent: (group) => new GroupActions(group),
    getTabContextMenuItems: (p) => {
      const id = p?.panel?.id;
      const inst = id ? instances.get(id) : null;
      const closable = !inst || spec(inst.type).closable;
      return closable ? ['float', 'maximize', 'separator', 'close'] : ['float', 'maximize'];
    },
  });
  for (const e of EDGES) {
    const g = api.addEdgeGroup(e, { id: edgeGroupId(e), initialSize: EDGE_SIZE[e], collapsed: true });
    g.onDidCollapsedChange?.(later);
    api.setEdgeGroupVisible(e, false);
  }
  bottomTabsOnTop();
  api.onDidAddPanel(later);
  api.onDidRemovePanel(later);
  api.onDidLayoutChange?.(later);
  // while a panel is in hand, an empty edge shows as a strip to drop it on
  const startDrag = () => {
    dragging = true;
    syncEdges();
  };
  api.onWillDragPanel?.(startDrag);
  api.onWillDragGroup?.(startDrag);
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    setTimeout(sync, 0);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('dragend', endDrag, true);
    window.addEventListener('drop', endDrag, true);
    window.addEventListener('pointerup', endDrag, true);
  }
  sync();
  return api;
}

// The buttons at the end of a group's tab strip: collapse/expand on an edge
// group, maximize/restore on a grid group.
class GroupActions {
  readonly element: any;
  private group: any;
  private subs: { dispose(): void }[] = [];

  constructor(group) {
    this.group = group;
    this.element = document.createElement('div');
    this.element.className = 'dock-actions';
  }

  init(params) {
    const g = params?.group || this.group;
    this.group = g;
    const render = () => this.render();
    for (const ev of [g.api.onDidLocationChange, g.api.onDidCollapsedChange, api?.onDidMaximizedGroupChange]) {
      const s = ev?.(render);
      if (s) this.subs.push(s);
    }
    render();
  }

  render() {
    const g = this.group;
    const loc = g.api.location;
    this.element.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dock-action';
    if (loc.type === 'edge') {
      const collapsed = g.api.isCollapsed();
      const side = loc.position as Edge;
      const name = side === 'bottom' ? 'bottom dock' : `${side} dock`;
      btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${name}`);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? 'Expand' : 'Collapse';
      const glyph = { left: ['›', '‹'], right: ['‹', '›'], bottom: ['˄', '˅'] }[side] || ['+', '−'];
      btn.textContent = collapsed ? glyph[0] : glyph[1];
      btn.onclick = () => setEdgeCollapsed(side, !g.api.isCollapsed());
    } else if (loc.type === 'grid') {
      const max = g.api.isMaximized();
      btn.setAttribute('aria-label', max ? 'Restore group' : 'Maximize group');
      btn.setAttribute('aria-pressed', String(max));
      btn.title = max ? 'Restore' : 'Maximize';
      btn.textContent = max ? '⤡' : '⤢';
      btn.onclick = () => (g.api.isMaximized() ? g.api.exitMaximized() : g.api.maximize());
    } else {
      return;
    }
    this.element.appendChild(btn);
  }

  dispose() {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }
}

function edgeGroup(e: Edge) {
  return api.getGroup(edgeGroupId(e));
}

// The engine puts an edge group's tab strip on that edge's side, so the
// bottom group's tabs would sit under its content. Every other group reads
// top-down; so does this one. Applied at creation and after a restore, which
// may carry the engine's side placement in an older saved layout.
function bottomTabsOnTop() {
  const g = edgeGroup('bottom');
  if (g?.api?.getHeaderPosition?.() !== 'top') g?.api?.setHeaderPosition?.('top');
}

function edgeCount(e: Edge) {
  return edgeGroup(e)?.panels.length || 0;
}

function setEdgeCollapsed(e: Edge, collapsed: boolean) {
  const g = edgeGroup(e);
  if (!g || g.api.isCollapsed() === collapsed) return;
  if (collapsed) g.api.collapse();
  else g.api.expand();
  // its windows come into sight or go out of it
  sync();
}

// An edge group with nothing in it is hidden — except during a drag, when it
// is the place to drop. One that fills up from empty opens expanded.
function syncEdges() {
  if (!api) return;
  for (const e of EDGES) {
    const n = edgeCount(e);
    const want = n > 0 || dragging;
    if (api.isEdgeGroupVisible(e) !== want) api.setEdgeGroupVisible(e, want);
    if (n === 0) {
      if (!dragging) edgeWasEmpty[e] = true;
      if (!edgeGroup(e)?.api.isCollapsed()) edgeGroup(e)?.api.collapse();
    } else if (edgeWasEmpty[e]) {
      edgeWasEmpty[e] = false;
      edgeGroup(e)?.api.expand(); // (no sync: this is part of one)
    }
  }
}

function syncToggle(type: string) {
  const t = types.get(type);
  if (!t?.toggle) return;
  const btn = $(t.toggle);
  if (!btn) return;
  const on = String(isOpen(type));
  btn.setAttribute(btn.getAttribute('role') === 'menuitemcheckbox' ? 'aria-checked' : 'aria-pressed', on);
}

/** Open and actually on screen: its tab in front, its edge group not collapsed. */
function inSight(panel) {
  if (!panel) return false;
  if (panel.group?.api.location.type === 'edge' && panel.group.api.isCollapsed()) return false;
  return panel.api.isVisible !== false;
}

// Bookkeeping after an engine event: on the next microtask, so a move (taken
// out of one group, put in another) is seen whole rather than as a close.
function later() {
  if (!api || batch || syncQueued) return;
  syncQueued = true;
  queueMicrotask(sync);
}

function slotOf(panel): Slot {
  const g = panel.group;
  const loc = g?.api.location;
  if (loc?.type === 'edge') return { edge: loc.position };
  if (loc?.type === 'floating') {
    const b = g.api.boundingBox || panel.api?.boundingBox;
    if (b) return { float: { left: b.left, top: b.top, width: b.width, height: b.height } };
    return { float: { left: 40, top: 40, ...FLOAT_SIZE } };
  }
  return { group: g.id };
}

const focusReturn = new Set<string>();

/**
 * Bring the shell's bookkeeping up to date with the dock: which windows are
 * open, where each one is, the edges' visibility, the toggles — then run the
 * hooks, once everything is in place: open hooks for every window that opened
 * or came back into sight (its tab brought to the front, its edge expanded —
 * a list it shows catches up), close hooks for every window that closed. The
 * shell calls it after its own changes; a user's drag or close reaches it
 * from the engine's events.
 */
function sync() {
  syncQueued = false;
  if (!api || batch) return;
  const changed: Instance[] = [];
  for (const inst of [...instances.values()]) {
    const panel = api.getPanel(inst.id);
    if (panel) slots.set(inst.id, slotOf(panel));
    if (!!panel === inst.open) continue;
    inst.open = !!panel;
    changed.push(inst);
  }
  syncEdges();
  for (const type of types.keys()) syncToggle(type);
  const sighted: Instance[] = [];
  for (const inst of instances.values()) {
    const seen = inst.open && inSight(api.getPanel(inst.id));
    if (seen && !inst.seen && !changed.includes(inst)) sighted.push(inst);
    inst.seen = seen;
  }
  for (const inst of sighted) {
    for (const fn of openHooks.get(inst.type) || []) fn(inst.key, inst.el);
  }
  for (const inst of changed) {
    const t = spec(inst.type);
    if (inst.open) {
      for (const fn of openHooks.get(inst.type) || []) fn(inst.key, inst.el);
      continue;
    }
    if (!t.singleton) {
      inst.el.remove();
      instances.delete(inst.id);
      slots.delete(inst.id);
    }
    for (const fn of closeHooks.get(inst.type) || []) fn(inst.key, inst.el);
    const opener = openers.get(inst.id);
    openers.delete(inst.id);
    const lost = focusReturn.delete(inst.id) || !document.activeElement || document.activeElement === document.body;
    if (lost && opener && opener.isConnected !== false) opener.focus?.({ preventScroll: true });
  }
}

function withBatch<T>(fn: () => T): T {
  batch++;
  try {
    return fn();
  } finally {
    batch--;
  }
}

// ---------------------------------------------------------------------------
// placing

// The box floating positions are measured from: the grid between the edge
// groups (Dockview's own root), or the whole dock before it has one.
function hostRect() {
  const grid = host?.querySelector?.('.dv-dockview');
  const r = (grid || host)?.getBoundingClientRect?.();
  return r && r.width ? r : { left: 0, top: 0, width: innerWidth, height: innerHeight };
}

function floatSize(t: Registered) {
  const hr = hostRect();
  const s = t.floatSize || FLOAT_SIZE;
  return { width: Math.min(s.width, Math.max(160, hr.width - 20)), height: Math.min(s.height, Math.max(120, hr.height - 20)) };
}

/** A floating spot for an instance with no saved one: bottom-left cascading (autoPlace), or top-right. */
function defaultFloat(inst: Instance, t: Registered) {
  const hr = hostRect();
  const size = floatSize(t);
  const gap = 12;
  if (!t.autoPlace) return { left: Math.max(gap, hr.width - size.width - gap), top: gap, ...size };
  const avoid = new Set([...(t.autoPlace.avoid || []), inst.type]);
  const others = api.panels
    .filter((p) => p.id !== inst.id && avoid.has(instances.get(p.id)?.type) && p.group?.api.location.type === 'floating')
    .map((p) => p.group.api.boundingBox)
    .filter(Boolean);
  let left = gap;
  let top = Math.max(gap, hr.height - size.height - gap);
  const clash = () => others.some((b) => Math.abs(b.left - left) < 48 && Math.abs(b.top - top) < 48);
  while (clash() && top > gap) {
    left = Math.min(hr.width - 60, left + 28);
    top = Math.max(gap, top - 28);
  }
  return { left, top, ...size };
}

function fromViewport(at: At, t: Registered) {
  const hr = hostRect();
  const left = parseFloat(String(at.left));
  const top = parseFloat(String(at.top));
  return {
    left: Number.isFinite(left) ? left - hr.left : 12,
    top: Number.isFinite(top) ? top - hr.top : 12,
    ...floatSize(t),
  };
}

// Where a center view goes: above the next center view that is open, or
// below the previous one — so the declared top-to-bottom order holds.
function centerPosition(type: string) {
  const center = [...types.entries()].filter(([, t]) => t.singleton && defaultsOf(t).dock === 'center').map(([k]) => k);
  const i = center.indexOf(type);
  const next = center.slice(i + 1).find((k) => api.getPanel(k));
  if (next) return { referencePanel: next, direction: 'above' };
  const prev = center.slice(0, Math.max(0, i)).reverse().find((k) => api.getPanel(k));
  if (prev) return { referencePanel: prev, direction: 'below' };
  const any = api.groups.find((g) => g.api.location.type === 'grid');
  return any ? { referenceGroup: any.id, direction: 'within' } : undefined;
}

// A center view with a declared height (the strips) gets it; the rest of the
// column goes to the one without (the map).
function sizeView(panel, t: Registered) {
  if (t.size && panel?.group?.api.location.type === 'grid') panel.group.api.setSize({ height: t.size });
}

function panelOptions(id: string, type: string, title: string) {
  const t = spec(type);
  return {
    id,
    component: type,
    title,
    tabComponent: t.closable ? undefined : 'fixed',
  };
}

function addTo(id: string, type: string, title: string, where: Slot, extra: any = {}) {
  const t = spec(type);
  const o: any = { ...panelOptions(id, type, title), ...extra };
  if ('edge' in where) {
    api.setEdgeGroupVisible(where.edge, true);
    o.position = { referenceGroup: edgeGroupId(where.edge), direction: 'within' };
  } else if ('group' in where && api.getGroup(where.group)) {
    o.position = { referenceGroup: where.group, direction: 'within' };
  } else if ('float' in where) {
    const f = where.float;
    o.floating = { position: { left: Math.max(0, f.left), top: Math.max(0, f.top) }, width: f.width, height: f.height };
  } else if ('center' in where) {
    const pos = centerPosition(type);
    if (pos) o.position = pos;
    const panel = api.addPanel(o);
    sizeView(panel, t);
    return panel;
  } else {
    // the group it was in is gone: its default home
    const home = defaultsOf(t).dock;
    const inst = instances.get(id);
    const fallback: Slot = home === 'center' ? { center: true } : home ? { edge: home }
      : { float: inst ? defaultFloat(inst, t) : { left: 40, top: 40, ...FLOAT_SIZE } };
    return addTo(id, type, title, fallback, extra);
  }
  return api.addPanel(o);
}

function slotFor(inst: Instance, t: Registered, opts: OpenOptions): Slot {
  if (opts.place) return opts.place;
  if (opts.dock !== undefined) {
    if (opts.dock === 'center') return { center: true };
    if (opts.dock) return { edge: opts.dock };
    return { float: opts.at ? fromViewport(opts.at, t) : defaultFloat(inst, t) };
  }
  if (opts.at) return { float: fromViewport(opts.at, t) };
  const last = slots.get(inst.id);
  if (last && !('float' in last && opts.freshPosition)) return last;
  const home = defaultsOf(t).dock;
  if (home === 'center') return { center: true };
  if (home) return { edge: home };
  return { float: defaultFloat(inst, t) };
}

// ---------------------------------------------------------------------------
// the API

/** Show a window (creating a multi-instance one), and bring it to the front. */
function open(type: string, key = '', opts: OpenOptions = {}) {
  const t = spec(type);
  engine();
  let inst = find(type, key);
  if (!inst) {
    if (t.singleton) throw new Error(`panel type ${type} has no element`);
    inst = adopt(type, t, key, t.build(key, opts.data));
  }
  const { el, id } = inst;
  const wasOpen = !!api.getPanel(id) && !placeholders.has(id);
  if (opts.focus && !wasOpen) {
    const active = document.activeElement;
    if (active && !el.contains(active)) openers.set(id, active);
  }
  withBatch(() => {
    let panel = api.getPanel(id);
    const ph = placeholders.get(id);
    if (!panel || (ph && !ph.inst)) {
      if (ph && api.getPanel(id)) {
        ph.take(inst);
        panel = api.getPanel(id);
        panel.api.setTitle(titleOf(inst));
      } else {
        const where = slotFor(inst, t, opts);
        const opensEdge = 'edge' in where && !opts.restoring;
        panel = addTo(id, type, titleOf(inst), where);
        if (opensEdge) setEdgeCollapsed((where as any).edge, false);
      }
    } else if (!opts.restoring && opts.dock !== undefined) {
      const where = slotFor(inst, t, opts);
      const now = slotOf(panel);
      if (JSON.stringify(where) !== JSON.stringify(now)) {
        api.removePanel(panel);
        panel = addTo(id, type, titleOf(inst), where);
      }
    }
    if (!opts.restoring) panel.api.setActive();
  });
  sync();
  if (opts.focus) focusInto(el);
  return el;
}

// The dock positions a newly added panel's content on the next frame; until
// then it cannot take focus, so a second try follows.
function focusInto(el) {
  el.focus?.({ preventScroll: true });
  if (document.activeElement === el || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => {
    if (!el.hidden && !el.contains(document.activeElement)) el.focus?.({ preventScroll: true });
  });
}

function closeInstance(inst: Instance | null | undefined) {
  if (!inst || !api) return;
  const panel = api.getPanel(inst.id);
  if (!panel) return;
  const active = document.activeElement;
  if (active && inst.el.contains(active)) focusReturn.add(inst.id);
  withBatch(() => api.removePanel(panel));
  sync();
}

/** Hide a window; a multi-instance one is removed. */
function close(type: string, key = '') {
  closeInstance(find(type, key));
}

function isOpen(type: string, key = '') {
  const inst = find(type, key);
  if (!inst) return false;
  return api ? !!api.getPanel(inst.id) : inst.open;
}

/** Open and actually on screen: its tab in front, its edge group expanded. */
function isShown(type: string, key = '') {
  const inst = find(type, key);
  return !!inst && inSight(api?.getPanel(inst.id));
}

// A toolbar toggle closes a window that is on screen, and brings one that is
// open but out of sight (a tab behind another, a collapsed edge) to the front.
function toggle(type: string, key = '', opts: OpenOptions = {}) {
  if (isOpen(type, key) && isShown(type, key)) close(type, key);
  else reveal(type, key, opts);
}

/** Open it and make sure it can be seen: a collapsed edge holding it expands. */
function reveal(type: string, key = '', opts: OpenOptions = {}) {
  const el = open(type, key, opts);
  const panel = api.getPanel(find(type, key).id);
  const loc = panel?.group?.api.location;
  if (loc?.type === 'edge') setEdgeCollapsed(loc.position, false);
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

/** Where an instance is: its edge, 'center' (the grid), or null (floating). */
function location(type: string, key = ''): { dock: Home; open: boolean } | null {
  const inst = find(type, key);
  if (!inst) return null;
  const panel = api?.getPanel(inst.id);
  if (!panel) return { dock: null, open: false };
  const loc = panel.group.api.location;
  return { dock: loc.type === 'edge' ? loc.position : loc.type === 'grid' ? 'center' : null, open: true };
}

/** Where a window is now (or was last), to open another one in its place. */
function placeOf(type: string, key = ''): Place | null {
  const inst = find(type, key);
  if (!inst) return null;
  const panel = api?.getPanel(inst.id);
  return panel ? slotOf(panel) : slots.get(inst.id) || null;
}

function closeAll(type: string) {
  for (const { key } of instancesOf(type)) close(type, key);
}

function onOpen(type: string, fn: (key: string, el: any) => void) { hooks(openHooks, type).push(fn); }
function onClose(type: string, fn: (key: string, el: any) => void) { hooks(closeHooks, type).push(fn); }

function typeInfos(): TypeInfo[] {
  return [...types.entries()].map(([type, t]) => {
    const d = defaultsOf(t);
    return { type, singleton: t.singleton, persist: t.persist, home: d.dock, open: d.open };
  });
}

/**
 * Replace the whole dock with a plan. Transient windows (not persisted:
 * allocation, event, request, pinned) keep their open state and are moved to
 * float — except multi-instance ones when `keepMulti` is false, which a
 * restore decides instead.
 */
function applyPlan(plan: Plan, { keepFloating = false, keepMulti = true } = {}) {
  engine();
  const keep: { inst: Instance; slot: Slot | null }[] = [];
  for (const inst of instances.values()) {
    const t = spec(inst.type);
    if (t.persist || !api.getPanel(inst.id)) continue;
    if (!t.singleton && !keepMulti) continue;
    keep.push({ inst, slot: slots.get(inst.id) || null });
  }
  const floatSlot = (inst: Instance) => {
    const s = slots.get(inst.id);
    return keepFloating && s && 'float' in s ? s : null;
  };
  const prior = new Map([...instances.values()].map((i) => [i.id, floatSlot(i)]));
  withBatch(() => {
    api.clear();
    placeholders.clear();
    slots.clear();
    let prev: string | null = null;
    for (const id of plan.center) {
      const type = id.split(':')[0];
      if (!types.has(type)) continue;
      const o: any = panelOptions(id, type, titleFor(id, type));
      if (prev) o.position = { referencePanel: prev, direction: 'below' };
      api.addPanel(o);
      prev = id;
    }
    // (sized once the column is whole: each add splits its neighbour)
    for (const id of plan.center) {
      const t = types.get(id.split(':')[0]);
      if (t) sizeView(api.getPanel(id), t);
    }
    for (const e of EDGES) {
      const { ids, size, collapsed } = plan.edges[e];
      ids.forEach((id, i) => {
        const type = id.split(':')[0];
        if (!types.has(type)) return;
        api.addPanel({
          ...panelOptions(id, type, titleFor(id, type)),
          position: { referenceGroup: edgeGroupId(e), direction: 'within' },
          inactive: i > 0,
        });
      });
      const g = edgeGroup(e);
      api.setEdgeGroupVisible(e, ids.length > 0);
      if (ids.length) {
        if (collapsed) g.api.collapse();
        else g.api.expand();
        g.api.setSize(e === 'bottom' ? { height: size || EDGE_SIZE[e] } : { width: size || EDGE_SIZE[e] });
      }
      edgeWasEmpty[e] = ids.length === 0;
    }
    for (const { id, at } of plan.floating) {
      const inst = instances.get(id);
      if (!inst) continue;
      const t = spec(inst.type);
      const kept = prior.get(id);
      addTo(id, inst.type, titleOf(inst), kept || { float: at ? fromViewport(at, t) : defaultFloat(inst, t) });
    }
    for (const [id, home] of Object.entries(plan.homes)) {
      if (api.getPanel(id) || !instances.has(id)) continue;
      if (home === 'center') slots.set(id, { center: true });
      else if (home) slots.set(id, { edge: home });
    }
    // a closed window that floated keeps its spot when floating windows stay
    for (const [id, s] of prior) {
      if (s && !slots.has(id) && !api.getPanel(id) && instances.has(id)) slots.set(id, s);
    }
    for (const { inst, slot } of keep) {
      if (api.getPanel(inst.id)) continue;
      const t = spec(inst.type);
      const s = keepFloating && slot && 'float' in slot ? slot : { float: defaultFloat(inst, t) };
      addTo(inst.id, inst.type, titleOf(inst), s, { inactive: true });
    }
  });
  sync();
}

/**
 * Put every window back where the declarations say (SHELL-008): the views
 * stacked in the center, docked windows in their edge group in declaration
 * order, floating ones at their default spot, edges at the default size and
 * expanded. A persisted window's open state goes back to its default; a
 * transient one (an allocation or event window) keeps its open state and is
 * only moved to float.
 *
 * `keepFloating` leaves floating windows where they are — the default layout
 * a newly loaded trace starts from, as opposed to the user's Reset layout.
 */
function resetLayout({ keepFloating = false } = {}) {
  applyPlan(defaultPlan(typeInfos()), { keepFloating });
}

const SHELL_VERSION = 2;

/** The shell's half of the session: the dock's own serialization, and where closed windows reopen. */
function serialize() {
  const homes = {};
  for (const inst of instances.values()) {
    const t = spec(inst.type);
    if (!t.singleton || !t.persist || api?.getPanel(inst.id)) continue;
    const s = slots.get(inst.id);
    if (s && !('group' in s)) homes[inst.id] = s;
  }
  return { version: SHELL_VERSION, dock: api ? api.toJSON() : null, homes };
}

/**
 * The layout from a session's shell section: the dock's own serialization
 * (version 2), or a version-1 `{ windows, drawers }` read through the one
 * legacy path. Panels the session saved whose window is not back yet (a
 * pinned allocation window, recreated after a worker round-trip) hold their
 * slot as a placeholder until `open(…, { restoring: true })` fills it or
 * `dropPlaceholders` gives up on it.
 */
function restore(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !api) return;
  if (snapshot.version === SHELL_VERSION && snapshot.dock) {
    const keep = [...instances.values()].filter((i) => !spec(i.type).persist && spec(i.type).singleton && api.getPanel(i.id));
    let ok = true;
    withBatch(() => {
      try {
        api.fromJSON(snapshot.dock, { reuseExistingPanels: true });
      } catch {
        ok = false;
      }
      if (!ok) return;
      // a saved panel this build has no type for, or a transient window that
      // is closed now, is not restored
      for (const [id, ph] of [...placeholders]) {
        const type = id.split(':')[0];
        const t = types.get(type);
        if (t && !t.singleton) continue;
        placeholders.delete(id);
        const p = api.getPanel(ph.id);
        if (p) api.removePanel(p);
      }
      for (const inst of keep) {
        if (!api.getPanel(inst.id)) addTo(inst.id, inst.type, titleOf(inst), { float: defaultFloat(inst, spec(inst.type)) });
      }
      ensureFixed();
      bottomTabsOnTop();
      slots.clear();
      for (const [id, s] of Object.entries(snapshot.homes || {})) {
        if (instances.has(id) && s && typeof s === 'object') slots.set(id, s as Slot);
      }
      for (const e of EDGES) edgeWasEmpty[e] = edgeCount(e) === 0;
    });
    if (!ok) {
      resetLayout();
      return;
    }
    sync();
    return;
  }
  if (snapshot.windows || snapshot.drawers) {
    const plan = legacyPlan(snapshot, typeInfos());
    applyPlan(plan, { keepMulti: false });
    // docked pinned windows: the plan put placeholders in their slots
  }
}

// A view that cannot be closed is always there, whatever a session saved.
function ensureFixed() {
  for (const [type, t] of types) {
    if (t.singleton && !t.closable && !api.getPanel(type)) addTo(type, type, titleFor(type, type), { center: true });
  }
}

/** Remove the slots still waiting for a window a restore was to recreate. */
function dropPlaceholders() {
  if (!api) return;
  withBatch(() => {
    for (const [id] of [...placeholders]) {
      placeholders.delete(id);
      const p = api.getPanel(id);
      if (p) api.removePanel(p);
    }
  });
  sync();
}

export const layout = {
  register, init, open, close, toggle, reveal, isOpen, isShown, element, instancesOf, location, placeOf, closeAll,
  onOpen, onClose, resetLayout, serialize, restore, dropPlaceholders,
};

/** For tests: the plan-building half of the engine-free model. */
export { defaultPlan, legacyPlan };
