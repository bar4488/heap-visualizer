// The heap domain's panel table: one record per panel window that the shell
// places and the session restores.
//
// This is the only place a panel id is written. Before it existed the same
// seven ids were spelled out in four places — a `PANEL_IDS` array, the
// toolbar-button wiring, and two test fixtures — that had to agree by hand.
//
// A record is `{ id, title, toggle, build }`:
//
//   id      the element id, and the key the session stores window geometry under
//   title   the panel head's text, written into `.ph-t` at startup so the table
//           owns it rather than sharing ownership with index.html
//   toggle  the toolbar button that shows/hides it, or null when the panel
//           wires its own (the events panel also refreshes its virtualized list
//           on open, so its button is not the generic show/hide)
//   build   refills the panel from a freshly loaded trace, or null when its
//           content is static markup
//
// The detail panel and its pinned clones are deliberately absent: they are
// per-allocation, created on demand, and not restored across a session.

const PANELS = [
  { id: 'play-panel', title: 'Play', toggle: 'btn-playcfg' },
  { id: 'layout-panel', title: 'Layout', toggle: 'btn-layout' },
  { id: 'appearance-panel', title: 'Appearance', toggle: 'btn-appearance' },
  { id: 'filter-panel', title: 'Filter', toggle: 'btn-filter' },
  { id: 'analysis-panel', title: 'Marks', toggle: 'btn-analysis' },
  { id: 'warnings-panel', title: 'Warnings', toggle: 'btn-warnings' },
  { id: 'events-panel', title: 'Events', toggle: null },
];

// The records, with each panel's build function attached. `builders` is keyed
// by panel id; a panel with no entry has no build step. An unknown key is a
// typo'd id and throws here rather than silently never being called — the
// whole point of the table is that the ids agree.
export function heapPanels(builders = {}) {
  for (const id of Object.keys(builders)) {
    if (!PANELS.some((p) => p.id === id)) throw new Error(`no such panel: ${id}`);
  }
  return PANELS.map((p) => ({ ...p, build: builders[p.id] || null }));
}
