// Interval domain (spec/14, IVL-UI): the entry point main.ts calls once.
// It declares the three panels to the shell — State, Tracks and Intervals —
// fetches the trace's interval summary once per loaded trace, and fans the
// playhead and the strips' view out to the panels.
//
// Everything is reached through `ctx` (layout, rpc, the UI snapshot and two
// subscriptions), so this module names no other domain and no element of
// index.html beyond the toolbar it adds its toggles to.

import { createListPanel } from './list-panel.ts';
import { createStatePanel } from './state-panel.ts';
import { createTracksPanel } from './tracks-panel.ts';
import { present, type Shared } from './shared.ts';
import type { IntervalCtx, Views } from './types.ts';
import type { PanelContext } from '../panels.ts';

export type { IntervalCtx } from './types.ts';

/** Panel types, toolbar toggles, and where each starts (SHELL-008). */
const PANELS = [
  { type: 'intervals-tracks', title: 'Tracks', btn: 'btn-ivl-tracks', label: 'Tracks', dock: 'bottom' as const, open: true,
    hint: 'Calls, spans and CPU run slices as a flame chart on the timeline\'s x-axis' },
  { type: 'intervals-state', title: 'Stacks', btn: 'btn-ivl-state', label: 'Stacks', dock: 'right' as const, open: true,
    hint: 'The call stacks, open spans and CPUs at the playhead' },
  { type: 'intervals-list', title: 'Intervals', btn: 'btn-ivl-list', label: 'Intervals', dock: 'left' as const, open: false,
    hint: 'Every call, span and run slice, filterable, with durations' },
];

export function registerIntervalPanels(panelCtx: PanelContext) {
  // The panels read the worker replies through the typed view in types.ts;
  // the wire itself is protocol.ts's, which main.ts's rpc helpers enforce.
  const ctx = panelCtx as unknown as IntervalCtx;
  const sh: Shared = { ctx, trace: { gen: 0, total: -1, tracks: { threads: [], cpus: [] } }, playhead: null };
  const tracks = createTracksPanel(sh);
  const state = createStatePanel(sh);
  const list = createListPanel(sh);
  const panels = { 'intervals-tracks': tracks, 'intervals-state': state, 'intervals-list': list };

  addToggles();
  for (const p of PANELS) {
    const impl = panels[p.type];
    ctx.layout.register(p.type, {
      title: p.title,
      singleton: true,
      toggle: document.getElementById(p.btn) ? p.btn : null,
      floatSize: p.type === 'intervals-tracks' ? { width: 720, height: 320 } : { width: 420, height: 420 },
      // read when applied: they start open only for a trace with intervals
      defaultLocation: () => ({ dock: p.dock, open: p.open && present(sh) }),
      build: () => impl.el,
      onOpen: () => impl.refresh(),
    });
  }

  let lastMeta: unknown = undefined;
  const newTrace = () => {
    const tr = sh.trace;
    tr.gen++;
    tr.total = -1;
    tr.tracks = { threads: [], cpus: [] };
    syncToggles();
    for (const p of Object.values(panels)) p.reset();
    if (!ctx.ui.loaded) return;
    const gen = tr.gen;
    void Promise.all([ctx.request('domains', {}), ctx.request('tracks', {})]).then(([dm, tk]) => {
      if (gen !== tr.gen) return;
      const d = (dm.available && Array.isArray((dm as any).domains) ? (dm as any).domains : []).find((x: any) => x?.id === 'intervals') as any;
      tr.total = d && typeof d.intervals === 'number' ? d.intervals : 0;
      if (tk.available && tk.result) tr.tracks = tk.result;
      syncToggles();
      // without `meta.intervals` the layout could not know at load time
      // whether to open the panels: open the default-open ones now
      if (ctx.ui.meta && ctx.ui.meta.intervals === undefined && present(sh)) {
        for (const p of PANELS) if (p.open && !ctx.layout.isOpen(p.type)) ctx.layout.reveal(p.type);
      }
      for (const p of Object.values(panels)) p.traceReady();
    });
  };
  const checkTrace = () => {
    if (ctx.ui.meta !== lastMeta) {
      lastMeta = ctx.ui.meta;
      newTrace();
    }
  };
  if (ctx.onLoad) ctx.onLoad(() => { lastMeta = ctx.ui.meta; newTrace(); });

  ctx.onState((s) => {
    checkTrace();
    sh.playhead = { seq: s.seq, t: s.t };
    for (const p of Object.values(panels)) p.playhead();
  });
  ctx.onView((v) => {
    const views: Views = 'tlT' in v ? { t: v.tlT, seq: v.tlS } : v;
    tracks.view(views);
  });

  function syncToggles() {
    for (const p of PANELS) {
      const b = document.getElementById(p.btn);
      if (b) b.hidden = !present(sh);
    }
  }
}

/** The toolbar toggles, after the Logs one; hidden until a trace has intervals. */
function addToggles() {
  const anchor = document.getElementById('btn-logs');
  const bar = anchor?.parentElement || document.getElementById('toolbar');
  if (!bar) return;
  let after: Element | null = anchor;
  for (const p of PANELS) {
    if (document.getElementById(p.btn)) continue;
    const b = document.createElement('button');
    b.id = p.btn;
    b.hidden = true;
    b.title = p.hint;
    b.textContent = p.label;
    if (after) after.after(b); else bar.appendChild(b);
    after = b;
  }
}
