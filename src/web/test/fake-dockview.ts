// A stand-in for the slice of Dockview (dockview-core) that shell/layout.ts
// drives, for `node --test`. Not Dockview: it keeps groups and panels as plain
// data, calls the layout's content and tab renderers the way Dockview does
// (create on add, dispose on remove, kept across `fromJSON` with
// reuseExistingPanels), and keeps the grid as a tree of splits shaped the way
// Dockview shapes it — a split next to a group joins that group's split when
// it runs the same way and wraps the group in a new one when it does not, an
// absolute direction splits the root, a split left with one child folds away
// — and serializes it in Dockview's own JSON shape (`grid`, `panels`,
// `floatingGroups`). What it pins is the shell's bookkeeping on top of the
// engine — which window is open where, which edge a group is in, hooks,
// adoption, the session round trip — not Dockview's geometry, which a person
// checks in the browser: a size is whatever was last set.

class Emitter<T = any> {
  private fns: ((e: T) => void)[] = [];
  readonly event = (fn: (e: T) => void) => {
    this.fns.push(fn);
    return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } };
  };
  fire(e?: T) { for (const fn of [...this.fns]) fn(e); }
}

type Loc = { type: 'grid' } | { type: 'floating' };
type O = 'HORIZONTAL' | 'VERTICAL';
type Leaf = { kind: 'leaf'; group: FakeGroup };
type Branch = { kind: 'branch'; children: Node[] };
type Node = Leaf | Branch;

const flip = (o: O): O => (o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL');

class FakeGroup {
  [k: string]: any;
  panels: FakePanel[] = [];
  activePanel: FakePanel | null = null;
  size: any = null;
  box: any = null;
  constraints: any = {};
  headerPosition = 'top';

  constructor(id: string, loc: Loc) {
    this.id = id;
    this.loc = loc;
    const g = this;
    this.api = {
      get location() { return g.loc; },
      get boundingBox() { return g.box; },
      get width() { return g.size?.width ?? 0; },
      get height() { return g.size?.height ?? 0; },
      setSize(s) { g.size = { ...g.size, ...s }; },
      setConstraints(c) { g.constraints = { ...g.constraints, ...c }; },
      isMaximized: () => false,
      maximize() {},
      exitMaximized() {},
      onDidLocationChange: new Emitter().event,
      getHeaderPosition: () => g.headerPosition,
      setHeaderPosition(p) { g.headerPosition = p; },
    };
  }

  setActive(p: FakePanel | null) {
    const prev = this.activePanel;
    this.activePanel = p;
    if (prev && prev !== p) prev.visibility.fire({ isVisible: false });
    if (p && prev !== p) p.visibility.fire({ isVisible: true });
  }

  toJSON() {
    const d: any = { views: this.panels.map((p) => p.id), activeView: this.activePanel?.id, id: this.id };
    if (this.headerPosition !== 'top') d.headerPosition = this.headerPosition;
    return d;
  }
}

class FakePanel {
  [k: string]: any;
  group: FakeGroup = null;
  renderer: any = null;
  tab: any = null;
  readonly visibility = new Emitter();
  readonly titleChange = new Emitter();

  constructor(id: string, component: string, title: string, owner: FakeDockview) {
    this.id = id;
    this.component = component;
    this.title = title;
    const p = this;
    this.api = {
      id,
      close: () => owner.removePanel(p),
      setActive: () => p.group.setActive(p),
      setTitle: (t: string) => { p.title = t; p.titleChange.fire({ title: t }); },
      get isVisible() { return p.group?.activePanel === p; },
      get group() { return p.group; },
      onDidVisibilityChange: this.visibility.event,
      onDidTitleChange: this.titleChange.event,
    };
  }

  toJSON() {
    const j: any = { id: this.id, contentComponent: this.component, title: this.title };
    if (this.tabComponent) j.tabComponent = this.tabComponent;
    return j;
  }
}

export class FakeDockview {
  [k: string]: any;
  private groupMap = new Map<string, FakeGroup>();
  private root: Branch = { kind: 'branch', children: [] };
  orientation: O = 'HORIZONTAL';
  private seq = 0;
  private readonly added = new Emitter();
  private readonly removed = new Emitter();
  private readonly layoutChange = new Emitter();
  readonly onDidAddPanel = this.added.event;
  readonly onDidRemovePanel = this.removed.event;
  readonly onDidLayoutChange = this.layoutChange.event;
  readonly onDidMaximizedGroupChange = new Emitter().event;

  constructor(options: any) { this.options = options; }

  get groups() { return [...this.groupMap.values()]; }
  get panels() { return this.groups.flatMap((g) => g.panels); }
  getGroup(id: string) { return this.groupMap.get(id); }
  getPanel(id: string) { return this.panels.find((p) => p.id === id); }

  // --- the grid ------------------------------------------------------------

  private newGroup(loc: Loc, id = String(++this.seq)) {
    const g = new FakeGroup(id, loc);
    this.groupMap.set(g.id, g);
    // the header actions Dockview renders at the end of each group's tab strip
    const actions = this.options.createRightHeaderActionComponent?.(g);
    if (actions) {
      g.actions = actions;
      actions.init?.({ group: g, api: this });
    }
    return g;
  }

  /** The leaf holding `g`, its parent split, and that split's depth. */
  private find(g: FakeGroup, n: Branch = this.root, depth = 0): { parent: Branch; index: number; depth: number } | null {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c.kind === 'leaf' && c.group === g) return { parent: n, index: i, depth };
      if (c.kind === 'branch') {
        const r = this.find(g, c, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  private orientationAt(depth: number): O { return depth % 2 ? flip(this.orientation) : this.orientation; }

  private splitNext(ref: FakeGroup, direction: string, g: FakeGroup) {
    const at = this.find(ref);
    if (!at) throw new Error(`group ${ref.id} is not in the grid`);
    const want: O = direction === 'left' || direction === 'right' ? 'HORIZONTAL' : 'VERTICAL';
    const after = direction === 'right' || direction === 'below';
    const leaf: Leaf = { kind: 'leaf', group: g };
    if (this.orientationAt(at.depth) === want) {
      at.parent.children.splice(at.index + (after ? 1 : 0), 0, leaf);
    } else {
      const old = at.parent.children[at.index];
      at.parent.children[at.index] = { kind: 'branch', children: after ? [old, leaf] : [leaf, old] };
    }
  }

  private splitRoot(direction: string, g: FakeGroup) {
    const want: O = direction === 'left' || direction === 'right' ? 'HORIZONTAL' : 'VERTICAL';
    // (Dockview normalizes first: a root whose one child is a split is that split)
    while (this.root.children.length === 1 && this.root.children[0].kind === 'branch') {
      this.root = this.root.children[0] as Branch;
      this.orientation = flip(this.orientation);
    }
    if (this.orientation !== want) {
      if (this.root.children.length > 1) this.root = { kind: 'branch', children: [this.root] };
      this.orientation = want;
    }
    const leaf: Leaf = { kind: 'leaf', group: g };
    if (direction === 'left' || direction === 'above') this.root.children.unshift(leaf);
    else this.root.children.push(leaf);
  }

  private unlink(g: FakeGroup) {
    const at = this.find(g);
    if (!at) return;
    at.parent.children.splice(at.index, 1);
    // a split left with one child folds into its parent
    const fold = (n: Branch, parent: Branch | null) => {
      for (const c of [...n.children]) if (c.kind === 'branch') fold(c, n);
      if (!parent || n.children.length !== 1) return;
      const i = parent.children.indexOf(n);
      const only = n.children[0];
      if (only.kind === 'branch') parent.children.splice(i, 1, ...only.children);
      else parent.children[i] = only;
    };
    fold(this.root, null);
    if (!this.root.children.length) this.orientation = 'HORIZONTAL';
  }

  private groupFor(o: any): FakeGroup {
    if (o.floating) {
      const g = this.newGroup({ type: 'floating' });
      const f = o.floating === true ? {} : o.floating;
      g.box = { left: f.position?.left ?? 100, top: f.position?.top ?? 100, width: f.width ?? 300, height: f.height ?? 300 };
      return g;
    }
    const pos = o.position;
    const within = pos && (!pos.direction || pos.direction === 'within');
    let ref: FakeGroup | null = null;
    if (pos?.referenceGroup) {
      ref = typeof pos.referenceGroup === 'string' ? this.groupMap.get(pos.referenceGroup) : pos.referenceGroup;
      if (!ref) throw new Error(`no group ${pos.referenceGroup}`);
    } else if (pos?.referencePanel) {
      const p = typeof pos.referencePanel === 'string' ? this.getPanel(pos.referencePanel) : pos.referencePanel;
      if (!p) throw new Error(`no panel ${pos.referencePanel}`);
      ref = p.group;
    }
    if (ref && (within || ref.loc.type === 'floating')) return ref;
    const g = this.newGroup({ type: 'grid' });
    if (ref) this.splitNext(ref, pos.direction, g);
    else if (pos?.direction) this.splitRoot(pos.direction, g);
    else this.root.children.push({ kind: 'leaf', group: g });
    return g;
  }

  // --- panels --------------------------------------------------------------

  private create(id: string, component: string, title: string, tabComponent?: string) {
    const p = new FakePanel(id, component, title, this);
    p.tabComponent = tabComponent;
    p.renderer = this.options.createComponent({ id, name: component });
    p.renderer.init?.({ api: p.api, title, params: {} });
    p.tab = this.options.createTabComponent?.({ id, name: tabComponent ?? this.options.defaultTabComponent });
    p.tab?.init?.({ api: p.api, title });
    return p;
  }

  addPanel(o: any) {
    if (this.getPanel(o.id)) throw new Error(`panel ${o.id} already exists`);
    const g = this.groupFor(o);
    const p = this.create(o.id, o.component, o.title, o.tabComponent);
    p.group = g;
    g.panels.push(p);
    if (!o.inactive || !g.activePanel) g.setActive(p);
    this.added.fire(p);
    this.layoutChange.fire();
    return p;
  }

  addFloatingGroup(p: FakePanel, o: any) {
    this.detach(p);
    const g = this.newGroup({ type: 'floating' });
    g.box = { left: o.position?.left ?? 100, top: o.position?.top ?? 100, width: o.width ?? 300, height: o.height ?? 300 };
    p.group = g;
    g.panels.push(p);
    g.setActive(p);
    this.layoutChange.fire();
  }

  private detach(p: FakePanel) {
    const g = p.group;
    g.panels = g.panels.filter((x) => x !== p);
    if (g.activePanel === p) g.setActive(g.panels[g.panels.length - 1] || null);
    if (!g.panels.length) {
      this.groupMap.delete(g.id);
      this.unlink(g);
      g.actions?.dispose?.();
    }
    p.group = null;
  }

  private dispose(p: FakePanel) {
    p.tab?.dispose?.();
    p.renderer.dispose?.();
  }

  removePanel(p: FakePanel) {
    if (!p.group) return;
    this.detach(p);
    this.dispose(p);
    this.removed.fire(p);
    this.layoutChange.fire();
  }

  clear() {
    for (const p of this.panels) this.removePanel(p);
  }

  // --- serialization -------------------------------------------------------

  toJSON() {
    const ser = (n: Node): any => (n.kind === 'leaf'
      ? { type: 'leaf', data: n.group.toJSON(), size: n.group.size?.width ?? n.group.size?.height ?? 0 }
      : { type: 'branch', data: n.children.map(ser), size: 0 });
    const floating = this.groups.filter((g) => g.loc.type === 'floating');
    const out: any = {
      grid: { root: ser(this.root), width: 1000, height: 700, orientation: this.orientation },
      panels: Object.fromEntries(this.panels.map((p) => [p.id, p.toJSON()])),
    };
    if (floating.length) out.floatingGroups = floating.map((g) => ({ data: g.toJSON(), position: { ...g.box } }));
    return out;
  }

  fromJSON(json: any, opts: { reuseExistingPanels?: boolean } = {}) {
    if (!json?.grid?.root || !json.panels) throw new Error('fake dockview: bad layout');
    const keep = new Map<string, FakePanel>();
    for (const p of this.panels) {
      if (opts.reuseExistingPanels && json.panels[p.id]) {
        this.detach(p);
        keep.set(p.id, p);
      } else {
        this.removePanel(p);
      }
    }
    this.groupMap.clear();
    const fill = (g: FakeGroup, data: any) => {
      if (data.headerPosition) g.headerPosition = data.headerPosition;
      this.seq = Math.max(this.seq, +data.id || 0);
      for (const id of data.views || []) {
        const pj = json.panels[id];
        if (!pj) continue;
        let p = keep.get(id);
        if (p) keep.delete(id);
        else {
          p = this.create(id, pj.contentComponent, pj.title, pj.tabComponent);
          this.added.fire(p);
        }
        p.group = g;
        g.panels.push(p);
      }
      g.activePanel = g.panels.find((p) => p.id === data.activeView) || g.panels[0] || null;
    };
    const build = (n: any): Node => {
      if (n.type === 'leaf') {
        const g = this.newGroup({ type: 'grid' }, n.data.id);
        g.size = n.size ? { width: n.size } : null;
        fill(g, n.data);
        return { kind: 'leaf', group: g };
      }
      return { kind: 'branch', children: (n.data || []).map(build) };
    };
    const root = build(json.grid.root);
    this.root = root.kind === 'branch' ? root : { kind: 'branch', children: [root] };
    this.orientation = json.grid.orientation || 'HORIZONTAL';
    for (const f of json.floatingGroups || []) {
      const g = this.newGroup({ type: 'floating' }, f.data.id);
      g.box = { ...f.position };
      fill(g, f.data);
    }
    for (const p of keep.values()) {
      this.dispose(p);
      this.removed.fire(p);
    }
    this.layoutChange.fire();
  }
}

// typed loosely: it stands in for DockviewApi only as far as the shell uses it
export function createFakeDockview(_host: any, options: any): any {
  return new FakeDockview(options);
}
