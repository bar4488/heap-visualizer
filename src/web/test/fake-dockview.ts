// A stand-in for the slice of Dockview (dockview-core) that shell/layout.ts
// drives, for `node --test`. Not Dockview: it keeps groups and panels as plain
// data, calls the layout's content renderers the way Dockview does (create on
// add, dispose on remove, kept across `fromJSON` with reuseExistingPanels), and
// serializes to its own JSON. What it pins is the shell's bookkeeping on top of
// the engine — which window is open where, hooks, adoption, the session round
// trip — not Dockview's geometry, which a person checks in the browser.

class Emitter<T = any> {
  private fns: ((e: T) => void)[] = [];
  readonly event = (fn: (e: T) => void) => {
    this.fns.push(fn);
    return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } };
  };
  fire(e?: T) { for (const fn of [...this.fns]) fn(e); }
}

type Loc = { type: 'grid' } | { type: 'floating' } | { type: 'edge'; position: string };

class FakeGroup {
  [k: string]: any;
  panels: FakePanel[] = [];
  activePanel: FakePanel | null = null;
  collapsed = false;
  size: any = null;
  box: any = null;
  readonly collapsedChange = new Emitter();

  constructor(id: string, loc: Loc) {
    this.id = id;
    this.loc = loc;
    const g = this;
    this.api = {
      get location() { return g.loc; },
      get boundingBox() { return g.box; },
      collapse() { if (g.loc.type === 'edge' && !g.collapsed) { g.collapsed = true; g.collapsedChange.fire({ isCollapsed: true }); } },
      expand() { if (g.loc.type === 'edge' && g.collapsed) { g.collapsed = false; g.collapsedChange.fire({ isCollapsed: false }); } },
      isCollapsed: () => g.loc.type === 'edge' && g.collapsed,
      setSize(s) { g.size = { ...g.size, ...s }; },
      isMaximized: () => false,
      onDidCollapsedChange: this.collapsedChange.event,
      onDidLocationChange: new Emitter().event,
      // like the engine: an edge group's tab strip starts on its own side
      getHeaderPosition: () => g.headerPosition,
      setHeaderPosition(p) { g.headerPosition = p; },
    };
    this.headerPosition = loc.type === 'edge' ? (loc as any).position : 'top';
  }

  setActive(p: FakePanel | null) {
    const prev = this.activePanel;
    this.activePanel = p;
    if (prev && prev !== p) prev.visibility.fire({ isVisible: false });
    if (p && prev !== p) p.visibility.fire({ isVisible: true });
  }
}

class FakePanel {
  [k: string]: any;
  group: FakeGroup = null;
  renderer: any = null;
  readonly visibility = new Emitter();
  readonly titleChange = new Emitter();

  constructor(id: string, component: string, title: string, owner: FakeDockview) {
    this.id = id;
    this.component = component;
    this.title = title;
    const p = this;
    this.api = {
      close: () => owner.removePanel(p),
      setActive: () => p.group.setActive(p),
      setTitle: (t: string) => { p.title = t; p.titleChange.fire({ title: t }); },
      get isVisible() { return p.group?.activePanel === p; },
      get group() { return p.group; },
      onDidVisibilityChange: this.visibility.event,
      onDidTitleChange: this.titleChange.event,
    };
  }

  toJSON() { return { id: this.id, component: this.component, title: this.title }; }
}

export class FakeDockview {
  [k: string]: any;
  private groupMap = new Map<string, FakeGroup>();
  private edgeVisible = new Map<string, boolean>();
  private seq = 0;
  private readonly added = new Emitter();
  private readonly removed = new Emitter();
  private readonly layoutChange = new Emitter();
  readonly onDidAddPanel = this.added.event;
  readonly onDidRemovePanel = this.removed.event;
  readonly onDidLayoutChange = this.layoutChange.event;
  readonly onWillDragPanel = new Emitter().event;
  readonly onWillDragGroup = new Emitter().event;
  readonly onDidMaximizedGroupChange = new Emitter().event;

  constructor(options: any) { this.options = options; }

  get groups() { return [...this.groupMap.values()]; }
  get panels() { return this.groups.flatMap((g) => g.panels); }
  getGroup(id: string) { return this.groupMap.get(id); }
  getPanel(id: string) { return this.panels.find((p) => p.id === id); }

  addEdgeGroup(position: string, o: any) {
    const g = new FakeGroup(o.id, { type: 'edge', position });
    g.collapsed = !!o.collapsed;
    g.size = { size: o.initialSize };
    this.groupMap.set(g.id, g);
    this.edgeVisible.set(position, true);
    return g.api;
  }

  private edge(position: string) { return this.groups.find((g) => g.loc.type === 'edge' && (g.loc as any).position === position); }
  getEdgeGroup(position: string) { return this.edge(position)?.api; }
  setEdgeGroupVisible(position: string, v: boolean) { this.edgeVisible.set(position, v); }
  isEdgeGroupVisible(position: string) { return !!this.edgeVisible.get(position); }

  private newGroup(loc: Loc) {
    const g = new FakeGroup(String(++this.seq), loc);
    this.groupMap.set(g.id, g);
    return g;
  }

  private groupFor(o: any): FakeGroup {
    if (o.floating) {
      const g = this.newGroup({ type: 'floating' });
      const f = o.floating === true ? {} : o.floating;
      g.box = { left: f.position?.left ?? 100, top: f.position?.top ?? 100, width: f.width ?? 300, height: f.height ?? 300 };
      return g;
    }
    const pos = o.position;
    const within = !pos?.direction || pos.direction === 'within';
    if (pos?.referenceGroup) {
      const ref = typeof pos.referenceGroup === 'string' ? this.groupMap.get(pos.referenceGroup) : pos.referenceGroup;
      if (!ref) throw new Error(`no group ${pos.referenceGroup}`);
      if (within) return ref;
    } else if (pos?.referencePanel) {
      const ref = typeof pos.referencePanel === 'string' ? this.getPanel(pos.referencePanel) : pos.referencePanel;
      if (!ref) throw new Error(`no panel ${pos.referencePanel}`);
      if (within) return ref.group;
    }
    return this.newGroup({ type: 'grid' });
  }

  private create(id: string, component: string, title: string) {
    const p = new FakePanel(id, component, title, this);
    p.renderer = this.options.createComponent({ id, name: component });
    p.tab = component && this.options.createTabComponent?.({ id, name: component });
    return p;
  }

  addPanel(o: any) {
    if (this.getPanel(o.id)) throw new Error(`panel ${o.id} already exists`);
    const g = this.groupFor(o);
    const p = this.create(o.id, o.component, o.title);
    p.tabComponent = o.tabComponent;
    p.group = g;
    g.panels.push(p);
    p.renderer.init?.({ api: p.api, title: o.title, params: o.params || {} });
    if (!o.inactive || !g.activePanel) g.setActive(p);
    this.added.fire(p);
    this.layoutChange.fire();
    return p;
  }

  private detach(p: FakePanel) {
    const g = p.group;
    g.panels = g.panels.filter((x) => x !== p);
    if (g.activePanel === p) g.setActive(g.panels[g.panels.length - 1] || null);
    if (!g.panels.length && g.loc.type !== 'edge') this.groupMap.delete(g.id);
    p.group = null;
  }

  removePanel(p: FakePanel) {
    if (!p.group) return;
    this.detach(p);
    p.renderer.dispose?.();
    this.removed.fire(p);
    this.layoutChange.fire();
  }

  clear() {
    for (const p of this.panels) this.removePanel(p);
  }

  toJSON() {
    return {
      groups: this.groups.map((g) => ({
        id: g.id, loc: g.loc, views: g.panels.map((p) => p.id), active: g.activePanel?.id ?? null,
        collapsed: g.collapsed, size: g.size, box: g.box,
      })),
      panels: Object.fromEntries(this.panels.map((p) => [p.id, p.toJSON()])),
      edgeVisible: Object.fromEntries(this.edgeVisible),
    };
  }

  fromJSON(json: any, opts: { reuseExistingPanels?: boolean } = {}) {
    if (!json || !Array.isArray(json.groups) || !json.panels) throw new Error('fake dockview: bad layout');
    const keep = new Map<string, FakePanel>();
    for (const p of this.panels) {
      if (opts.reuseExistingPanels && json.panels[p.id]) {
        this.detach(p);
        keep.set(p.id, p);
      } else {
        this.removePanel(p);
      }
    }
    for (const g of this.groups) if (g.loc.type !== 'edge') this.groupMap.delete(g.id);
    for (const sg of json.groups) {
      let g: FakeGroup;
      if (sg.loc.type === 'edge') g = this.edge(sg.loc.position);
      else {
        g = new FakeGroup(sg.id, sg.loc);
        this.groupMap.set(g.id, g);
        this.seq = Math.max(this.seq, +sg.id || 0);
      }
      g.collapsed = !!sg.collapsed;
      g.size = sg.size;
      g.box = sg.box;
      for (const id of sg.views) {
        const pj = json.panels[id];
        if (!pj) continue;
        let p = keep.get(id);
        if (p) keep.delete(id);
        else {
          p = this.create(id, pj.component, pj.title);
          p.renderer.init?.({ api: p.api, title: pj.title, params: {} });
          this.added.fire(p);
        }
        p.group = g;
        g.panels.push(p);
      }
      g.activePanel = g.panels.find((p) => p.id === sg.active) || g.panels[0] || null;
    }
    for (const p of keep.values()) {
      p.renderer.dispose?.();
      this.removed.fire(p);
    }
    for (const [k, v] of Object.entries(json.edgeVisible || {})) this.edgeVisible.set(k, !!v);
    this.layoutChange.fire();
  }
}

// typed loosely: it stands in for DockviewApi only as far as the shell uses it
export function createFakeDockview(_host: any, options: any): any {
  return new FakeDockview(options);
}
