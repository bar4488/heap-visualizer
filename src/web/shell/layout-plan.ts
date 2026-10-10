// Shell: layout plans. A plan is the engine-free description of a whole
// workspace — which windows stack in the center, which sit in each edge group
// (in tab order), which float — that `layout.ts` replays into the dock engine.
// Two layouts are built as plans rather than as engine calls: the default
// layout the declarations describe (SHELL-008), and the layout a session
// written before the dock engine (shell version 1: drawers and floating
// windows) describes. Keeping them as data is what lets them be tested without
// a browser.
//
// Still domain-agnostic: panels are only ids and types here.

export type Edge = 'left' | 'right' | 'bottom';
/** Where a window lives: an edge group, the center grid, or floating (null). */
export type Home = Edge | 'center' | null;

export const EDGES: Edge[] = ['left', 'right', 'bottom'];

/** What a plan needs to know about a registered panel type. */
export type TypeInfo = {
  type: string;
  singleton: boolean;
  persist: boolean;
  home: Home;
  open: boolean;
};

export type Plan = {
  /** Instance ids stacked top to bottom in the center grid. */
  center: string[];
  /** Instance ids per edge group, in tab order, and the group's size and collapse. */
  edges: Record<Edge, { ids: string[]; size?: number; collapsed?: boolean }>;
  /** Floating windows; `at` is a viewport position, absent for the default spot. */
  floating: { id: string; at?: { left: number; top: number } }[];
  /** Where a window that the plan leaves closed reopens. */
  homes: Record<string, Home>;
};

function emptyPlan(): Plan {
  return {
    center: [],
    edges: { left: { ids: [] }, right: { ids: [] }, bottom: { ids: [] } },
    floating: [],
    homes: {},
  };
}

function place(plan: Plan, id: string, home: Home, at?: { left: number; top: number }) {
  if (home === 'center') plan.center.push(id);
  else if (home) plan.edges[home].ids.push(id);
  else plan.floating.push(at ? { id, at } : { id });
}

/**
 * The default layout: every persisted singleton at its declared home, open or
 * closed as declared, in declaration order. Transient windows (allocation,
 * event, request) are not part of it — whoever applies a plan keeps them.
 */
export function defaultPlan(types: TypeInfo[]): Plan {
  const plan = emptyPlan();
  for (const t of types) {
    if (!t.singleton || !t.persist) continue;
    plan.homes[t.type] = t.home;
    if (t.open) place(plan, t.type, t.home);
  }
  return plan;
}

function px(v: unknown): number | null {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * The one read path for a version-1 shell section (`windows` + `drawers`,
 * written before the dock engine): drawers become edge groups, floating
 * windows float where they were, and anything the old session did not know
 * about (the center views, panels added since) takes its default. A window the
 * old drawers did not dock but the old session knew about floats — a saved
 * layout overrides the default wholly, not as a patch on it. Docked pinned
 * allocation windows (`type:key` in a drawer's order) keep their slot; the
 * applier holds it until the window is recreated.
 */
export function legacyPlan(legacy: { windows?: any; drawers?: any }, types: TypeInfo[]): Plan {
  const plan = emptyPlan();
  const windows = legacy.windows && typeof legacy.windows === 'object' ? legacy.windows : {};
  const drawers = legacy.drawers && typeof legacy.drawers === 'object' ? legacy.drawers : null;
  const byType = new Map(types.map((t) => [t.type, t]));
  const docked = new Set<string>();

  for (const side of ['left', 'right'] as const) {
    const ids = drawers && Array.isArray(drawers[side]) ? drawers[side] : [];
    for (const id of ids) {
      if (typeof id !== 'string' || docked.has(id)) continue;
      const colon = id.indexOf(':');
      const t = byType.get(colon < 0 ? id : id.slice(0, colon));
      if (!t) continue;
      if (colon >= 0) {
        if (t.singleton) continue;
      } else if (!t.singleton || !t.persist) {
        continue;
      }
      docked.add(id);
      if (colon < 0) plan.homes[id] = side;
      const w = windows[id];
      const open = colon >= 0 || (w ? !w.hidden : t.open);
      if (open) plan.edges[side].ids.push(id);
    }
    if (drawers) {
      const width = px(side === 'left' ? drawers.widthLeft : drawers.widthRight);
      if (width !== null) plan.edges[side].size = width;
      plan.edges[side].collapsed = !!(side === 'left' ? drawers.collapsedLeft : drawers.collapsedRight);
    }
  }

  for (const t of types) {
    if (!t.singleton || !t.persist || docked.has(t.type)) continue;
    const w = windows[t.type];
    if (t.home === 'center' || !w) {
      // not something the old session placed: its default
      plan.homes[t.type] = t.home;
      if (t.open) place(plan, t.type, t.home);
      continue;
    }
    plan.homes[t.type] = null;
    if (w.hidden) continue;
    const left = px(w.left);
    const top = px(w.top);
    place(plan, t.type, null, left !== null && top !== null ? { left, top } : undefined);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// the dock's regions
//
// The dock is one grid: the edges are ordinary columns and rows around the
// center, so they split like any other part of it. Which edge a group belongs
// to is read off the grid's shape (the engine's own serialization of it,
// `toJSON().grid`), relative to the *anchor* — the group holding the view
// that cannot be closed (the address map):
//
// - in the root split, what lies before the anchor's branch is the left edge
//   and what lies after it the right edge (a horizontal root), or the center
//   and the bottom edge (a vertical root);
// - one level down, inside the anchor's branch, the same with the axes
//   swapped: above the anchor is still the center, below it the bottom edge
//   (or left and right, under a vertical root);
// - anything deeper is the center: a split the user made inside it.
//
// So dropping a tab on the dock's outer left edge adds to the left edge,
// splitting an edge group keeps both halves in that edge, and splitting the
// map keeps both halves in the center.

export type Region = Edge | 'center';
export type Orientation = 'HORIZONTAL' | 'VERTICAL';
export type GridLeaf = { type: 'leaf'; data: { id: string; views?: string[]; [k: string]: any }; size?: number; visible?: boolean };
export type GridBranch = { type: 'branch'; data: GridNode[]; size?: number; visible?: boolean };
export type GridNode = GridLeaf | GridBranch;
export type Grid = { root: GridNode; orientation: Orientation; width?: number; height?: number };

const flip = (o: Orientation): Orientation => (o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL');

function leafIds(n: GridNode, out: string[] = []) {
  if (!n) return out;
  if (n.type === 'leaf') out.push(n.data?.id);
  else for (const c of n.data || []) leafIds(c, out);
  return out;
}

const holds = (n: GridNode, id: string | null) => !!id && leafIds(n).includes(id);

// A split with one child that is itself a split says the same as that child
// alone, with the axes swapped: the engine leaves such roots behind.
function unwrap(grid: Grid): Grid {
  let { root, orientation } = grid;
  while (root?.type === 'branch' && root.data.length === 1 && root.data[0].type === 'branch') {
    root = root.data[0];
    orientation = flip(orientation);
  }
  return { ...grid, root, orientation };
}

/** Every grid group's region, in the grid's own order (left to right, top to bottom). */
export function regionsOf(grid: Grid | null | undefined, anchor: string | null): Map<string, Region> {
  const out = new Map<string, Region>();
  if (!grid?.root) return out;
  const g = unwrap(grid);
  const found = new Map<string, Region>();
  const mark = (n: GridNode, r: Region) => { for (const id of leafIds(n)) found.set(id, r); };
  // the children of a split either side of the one holding the anchor
  const sides = (kids: GridNode[], o: Orientation): GridNode | null => {
    const i = kids.findIndex((k) => holds(k, anchor));
    if (i < 0) return null;
    kids.forEach((k, j) => {
      if (j === i) return;
      if (o === 'HORIZONTAL') mark(k, j < i ? 'left' : 'right');
      else mark(k, j < i ? 'center' : 'bottom');
    });
    return kids[i];
  };
  if (g.root.type === 'branch') {
    const mid = sides(g.root.data, g.orientation);
    if (mid?.type === 'branch') sides(mid.data, flip(g.orientation));
  }
  for (const id of leafIds(g.root)) out.set(id, found.get(id) || 'center');
  return out;
}

/**
 * Where a new bottom edge goes: below this group (the last one in the
 * anchor's column, so the bottom edge spans the center but not the side
 * edges), or — null — below the whole grid.
 */
export function bottomReference(grid: Grid | null | undefined, anchor: string | null): string | null {
  if (!grid?.root) return null;
  const g = unwrap(grid);
  if (g.root.type !== 'branch' || g.orientation !== 'HORIZONTAL') return null;
  const mid = g.root.data.find((k) => holds(k, anchor));
  if (!mid) return null;
  if (mid.type === 'leaf') return mid.data.id;
  const last = mid.data[mid.data.length - 1];
  return last?.type === 'leaf' ? last.data.id : null;
}

/** What the grid does not keep about an edge: whether it is collapsed, and the size it expands to. */
export type EdgeState = { collapsed?: boolean; size?: number; groups?: Record<string, number> };

/** The width (or height) of a collapsed edge: its tab strip. */
export const RAIL = 27;

/**
 * A version-2 dock layout (the engine's edge groups: one group per side,
 * outside the grid) as a version-3 one (the edges as columns and rows of the
 * one grid). The center keeps its tree; the bottom group goes under it, the
 * left and right groups either side of both; each keeps its id, tabs, active
 * tab and size. An edge that was collapsed is so in the returned edge state.
 * Floating windows keep their spot on screen: they were measured from the
 * old center, and are now measured from the whole dock.
 */
export function dockFromEdgeGroups(dock: any): { dock: any; edges: Partial<Record<Edge, EdgeState>> } {
  const edges: Partial<Record<Edge, EdgeState>> = {};
  if (!dock || typeof dock !== 'object' || !dock.edgeGroups || !dock.grid?.root) return { dock, edges };
  const { edgeGroups, ...rest } = dock;
  const old = unwrap(dock.grid);
  const width = old.width || 0;
  const height = old.height || 0;
  const leaf = (e: Edge): GridLeaf | null => {
    const g = edgeGroups[e];
    if (!g || g.visible === false || !g.group || !(g.group.views || []).length) return null;
    const size = Number.isFinite(g.size) && g.size > 0 ? g.size : e === 'bottom' ? 240 : 300;
    edges[e] = { collapsed: !!g.collapsed, size };
    const data = { ...g.group };
    if (e === 'bottom') delete data.headerPosition;
    else data.headerPosition = e;
    return { type: 'leaf', data, size };
  };
  const left = leaf('left');
  const right = leaf('right');
  const bottom = leaf('bottom');
  // the old center as children of a split along `o`: its root's children
  // when the root runs the same way, else the root itself
  const center = (o: Orientation, size: number): GridNode[] => {
    if (old.root.type === 'branch' && old.orientation === o) return old.root.data;
    return [{ ...old.root, size }];
  };
  const middle: GridNode[] = bottom
    ? [{ type: 'branch', size: width, data: [...center('VERTICAL', height), bottom] }]
    : center('HORIZONTAL', width);
  const shown = (e: Edge) => (edges[e] ? (edges[e].collapsed ? RAIL : edges[e].size) : 0);
  const total = { width: width + shown('left') + shown('right'), height: height + shown('bottom') };
  const grid: Grid = {
    root: { type: 'branch', size: total.height, data: [...(left ? [left] : []), ...middle, ...(right ? [right] : [])] },
    orientation: 'HORIZONTAL',
    width: total.width,
    height: total.height,
  };
  const out: any = { ...rest, grid };
  if (Array.isArray(dock.floatingGroups)) {
    out.floatingGroups = dock.floatingGroups.map((f) => (Number.isFinite(f?.position?.left)
      ? { ...f, position: { ...f.position, left: f.position.left + shown('left') } } : f));
  }
  return { dock: out, edges };
}
