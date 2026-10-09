// The heap domain's panel table: one record per panel window that the shell
// places and the session restores.
//
// This is the only place a panel id is written. Before it existed the same
// seven ids were spelled out in four places — a `PANEL_IDS` array, the
// toolbar-button wiring, and two test fixtures — that had to agree by hand.
//
// A record is `{ id, title, toggle, dock, open, refill }`, plus the optional
// fields below:
//
//   id      the panel type (for a singleton, also its element id), and the key
//           the session stores window geometry under
//   title   the panel head's text, written into `.ph-t` by the shell at
//           registration so the table owns it rather than sharing ownership
//           with index.html
//   toggle  the toolbar button that shows/hides it, or null when it has none.
//           The shell wires the button; what a panel does on opening (Events
//           and Logs refresh their virtualized lists) is an onOpen hook in the
//           panel's own module
//   dock    the drawer this panel starts docked in ('left' | 'right'), or null
//           to start floating
//   open    whether it starts visible
//   needs   optional: the evidence domain the panel presents ('logs'); it then
//           starts open only when the loaded trace has records of that domain
//   persist optional, default true: false for a window that is opened per
//           selection or event and has no session-restored geometry of its own
//   multi   optional: one window per key (pinned allocation windows, keyed by
//           creator event) instead of one element
//   autoPlace optional: placed in the free workspace beside the drawers when it
//           opens floating, cascading past open windows of the listed types
//   refill  refills the panel from a freshly loaded trace, or null when its
//           content is static markup
//
// `dock`/`open` are the default layout (spec SHELL-008), and they live here
// rather than in the shell for the same reason the ids do: which panel belongs
// at which edge is a statement about heaps, and the shell must not name a
// panel. A saved session overrides the whole of it.
//
// Play floats and starts closed on purpose — it is opened for a moment and
// dismissed. So does Warnings, which only means anything when the trace has
// any.
//
// The Allocation window, its pinned clones and the Event window are declared
// here too, so that every window the heap shows goes through the one table,
// but they are not persisted as windows: they are per-allocation or per-event
// and opened on demand. Pinned windows are restored by the heap section of the
// session (by creator event), and their dock slot by the drawer order.

type PanelRecord = {
  id: string;
  title: string;
  toggle: string | null;
  dock: 'left' | 'right' | null;
  open: boolean;
  needs?: 'logs';
  persist?: boolean;
  multi?: boolean;
  autoPlace?: { avoid: string[] };
};

// Table order is also the top-to-bottom order within each drawer.
const PANELS: PanelRecord[] = [
  { id: 'play-panel', title: 'Play', toggle: 'btn-playcfg', dock: null, open: false },
  { id: 'layout-panel', title: 'Layout', toggle: 'btn-layout', dock: 'right', open: true },
  { id: 'appearance-panel', title: 'Appearance', toggle: 'btn-appearance', dock: 'right', open: true },
  { id: 'filter-panel', title: 'Filter', toggle: 'btn-filter', dock: 'right', open: true },
  { id: 'analysis-panel', title: 'Marks', toggle: 'btn-analysis', dock: 'right', open: true },
  { id: 'warnings-panel', title: 'Warnings', toggle: 'btn-warnings', dock: null, open: false },
  { id: 'events-panel', title: 'Events', toggle: 'btn-events', dock: 'left', open: true },
  { id: 'logs-panel', title: 'Logs', toggle: 'btn-logs', dock: 'left', open: true, needs: 'logs' },
  {
    id: 'detail-panel', title: 'Allocation', toggle: null, dock: null, open: false, persist: false,
    autoPlace: { avoid: ['pinned-detail'] },
  },
  { id: 'pinned-detail', title: 'Allocation', toggle: null, dock: null, open: false, persist: false, multi: true },
  {
    id: 'event-panel', title: 'Event', toggle: null, dock: null, open: false, persist: false,
    autoPlace: { avoid: ['pinned-detail'] },
  },
];

// The records, with each panel's refill function attached. `refills` is keyed
// by panel id; a panel with no entry has no refill step. An unknown key is a
// typo'd id and throws here rather than silently never being called — the
// whole point of the table is that the ids agree.
export function heapPanels(refills: Record<string, () => void> = {}) {
  for (const id of Object.keys(refills)) {
    if (!PANELS.some((p) => p.id === id)) throw new Error(`no such panel: ${id}`);
  }
  return PANELS.map((p) => ({ ...p, refill: refills[p.id] || null }));
}
