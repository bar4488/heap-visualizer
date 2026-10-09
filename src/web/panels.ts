// The panel table, assembled from per-domain tables (SHELL-003). The heap's
// table (heap/panels.ts) declares the views and the heap's windows; any other
// domain declares its panels from its own module through a registration hook,
// so a new domain's panels need no bespoke wiring in main.ts.
//
// A domain module exports one function that receives a PanelContext and calls
// `ctx.addPanel(record)` once per panel it declares, at startup (before the
// dock lays out). main.ts lists the modules with the domain each one `needs`;
// every panel a module adds needs that domain: its toolbar toggle shows, and
// it starts open, only when the loaded trace has records of the domain.
//
// The PanelContext contract (what a module may rely on):
//
//   layout          the shell's panel API (shell/layout.ts): open, close,
//                   reveal, isOpen, onOpen, onClose, element …
//   post(msg)       send a fire-and-forget command to the worker (seek: `{type:
//                   'jump', seq}`, playhead to after record seq is `seq + 1`)
//   request(type, payload)               one query, one reply (rpc.ts)
//   requestLatest(key, type, payload)    coalesced per key (rpc.ts); use keys
//                                        prefixed with the domain id
//   ui              the shared main-thread state, read-only to a module:
//                   `ui.loaded`, `ui.meta` (TraceMeta: `meta.domains` holds
//                   every descriptor, `meta.n`, `meta.tMin`/`tMax`, `meta.unit`),
//                   `ui.state` (the last worker `state`: `seq` = records
//                   applied, `t`, `n`, `playing`, `tlT`, `tlS`), `ui.tlT` /
//                   `ui.tlS` (the strips' view ranges), `ui.setView[0|1](range)`
//                   (zoom the time / event-index strip)
//   onState(fn)     fn(state) after every worker `state` message (playhead
//                   moves, playback); returns an unsubscribe function
//   onView(fn)      fn({t, seq}) when either strip's view range changes,
//                   with both ranges; returns an unsubscribe function
//   setView(axis, range)  zoom/pan a strip: axis 't' (time) or 'seq' (event
//                   index), range {lo, hi}; the other strip follows (mirrored)
//   select(axis, range, at?)  the strips' range selection (TL-004 shift+drag):
//                   a range sets it (band and mirror), null clears it, and
//                   `at` {x, y} (client px) ends it and opens its popover
//   onLoad(fn)      fn(meta) at the end of every trace load, after `ui.meta`
//                   is the new trace's and every panel's refill has run, and
//                   after the default layout is applied; returns an
//                   unsubscribe function
//   domain          the domain this module was registered for ('intervals')
//   present()       whether the loaded trace has records of that domain
//   addPanel(rec)   declare a panel (DomainPanel below); registered with the
//                   shell at once. A module may instead call
//                   `layout.register` itself and decide its own default
//                   placement (read `ui.meta.intervals` / `meta.domains`)
//
// Modules run once at startup, after the heap's panels are registered and
// before the first default layout is applied.
//
// A trace load calls each added panel's `refill` (after `ui.meta` is the new
// trace's), in table order, as for every other panel.

import type { Placement } from './shell/layout.ts';
import type { DomainDescriptor, QueryPayload, QueryType, Range, ReplyTo } from './protocol.ts';

/** One panel: the record SHELL-003 asks for (see heap/panels.ts for each field). */
export type PanelRecord = {
  id: string;
  title: string;
  toggle: string | null;
  dock: Placement['dock'];
  open: boolean;
  /** The evidence domain the panel presents; it starts open only when the trace has its records. */
  needs?: string;
  persist?: boolean;
  multi?: boolean;
  closable?: boolean;
  size?: number;
  float?: { width: number; height: number };
  autoPlace?: { avoid: string[] };
  /** The panel's element, for a panel not in index.html (a domain module's). */
  build?: () => any;
  /** The hook creates the toolbar button `toggle` names (a domain module's own). */
  ownToggle?: boolean;
  /** The toolbar button's tooltip, for a toggle the hook creates. */
  hint?: string;
  refill: (() => void) | null;
};

/**
 * A panel a domain module declares. `toggle: true` asks for a toolbar button
 * (`btn-<id>`, labelled with the title), created and shown only when the
 * trace has the domain; a string names an existing button; absent, none.
 */
export type DomainPanel = Omit<PanelRecord, 'toggle' | 'refill' | 'needs' | 'build' | 'ownToggle'> & {
  toggle?: boolean | string | null;
  build: () => any;
  refill?: (() => void) | null;
};

export type ViewRanges = { t: Range; seq: Range };

export type PanelContext = {
  layout: any;
  post: (m: any) => void;
  request: <T extends QueryType>(type: T, payload?: QueryPayload<T>) => Promise<ReplyTo[T]>;
  requestLatest: <T extends QueryType>(key: string, type: T, payload?: QueryPayload<T>) => Promise<ReplyTo[T]>;
  ui: any;
  onState: (fn: (state: any) => void) => () => void;
  onView: (fn: (view: ViewRanges) => void) => () => void;
  setView: (axis: 't' | 'seq', range: Range) => void;
  select?: (axis: 't' | 'seq', range: Range | null, at?: { x: number; y: number }) => void;
  onLoad: (fn: (meta: any) => void) => () => void;
  domain: string;
  present: () => boolean;
  addPanel: (record: DomainPanel) => void;
};

export type PanelModule = { needs: string; register: (ctx: PanelContext) => void };

/** Whether `meta` lists records of domain `id` (DOM-004 descriptors). */
export function domainPresent(domains: DomainDescriptor[] | null | undefined, id: string): boolean {
  return !!domains?.some((d) => d.id === id && d.count > 0);
}

/** A tiny listener list: `add` returns its own removal. */
export function listeners<A>() {
  const fns = new Set<(a: A) => void>();
  return {
    add(fn: (a: A) => void) { fns.add(fn); return () => { fns.delete(fn); }; },
    emit(a: A) {
      for (const fn of [...fns]) {
        try { fn(a); } catch (err) { console.error(err); }
      }
    },
  };
}

/**
 * Run each module's registration and return the panels they declared, each
 * marked as needing its module's domain. An id the table already has, or one
 * declared twice, throws: the table is the one place an id is written.
 */
export function domainPanels(
  modules: PanelModule[],
  base: Omit<PanelContext, 'domain' | 'present' | 'addPanel'>,
  taken: string[] = [],
  onAdd: (record: PanelRecord) => void = () => {},
): PanelRecord[] {
  const out: PanelRecord[] = [];
  const ids = new Set(taken);
  for (const mod of modules) {
    const ctx: PanelContext = {
      ...base,
      domain: mod.needs,
      present: () => domainPresent(base.ui?.meta?.domains, mod.needs),
      addPanel(rec) {
        if (ids.has(rec.id)) throw new Error(`panel declared twice: ${rec.id}`);
        ids.add(rec.id);
        const toggle = rec.toggle === true ? `btn-${rec.id}` : (rec.toggle || null);
        const record: PanelRecord = { ...rec, toggle, ownToggle: rec.toggle === true, needs: mod.needs, refill: rec.refill || null };
        out.push(record);
        onAdd(record);
      },
    };
    mod.register(ctx);
  }
  return out;
}
