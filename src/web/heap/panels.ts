// The heap domain's panel table: one record per panel — the three views and
// every window — that the shell places and the session restores.
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
//   toggle  the control that shows/hides it, or null when it has none: the
//           element id of its View-menu item when `group` is set (main.ts
//           turns the record into an action, shell/actions.ts), else a top-bar
//           button the shell wires. What a panel does on opening (Events and
//           Logs refresh their virtualized lists) is an onOpen hook in the
//           panel's own module
//   group   optional: the View menu's section for its entry — the domain it
//           presents ('Heap', 'Stream', 'Logs'), or 'workspace' for the views'
//           entries after the domain groups. Absent: no View entry
//   label   optional: the View entry's label when it is not the title
//   dock    where this panel starts: an edge ('left' | 'right' |
//           'bottom'), the center grid ('center', stacked in table order), or
//           null to start floating
//   open    whether it starts visible
//   needs   optional: the evidence domain the panel presents ('logs'); it then
//           starts open only when the loaded trace has records of that domain.
//           Another domain's panels are declared by its own module through
//           the registration hook in src/web/panels.ts, not in this table
//   persist optional, default true: false for a window that is opened per
//           selection or event and has no session-restored geometry of its own
//   multi   optional: one window per key (pinned allocation windows, keyed by
//           creator event) instead of one element
//   closable optional, default true: false for a view that must always exist
//   size    optional: a center view's starting height (px), tab included
//   float   optional: its size when it floats
//   autoPlace optional: floats at the workspace's bottom-left when it opens,
//           cascading past open windows of the listed types
//   refill  refills the panel from a freshly loaded trace, or null when its
//           content is static markup
//
// `dock`/`open` are the default layout (spec SHELL-008), and they live here
// rather than in the shell for the same reason the ids do: which panel belongs
// at which edge is a statement about heaps, and the shell must not name a
// panel. A saved session overrides the whole of it.
//
// The views are panels like the rest — the address map, and the time and
// event strips stacked above it, which is how the workspace has always looked.
// The map cannot be closed; the strips can (their toggles are in the View
// menu). A future view (a flame graph, a span view) is another record.
//
// The right edge holds the settings consulted continuously, as tabs; the left
// edge the Events list; the bottom edge the Logs terminal, which wants width.
//
// Play floats and starts closed on purpose — it is opened for a moment and
// dismissed. So does Warnings, which only means anything when the trace has
// any.
//
// The Allocation window, its pinned clones and the Event window are declared
// here too, so that every window the heap shows goes through the one table,
// but they are not persisted as windows: they are per-allocation or per-event
// and opened on demand. Pinned windows are restored by the heap section of the
// session (by creator event), and their slot by the shell's saved dock.

import type { PanelRecord } from '../panels.ts';

type HeapPanel = Omit<PanelRecord, 'refill'>;

// Table order is also the top-to-bottom order of the center views and the
// tab order within each edge's default group.
const PANELS: HeapPanel[] = [
  { id: 'strip-t', title: 'Time', toggle: 'btn-view-time', group: 'workspace', label: 'Time strip', dock: 'center', open: true, size: 96 },
  { id: 'strip-s', title: 'Event index', toggle: 'btn-view-seq', group: 'workspace', label: 'Event-index strip', dock: 'center', open: true, size: 96 },
  { id: 'addr-scroll', title: 'Address map', toggle: null, dock: 'center', open: true, closable: false },
  { id: 'play-panel', title: 'Play', toggle: 'btn-playcfg', dock: null, open: false, float: { width: 260, height: 140 } },
  {
    id: 'layout-panel', title: 'Layout', toggle: 'btn-layout', group: 'Heap', dock: 'right', open: true,
    hint: 'How the address map is arranged: row bytes, collapsing, row zoom, overlaps',
  },
  {
    id: 'appearance-panel', title: 'Appearance', toggle: 'btn-appearance', group: 'Heap', dock: 'right', open: true,
    hint: 'How the address map is drawn: colors, labels, size format',
  },
  { id: 'filter-panel', title: 'Filter', toggle: 'btn-filter', group: 'Heap', dock: 'right', open: true, hint: 'Find allocations by expression; tag the matches' },
  { id: 'analysis-panel', title: 'Marks', toggle: 'btn-analysis', group: 'Heap', dock: 'right', open: true, hint: 'Tags, time marks, address marks, named allocations' },
  { id: 'warnings-panel', title: 'Warnings', toggle: 'btn-warnings', dock: null, open: false, float: { width: 380, height: 320 } },
  {
    id: 'events-panel', title: 'Events', toggle: 'btn-events', group: 'Stream', dock: 'left', open: true,
    float: { width: 480, height: 420 }, hint: 'Sequenced list of all events',
  },
  {
    id: 'logs-panel', title: 'Logs', toggle: 'btn-logs', group: 'Logs', dock: 'bottom', open: true, needs: 'logs',
    float: { width: 640, height: 320 }, hint: "The trace's log lines, as a terminal that follows the playhead",
  },
  // small on purpose: several pinned allocations should fit side by side
  {
    id: 'detail-panel', title: 'Allocation', toggle: null, dock: null, open: false, persist: false,
    float: { width: 300, height: 340 }, autoPlace: { avoid: ['pinned-detail'] },
  },
  {
    id: 'pinned-detail', title: 'Allocation', toggle: null, dock: null, open: false, persist: false, multi: true,
    float: { width: 300, height: 340 },
  },
  {
    id: 'event-panel', title: 'Event', toggle: null, dock: null, open: false, persist: false,
    float: { width: 360, height: 300 }, autoPlace: { avoid: ['pinned-detail'] },
  },
];

// The records, with each panel's refill function attached. `refills` is keyed
// by panel id; a panel with no entry has no refill step. An unknown key is a
// typo'd id and throws here rather than silently never being called — the
// whole point of the table is that the ids agree.
export function heapPanels(refills: Record<string, () => void> = {}): PanelRecord[] {
  for (const id of Object.keys(refills)) {
    if (!PANELS.some((p) => p.id === id)) throw new Error(`no such panel: ${id}`);
  }
  return PANELS.map((p) => ({ ...p, refill: refills[p.id] || null }));
}
