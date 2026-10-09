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
