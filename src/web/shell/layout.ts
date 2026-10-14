// Shell: the panel API. The one door domain code uses to show, hide, place and
// persist windows. It owns every panel's visibility, its placement on open,
// its toolbar toggle and close button, focus and Escape, and the layout part
// of the session. Behind it is Dockview (dockview-core, D014): one grid of
// split/tabbed groups — the center, with the left, right and bottom edges as
// ordinary columns and rows around it, so an edge splits like the rest — and
// floating groups over all of it. Which edge a group is in is read off the
// grid's shape (layout-plan.ts `regionsOf`); collapsing an edge to a rail of
// its tabs is the shell's. Domain code never sees the engine.
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
// A window's per-window actions (a pin) live in its tab, not in a row of its
// own: the elements in its `.panel-head` marked `.tab-action` are moved into
// its tab while it is in the dock, and back when it leaves. Its tab reads its
// `.ph-t` text, and shows that element's `title` attribute as its tooltip.
//
// Still domain-agnostic: no panel is named here.

import type { DockviewApi } from 'dockview-core';
import { $ } from './dom.ts';
import { clampBox, placeFloat, type Box, type Point } from './float-place.ts';
import {
  EDGES, RAIL, bottomReference, defaultPlan, dockFromEdgeGroups, legacyPlan, regionsOf,
  type Edge, type EdgeState, type Home, type Plan, type Region, type TypeInfo,
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
  /**
   * Float it, when it floats from scratch, beside the point it was opened
   * from (`near`), or else at the workspace's bottom-left — either way clear
   * of every floating window (`avoid` is kept for declarations that name the
   * types; every floating window is avoided now).
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
  /** Float it at this viewport position. */
  at?: At;
  /** Ignore where it last was and place it from scratch. */
  freshPosition?: boolean;
  /** A viewport point it opens beside, when it floats from scratch (the clicked allocation). */
  near?: Point | null;
  /** Put it in this edge, the center, or floating (null). */
  dock?: Home;
  /** Put it where another window is or was (`placeOf`). */
  place?: Place | null;
  /**
   * Open it as a tab in the group that window is in — docked or floating —
   * when that window is open (a pinned allocation window opens beside the
   * live one). Otherwise it is placed as if this were not given.
   */
  beside?: { type: string; key?: string } | null;
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
// (an edge slot names the group it was in too, so a window reopens in its
// half of a split edge while that half is there; a floating slot names its
// group, so a window that shared a floating window as a tab reopens in it
// while it is there, and at its box once it is gone)
type Slot = { edge: Edge; group?: string } | { center: true } | { group: string }
  | { float: { left: number; top: number; width: number; height: number }; group?: string };

const EDGE_SIZE: Record<Edge, number> = { left: 300, right: 300, bottom: 240 };
const FLOAT_SIZE = { width: 340, height: 320 };
// an expanded group's own minimum, as the engine has it
const GROUP_MIN = 100;
const NO_MAX = Number.MAX_SAFE_INTEGER;

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
// what the grid does not keep about each edge: collapsed, and the size it
// expands to (persisted beside the dock's own serialization)
const edgeState: Record<Edge, { collapsed: boolean; size: number }> = {
  left: { collapsed: false, size: EDGE_SIZE.left },
  right: { collapsed: false, size: EDGE_SIZE.right },
  bottom: { collapsed: false, size: EDGE_SIZE.bottom },
};
let regions = new Map<string, Region>(); // grid group id -> its region, in grid order
// the panels each edge held at the last sync: one dropped into a collapsed edge expands it
let edgePanels: Record<Edge, Set<string>> = { left: new Set(), right: new Set(), bottom: new Set() };
const railed = new Set<string>(); // groups the shell has pinned to a rail's size
const tabs = new Map<string, WindowTab>(); // panel id -> its tab
const actionBars = new Set<GroupActions>();

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
    tabs.get(this.id)?.refresh();
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

// A panel's tab: its title, its window's actions (the `.tab-action` elements
// of its head, moved in while it is docked — a pin), and its close button —
// none for a view that must always exist. The engine's own tab, plus the
// actions; the same classes, so it looks the same.
class WindowTab {
  readonly element: any;
  private content: any;
  private actions: any;
  private close: any = null;
  private id = '';
  private subs: { dispose(): void }[] = [];
  private moved: { el: any; parent: any; next: any }[] = [];

  constructor(closable: boolean) {
    this.element = document.createElement('div');
    this.element.className = 'dv-default-tab';
    this.content = document.createElement('div');
    this.content.className = 'dv-default-tab-content';
    this.actions = document.createElement('span');
    this.actions.className = 'dock-tab-actions';
    this.element.appendChild(this.content);
    this.element.appendChild(this.actions);
    if (closable) {
      this.close = document.createElement('div');
      this.close.className = 'dv-default-tab-action';
      this.close.setAttribute('role', 'button');
      this.close.setAttribute('tabindex', '-1');
      this.close.innerHTML = '<svg height="11" width="11" viewBox="0 0 28 28" aria-hidden="true" focusable="false" class="dv-svg"><path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z"></path></svg>';
      this.element.appendChild(this.close);
    }
  }

  init(params) {
    this.id = params.api?.id ?? '';
    this.setTitle(params.title || '');
    const sub = params.api?.onDidTitleChange?.((e) => this.setTitle(e.title));
    if (sub) this.subs.push(sub);
    if (this.close) {
      // (pressed, the tab must not start a drag or take the group's focus)
      this.close.addEventListener('pointerdown', (e) => e.preventDefault());
      this.close.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        params.api.close();
      });
    }
    // an action pressed in the tab acts; it does not drag or select the tab
    for (const type of ['pointerdown', 'mousedown']) {
      this.actions.addEventListener(type, (e) => e.stopPropagation());
    }
    this.actions.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
    if (this.id) tabs.set(this.id, this);
    this.refresh();
  }

  private setTitle(t: string) {
    this.content.textContent = t;
    this.close?.setAttribute('aria-label', `Close ${t}`);
    this.refreshTip();
  }

  /** The tooltip: the window's `.ph-t` title attribute (the whole of what a short tab title stands for). */
  refreshTip() {
    const tip = instances.get(this.id)?.el?.querySelector?.('.ph-t')?.getAttribute?.('title') || '';
    if (tip) this.content.setAttribute('title', tip);
    else this.content.removeAttribute?.('title');
  }

  /** Take the window's actions and tooltip in (again, once a placeholder's window is back). */
  refresh() {
    this.refreshTip();
    const inst = instances.get(this.id);
    const head = inst?.el?.querySelector?.('.panel-head');
    if (!head) return;
    for (const a of [...head.querySelectorAll('.tab-action')]) {
      this.moved.push({ el: a, parent: a.parentElement, next: a.nextSibling });
      this.actions.appendChild(a);
    }
  }

  dispose() {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    if (tabs.get(this.id) === this) tabs.delete(this.id);
    // the actions go back to the window, which keeps them while it is closed
    for (const { el, parent, next } of this.moved.reverse()) {
      if (el.parentElement !== this.actions) continue;
      parent.insertBefore(el, next && next.parentElement === parent ? next : null);
    }
    this.moved = [];
  }
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
          tabs.get(id)?.refreshTip();
        }).observe(titleEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['title'] });
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
 * registered first — types can be registered before or after). An edge with
 * nothing in it takes no room: it is not there until a window is put in it,
 * by the shell or by a tab dropped on the dock's outer edge.
 */
function init(hostEl: any, eng: Engine) {
  host = hostEl;
  api = eng.createDockview(hostEl, {
    theme: eng.theme,
    defaultRenderer: 'always',
    defaultTabComponent: 'window',
    // (no popouts: a window's controls are found by id, and a popout would
    // move them into another document — so no 'popout' in the tab menu.)
    // Floating windows float over the whole dock, edges included: the edges
    // are part of the one grid, which is the floating area.
    floatingGroupBounds: 'boundedWithinViewport',
    // a floating window moves by the empty part of its tab strip, like a
    // window by its title bar; dragging a tab takes that one tab out — onto a
    // group or an edge it docks there, onto a view (the empty workspace) it
    // floats on its own where it is dropped, and Shift-dragging it floats it
    // as it goes. Shift-dragging the strip docks the whole window. (The
    // engine's default is a separate thin bar above the tabs, which leaves the
    // strip itself docking the window when it is dragged.)
    floatingGroupDragHandle: 'tabbar',
    // the map, last in the center column, takes the room a resize adds
    proportionalLayout: false,
    createComponent: (o) => new Adopt(o.id),
    createTabComponent: (o) => new WindowTab(o.name !== 'fixed'),
    createRightHeaderActionComponent: (group) => new GroupActions(group),
    getTabContextMenuItems: (p) => tabMenu(p?.panel),
  });
  // a window's tab dropped on the body of a view (the address map, a strip:
  // the empty workspace) floats it there, rather than making it a tab over
  // the view
  api.onWillDrop?.((e) => {
    const data = e.getData?.();
    const panel = data?.panelId ? api.getPanel(data.panelId) : null;
    if (!panel || e.kind !== 'content' || e.position !== 'center' || !holdsView(e.group)) return;
    const inst = instances.get(panel.id);
    if (!inst || isView(inst.type)) return;
    e.preventDefault();
    const at = { x: e.nativeEvent?.clientX ?? 0, y: e.nativeEvent?.clientY ?? 0 };
    // (after the engine has finished with the drag)
    setTimeout(() => floatPanelAt(panel, inst, at), 0);
  });
  api.onDidAddPanel(later);
  api.onDidRemovePanel(later);
  api.onDidAddGroup?.(later);
  api.onDidRemoveGroup?.(later);
  api.onDidMovePanel?.(later);
  api.onDidLayoutChange?.(later);
  sync();
  return api;
}

// The buttons at the end of a group's tab strip: collapse/expand on the last
// group of an edge (it collapses the whole edge), maximize/restore on a center
// group. A tab clicked in a collapsed edge expands it.
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
    actionBars.add(this);
    const render = () => this.render();
    for (const ev of [g.api.onDidLocationChange, api?.onDidMaximizedGroupChange]) {
      const s = ev?.(render);
      if (s) this.subs.push(s);
    }
    const el = g.element;
    if (el?.addEventListener) {
      const onTab = (e) => {
        const r = regions.get(g.id);
        if (!r || r === 'center' || !edgeState[r].collapsed) return;
        if (e.target?.closest?.('.dv-tab')) setEdgeCollapsed(r, false);
      };
      el.addEventListener('click', onTab);
      this.subs.push({ dispose: () => el.removeEventListener('click', onTab) });
    }
    render();
  }

  render() {
    const g = this.group;
    const loc = g.api.location;
    const region = loc.type === 'grid' ? regions.get(g.id) || 'center' : null;
    this.element.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dock-action';
    if (region && region !== 'center') {
      const side = region;
      // one button per edge, at the end of its last group
      const own = [...regions].filter(([, r]) => r === side).map(([id]) => id);
      if (own[own.length - 1] !== g.id) return;
      const collapsed = edgeState[side].collapsed;
      const name = side === 'bottom' ? 'bottom dock' : `${side} dock`;
      btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${name}`);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? 'Expand' : 'Collapse';
      const glyph = { left: ['›', '‹'], right: ['‹', '›'], bottom: ['˄', '˅'] }[side] || ['+', '−'];
      btn.textContent = collapsed ? glyph[0] : glyph[1];
      btn.onclick = () => setEdgeCollapsed(side, !edgeState[side].collapsed);
    } else if (region === 'center') {
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
    actionBars.delete(this);
  }
}

// ---------------------------------------------------------------------------
// the edges

// The group holding the view that cannot be closed (the map) — what the
// regions are read relative to — else one holding any center view.
function anchorGroup(): string | null {
  const grid = (p) => (p?.group?.api.location.type === 'grid' ? p.group.id : null);
  const center = [...types.entries()].filter(([, t]) => t.singleton && defaultsOf(t).dock === 'center');
  for (const [type, t] of center) if (!t.closable && grid(api.getPanel(type))) return grid(api.getPanel(type));
  for (const [type] of center) if (grid(api.getPanel(type))) return grid(api.getPanel(type));
  return null;
}

function dockJSON() {
  try {
    return api.toJSON();
  } catch {
    return null;
  }
}

/** Read every grid group's region off the grid's shape now. */
function refreshRegions() {
  regions = regionsOf(dockJSON()?.grid, anchorGroup());
}

function regionOf(g): Region | null {
  if (!g || g.api.location.type !== 'grid') return null;
  return regions.get(g.id) || 'center';
}

/** An edge's groups, in grid order (fresh: the shell may have just changed the grid). */
function edgeGroups(e: Edge) {
  refreshRegions();
  return [...regions].filter(([, r]) => r === e).map(([id]) => api.getGroup(id)).filter(Boolean);
}

const across = (e: Edge) => e !== 'bottom'; // its size is a width

function acrossOf(g, e: Edge) {
  const s = across(e) ? g.api.width : g.api.height;
  return Number.isFinite(s) ? s : 0;
}

function sizeOfEdge(e: Edge) {
  const g = edgeGroups(e)[0];
  const s = g ? acrossOf(g, e) : 0;
  return s > RAIL + 1 ? s : edgeState[e].size;
}

function setAcross(g, e: Edge, n: number) {
  g.api.setSize(across(e) ? { width: n } : { height: n });
}

// What each edge group measures across its edge (a side column's width, the
// bottom row's height) when last seen expanded: what it expands back to, and
// what it keeps when the engine shares out room among the root's columns (a
// tab dropped on the dock's outer edge makes a new one).
const groupSize = new Map<string, number>();
let knownGroups = new Set<string>();

function recordSizes(e: Edge) {
  if (edgeState[e].collapsed) return;
  for (const g of edgeGroups(e)) {
    const n = acrossOf(g, e);
    if (n > RAIL + 1) groupSize.set(g.id, n);
  }
}

// A collapsed edge is its groups pinned to the thickness of their tab strip:
// a rail of tab titles (written vertically on the left and right).
function railOf(g, e: Edge) {
  const strip = g.element?.querySelector?.('.dv-tabs-and-actions-container');
  const n = strip ? (across(e) ? strip.offsetWidth : strip.offsetHeight) : 0;
  return n > 0 ? n : RAIL;
}

function rail(g, e: Edge) {
  const n = railOf(g, e);
  g.api.setConstraints?.(across(e) ? { minimumWidth: n, maximumWidth: n } : { minimumHeight: n, maximumHeight: n });
  setAcross(g, e, n);
  railed.add(g.id);
}

function unrail(g) {
  g.api.setConstraints?.({ minimumWidth: GROUP_MIN, maximumWidth: NO_MAX, minimumHeight: GROUP_MIN, maximumHeight: NO_MAX });
  railed.delete(g.id);
}

/**
 * Put an edge's groups in its collapse state. Expanding gives each group back
 * its size, unless `keepSize` (a restore: the grid already has it).
 */
function applyEdge(e: Edge, keepSize = false) {
  const gs = edgeGroups(e);
  if (!gs.length) return;
  if (edgeState[e].collapsed) {
    for (const g of gs) rail(g, e);
    return;
  }
  for (const g of gs) unrail(g);
  if (keepSize) return;
  // (twice: sizing one column can take room from a neighbour sized before it)
  for (let pass = 0; pass < 2; pass++) {
    for (const g of gs) setAcross(g, e, groupSize.get(g.id) || edgeState[e].size);
  }
}

function setEdgeCollapsed(e: Edge, collapsed: boolean) {
  const st = edgeState[e];
  if (st.collapsed === collapsed || !edgeGroups(e).length) return;
  if (collapsed) {
    recordSizes(e);
    st.size = sizeOfEdge(e);
  }
  st.collapsed = collapsed;
  withBatch(() => applyEdge(e));
  // its windows come into sight or go out of it
  sync();
}

// Where a new edge goes: a column at the dock's left or right, or a row under
// the center (between the side edges).
function newEdgePosition(e: Edge) {
  if (e !== 'bottom') return { direction: e };
  const ref = bottomReference(dockJSON()?.grid, anchorGroup());
  return ref && api.getGroup(ref) ? { referenceGroup: ref, direction: 'below' } : { direction: 'below' };
}

// Add a panel to an edge: into the group it was in (`group`) while that is
// still part of the edge, else the edge's first group, else a new edge.
function addToEdge(o: any, e: Edge, group?: string) {
  const gs = edgeGroups(e);
  const into = gs.find((g) => g.id === group) || gs[0];
  if (into) {
    o.position = { referenceGroup: into.id, direction: 'within' };
    return api.addPanel(o);
  }
  edgeState[e].collapsed = false;
  o.position = newEdgePosition(e);
  const panel = api.addPanel(o);
  const g = panel.group;
  headerFor(g, e);
  setAcross(g, e, edgeState[e].size);
  groupSize.set(g.id, edgeState[e].size);
  return panel;
}

// The anchor (the map) takes the room a resize adds or removes, as it did when
// the edges were outside the grid — not the last row and column, which are
// now the bottom and right edges. Dockview has a layout priority per view but
// sets it for a group only at creation, so the shell sets the group's own
// field (`_priority`: dockview-core 8.4.1, pinned — D014) and nudges it with
// an empty constraint change, which makes the splits above it re-read it.
function prioritize() {
  const anchor = anchorGroup();
  for (const g of api.groups || []) {
    if (g.api.location.type !== 'grid' || !('_priority' in g || g.id === anchor)) continue;
    const want = g.id === anchor ? 'high' : undefined;
    if (g._priority === want) continue;
    g._priority = want;
    g.api.setConstraints?.({});
  }
}

// The side edges' tab strips run down their outer side; every other group's
// across its top.
function headerFor(g, region: Region | null) {
  const want = region === 'left' || region === 'right' ? region : 'top';
  if (g?.api?.getHeaderPosition?.() !== want) g?.api?.setHeaderPosition?.(want);
}

/**
 * The edges after any change: their regions re-read, every group's tab strip
 * on its side, an edge that is empty no longer collapsed, a group that has
 * left a collapsed edge (dragged out whole) no longer railed — and one that
 * a panel was dropped into, collapsed, expanded. `quiet`: a restore or the
 * shell's own rearranging, where a panel arriving is not a drop.
 */
function syncEdges(quiet = false) {
  refreshRegions();
  for (const g of api.groups || []) {
    const r = regionOf(g);
    headerFor(g, r);
    // a stable hook for the browser smoke suite: which edge a group is in
    if (g.element?.dataset) g.element.dataset.region = r || 'floating';
  }
  withBatch(prioritize);
  const now: Record<Edge, Set<string>> = { left: new Set(), right: new Set(), bottom: new Set() };
  for (const [id, r] of regions) {
    if (r === 'center') continue;
    for (const p of api.getGroup(id)?.panels || []) now[r].add(p.id);
  }
  for (const e of EDGES) {
    const st = edgeState[e];
    if (!now[e].size) {
      st.collapsed = false;
      continue;
    }
    if (st.collapsed && !quiet && [...now[e]].some((id) => !edgePanels[e].has(id))) {
      st.collapsed = false;
      withBatch(() => applyEdge(e));
    } else if (st.collapsed) {
      // a group that joined the edge (a tab dropped on its outer side)
      for (const g of edgeGroups(e)) if (!railed.has(g.id)) withBatch(() => rail(g, e));
    }
  }
  for (const id of [...railed]) {
    const g = api.getGroup(id);
    const r = g ? regionOf(g) : null;
    if (!g) railed.delete(id);
    else if (!r || r === 'center' || !edgeState[r].collapsed) withBatch(() => unrail(g));
  }
  // A group the user just made (a tab dropped on a group's edge, or on the
  // dock's outer edge): the engine shares the room out evenly among the root's
  // columns, so the edges that were there get their size back, and a new edge
  // column takes an edge's size — the center gives or takes the difference.
  const fresh = [...regions.keys()].filter((id) => !knownGroups.has(id));
  if (fresh.length && knownGroups.size && !quiet) {
    withBatch(() => {
      for (const e of EDGES) {
        if (edgeState[e].collapsed) continue;
        const gs = edgeGroups(e);
        for (const g of gs) if (fresh.includes(g.id)) setAcross(g, e, edgeState[e].size);
        for (const g of gs) if (!fresh.includes(g.id) && groupSize.get(g.id)) setAcross(g, e, groupSize.get(g.id));
      }
    });
  }
  for (const e of EDGES) recordSizes(e);
  knownGroups = new Set(regions.keys());
  edgePanels = now;
  for (const bar of actionBars) bar.render();
}

function syncToggle(type: string) {
  const t = types.get(type);
  if (!t?.toggle) return;
  const btn = $(t.toggle);
  if (!btn) return;
  const on = String(isOpen(type));
  btn.setAttribute(btn.getAttribute('role') === 'menuitemcheckbox' ? 'aria-checked' : 'aria-pressed', on);
}

/** Open and actually on screen: its tab in front, its edge not collapsed. */
function inSight(panel) {
  if (!panel) return false;
  const r = regionOf(panel.group);
  if (r && r !== 'center' && edgeState[r].collapsed) return false;
  return panel.api.isVisible !== false;
}

// Bookkeeping after an engine event: on the next microtask, so a move (taken
// out of one group, put in another) is seen whole rather than as a close.
function later() {
  if (!api || batch || syncQueued) return;
  syncQueued = true;
  queueMicrotask(sync);
}

// A floating group's whole window — its frame, not just the group inside it —
// in the coordinates the engine places floating windows in. Reopening a
// window at this box puts it back exactly where it was: the group's own box
// is inset by the frame, and a window placed by it creeps and shrinks on
// every pin, unpin and reopen.
function floatBoxOf(g): Box | null {
  const frame = g?.element?.closest?.('.dv-resize-container');
  const area = frame?.parentElement;
  if (frame && area) {
    const r = frame.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    if (r.width && r.height) return { left: r.left - a.left, top: r.top - a.top, width: r.width, height: r.height };
  }
  const b = g?.api.boundingBox;
  return b ? { left: b.left, top: b.top, width: b.width, height: b.height } : null;
}

function slotOf(panel): Slot {
  const g = panel.group;
  const loc = g?.api.location;
  const r = regionOf(g);
  if (r && r !== 'center') return { edge: r, group: g.id };
  if (loc?.type === 'floating') {
    return { float: floatBoxOf(g) || { left: 40, top: 40, ...FLOAT_SIZE }, group: g.id };
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
function sync(quiet = false) {
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
  syncEdges(quiet === true);
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

// The box floating positions are measured from, and floating windows are
// held inside: the whole dock — its center and its edges, which are all one
// grid (Dockview's own root) — or the host before there is one.
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

// The floating windows on screen now, but for the group holding `exceptId`.
function floatingBoxes(exceptId = '') {
  return (api.groups || [])
    .filter((g) => g.api.location.type === 'floating' && !g.panels.some((p) => p.id === exceptId))
    .map(floatBoxOf)
    .filter(Boolean);
}

/**
 * A floating spot for an instance with no saved one, clear of every other
 * floating window: beside `near` (a viewport point) for a type that places
 * itself (autoPlace), else at its corner — bottom-left for autoPlace, top-right
 * for the rest (shell/float-place.ts).
 */
function defaultFloat(inst: Instance, t: Registered, near: Point | null = null) {
  const hr = hostRect();
  return placeFloat({
    area: { width: hr.width, height: hr.height },
    size: t.floatSize || FLOAT_SIZE,
    others: floatingBoxes(inst.id),
    anchor: t.autoPlace && near ? { x: near.x - hr.left, y: near.y - hr.top } : null,
    corner: t.autoPlace ? 'bottom-left' : 'top-right',
  });
}

// The tab menu's Float: the panel floats at its own float size, clear of the
// floating windows already there.
function floatPanel(panel, inst: Instance) {
  floatInto(panel, defaultFloat(inst, spec(inst.type)));
}

// A tab dropped on the empty workspace: it floats with its tab under the
// pointer, at its own float size, held inside the dock.
function floatPanelAt(panel, inst: Instance, at: Point) {
  if (!api.getPanel(panel.id)) return;
  const hr = hostRect();
  const size = floatSize(spec(inst.type));
  floatInto(panel, clampBox({ left: at.x - hr.left - 24, top: at.y - hr.top - 12, ...size }, { width: hr.width, height: hr.height }));
}

function floatInto(panel, b: Box) {
  withBatch(() => api.addFloatingGroup(panel, { position: { left: b.left, top: b.top }, width: b.width, height: b.height }));
  panel.api.setActive?.();
  sync();
}

// A view is a center singleton (the map, the strips): what the workspace is
// made of, as opposed to a window.
function isView(type: string) {
  const t = types.get(type);
  return !!t && t.singleton && defaultsOf(t).dock === 'center';
}

function holdsView(g) {
  return !!g && g.api?.location?.type === 'grid' && (g.panels || []).some((p) => isView(String(p.id).split(':')[0]));
}

// How many tabs the floating window holding `g` has (all its groups: a
// floating window can be split).
function tabsInWindow(g) {
  const frame = g?.element?.closest?.('.dv-resize-container');
  if (!frame) return g?.panels?.length ?? 0;
  return (api.groups || []).filter((x) => frame.contains(x.element)).reduce((n, x) => n + x.panels.length, 0);
}

/**
 * A tab's context menu. A window: Float (from the grid) or Move to new window
 * (from a floating window that holds other tabs), Split right and Split down
 * (the tab out into a new group beside its own — inside a floating window
 * too, which the engine keeps as a grid of its own), Maximize, Close. Float
 * goes through the shell, so the window lands clear of the other floating
 * windows at its own float size (the engine's own puts every one at the same
 * spot).
 */
function tabMenu(panel) {
  const inst = panel?.id ? instances.get(panel.id) : null;
  const closable = !inst || spec(inst.type).closable;
  if (!inst) return closable ? ['float', 'maximize', 'separator', 'close'] : ['float', 'maximize'];
  const g = panel.group;
  const floating = g?.api.location.type === 'floating';
  const items: any[] = [floating ? {
    label: 'Move to new window',
    disabled: tabsInWindow(g) < 2,
    action: () => floatPanel(panel, inst),
  } : { label: 'Float', action: () => floatPanel(panel, inst) }];
  const alone = (g?.panels?.length ?? 0) < 2;
  for (const [label, position] of [['Split right', 'right'], ['Split down', 'bottom']]) {
    items.push({ label, disabled: alone, action: () => { panel.api.moveTo({ group: g, position }); later(); } });
  }
  items.push('maximize');
  return closable ? [...items, 'separator', 'close'] : items;
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
  refreshRegions();
  const any = [...regions].find(([, r]) => r === 'center');
  return any ? { referenceGroup: any[0], direction: 'within' } : undefined;
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
    tabComponent: t.closable ? 'window' : 'fixed',
  };
}

function addTo(id: string, type: string, title: string, where: Slot, extra: any = {}) {
  const t = spec(type);
  const o: any = { ...panelOptions(id, type, title), ...extra };
  if ('edge' in where) {
    return addToEdge(o, where.edge, where.group);
  } else if ('group' in where && api.getGroup(where.group)) {
    o.position = { referenceGroup: where.group, direction: 'within' };
  } else if ('float' in where) {
    // (held inside the dock: a spot saved on a larger screen comes back in reach)
    const hr = hostRect();
    const f = clampBox(where.float, { width: hr.width, height: hr.height });
    o.floating = { position: { left: f.left, top: f.top }, width: f.width, height: f.height };
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
  if (opts.beside) {
    const other = find(opts.beside.type, opts.beside.key || '');
    const g = other ? api.getPanel(other.id)?.group : null;
    if (g) {
      const r = regionOf(g);
      return r && r !== 'center' ? { edge: r, group: g.id } : { group: g.id };
    }
  }
  if (opts.dock !== undefined) {
    if (opts.dock === 'center') return { center: true };
    if (opts.dock) return { edge: opts.dock };
    return { float: opts.at ? fromViewport(opts.at, t) : defaultFloat(inst, t, opts.near) };
  }
  if (opts.at) return { float: fromViewport(opts.at, t) };
  const last = slots.get(inst.id);
  if (last && !('float' in last && opts.freshPosition)) return last;
  const home = defaultsOf(t).dock;
  if (home === 'center') return { center: true };
  if (home) return { edge: home };
  return { float: defaultFloat(inst, t, opts.near) };
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
    } else if (!opts.restoring && (opts.dock !== undefined || opts.place)) {
      // already open, and asked to be somewhere: moved there (unpinning puts
      // the live window where the pinned one stood)
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

/** Open and actually on screen: its tab in front, its edge expanded. */
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
  const r = regionOf(panel?.group);
  if (r && r !== 'center') setEdgeCollapsed(r, false);
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
  refreshRegions();
  return { dock: regionOf(panel.group), open: true };
}

/** Where a window is now (or was last), to open another one in its place. */
function placeOf(type: string, key = ''): Place | null {
  const inst = find(type, key);
  if (!inst) return null;
  const panel = api?.getPanel(inst.id);
  return panel ? slotOf(panel) : slots.get(inst.id) || null;
}

/** Drop where a closed window would reopen, so it is placed afresh next time. */
function forget(type: string, key = '') {
  const inst = find(type, key);
  if (inst && !api?.getPanel(inst.id)) slots.delete(inst.id);
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
    // (its box: every group is about to go)
    return keepFloating && s && 'float' in s ? { float: s.float } : null;
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
    // each edge one group: the bottom first, so it runs under the center
    // only, then the side columns either side of both
    railed.clear();
    groupSize.clear();
    for (const e of ['bottom', 'left', 'right'] as Edge[]) {
      const { ids, size, collapsed } = plan.edges[e];
      edgeState[e] = { collapsed: false, size: size || EDGE_SIZE[e] };
      let first = true;
      for (const id of ids) {
        const type = id.split(':')[0];
        if (!types.has(type)) continue;
        addToEdge({ ...panelOptions(id, type, titleFor(id, type)), inactive: !first }, e);
        first = false;
      }
      edgeState[e].collapsed = !!collapsed && !first;
    }
    prioritize();
    for (const e of EDGES) applyEdge(e);
    // (sized once the grid is whole: each add splits its neighbour)
    for (const id of plan.center) {
      const t = types.get(id.split(':')[0]);
      if (t) sizeView(api.getPanel(id), t);
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
      const s = keepFloating && slot && 'float' in slot ? { float: slot.float } : { float: defaultFloat(inst, t) };
      addTo(inst.id, inst.type, titleOf(inst), s, { inactive: true });
    }
  });
  sync(true);
}

/**
 * Put every window back where the declarations say (SHELL-008): the views
 * stacked in the center, docked windows in their edge's one group in declaration
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

const SHELL_VERSION = 3;

/**
 * The shell's half of the session: the dock's own serialization (the one
 * grid, edges and their splits included, and the floating windows), each
 * edge's collapse and the size it expands to, and where closed windows reopen.
 */
function serialize() {
  const homes = {};
  for (const inst of instances.values()) {
    const t = spec(inst.type);
    if (!t.singleton || !t.persist || api?.getPanel(inst.id)) continue;
    const s = slots.get(inst.id);
    if (!s) continue;
    if ('float' in s) homes[inst.id] = { float: s.float };
    else if (!('group' in s && !('edge' in s))) homes[inst.id] = s;
  }
  const edges: Partial<Record<Edge, EdgeState>> = {};
  if (api) {
    for (const e of EDGES) {
      if (!edgeGroups(e).length) continue;
      const st = edgeState[e];
      recordSizes(e);
      const groups: Record<string, number> = {};
      for (const g of edgeGroups(e)) if (groupSize.has(g.id)) groups[g.id] = groupSize.get(g.id);
      edges[e] = { collapsed: st.collapsed, size: st.collapsed ? st.size : sizeOfEdge(e), groups };
    }
  }
  return { version: SHELL_VERSION, dock: api ? api.toJSON() : null, edges, homes };
}

/**
 * The layout from a session's shell section: the dock's own serialization
 * (version 3; a version 2 one, with the engine's edge groups, is read as one
 * first — layout-plan.ts `dockFromEdgeGroups`), or a version-1
 * `{ windows, drawers }` read through the one legacy path. Panels the session saved whose window is not back yet (a
 * pinned allocation window, recreated after a worker round-trip) hold their
 * slot as a placeholder until `open(…, { restoring: true })` fills it or
 * `dropPlaceholders` gives up on it.
 */
function restore(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !api) return;
  if ((snapshot.version === SHELL_VERSION || snapshot.version === 2) && snapshot.dock) {
    const { dock, edges } = snapshot.version === 2
      ? dockFromEdgeGroups(snapshot.dock)
      : { dock: snapshot.dock, edges: snapshot.edges || {} };
    const keep = [...instances.values()].filter((i) => !spec(i.type).persist && spec(i.type).singleton && api.getPanel(i.id));
    let ok = true;
    withBatch(() => {
      try {
        api.fromJSON(dock, { reuseExistingPanels: true });
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
      // (a transient singleton's element exists, so the engine adopts it
      // straight back rather than leaving a placeholder: the live Allocation
      // window the session saw open would come back empty)
      for (const inst of instances.values()) {
        const t = spec(inst.type);
        if (t.persist || !t.singleton || keep.includes(inst)) continue;
        const p = api.getPanel(inst.id);
        if (p) api.removePanel(p);
      }
      for (const inst of keep) {
        if (!api.getPanel(inst.id)) addTo(inst.id, inst.type, titleOf(inst), { float: defaultFloat(inst, spec(inst.type)) });
      }
      ensureFixed();
      slots.clear();
      for (const [id, s] of Object.entries(snapshot.homes || {})) {
        if (instances.has(id) && s && typeof s === 'object') slots.set(id, s as Slot);
      }
      railed.clear();
      groupSize.clear();
      for (const e of EDGES) {
        const saved: EdgeState = edges?.[e] || {};
        for (const [id, n] of Object.entries(saved.groups || {})) if (Number(n) > RAIL) groupSize.set(id, Number(n));
        const size = Number(saved.size);
        edgeState[e] = { collapsed: !!saved.collapsed, size: size > RAIL ? size : EDGE_SIZE[e] };
        applyEdge(e, true);
      }
    });
    if (!ok) {
      resetLayout();
      return;
    }
    sync(true);
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
  register, init, open, close, toggle, reveal, isOpen, isShown, element, instancesOf, location, placeOf, forget, closeAll,
  onOpen, onClose, resetLayout, serialize, restore, dropPlaceholders,
};

/** For tests: the plan-building half of the engine-free model. */
export { defaultPlan, legacyPlan };
