---
id: D014
title: Dockview is the windowing engine behind the shell's panel API
created: 2026-10-09
---

# D014: Dockview for Windowing

## Decision

The shell's panel API (`src/web/shell/layout.ts`,
[SHELL-003](../../spec/09-ui-shell.md#shell-003-panels-are-declared-as-data))
is implemented on **Dockview**, through its framework-free core package
`dockview-core`. The views (address map, time strip, event-index strip) and
every window are panels in one dock: a split/tab grid in the center, an edge
group on the left, right and bottom, and floating groups
([SHELL-004](../../spec/09-ui-shell.md#shell-004-docking)).

- **Only `shell/layout.ts` talks to the engine.** Domain code keeps calling
  `register`/`open`/`close`/`toggle`/`reveal`/`serialize`/`restore`; it never
  sees a group, a panel object or the engine's JSON. `main.ts` imports
  `dockview-core` and hands `createDockview` to the shell, so the shell's
  tests run against a stand-in (`src/web/test/fake-dockview.ts`) and no Node
  test loads the package.
- **Elements are adopted, not created.** The engine's content renderer moves
  an existing element into the panel and, when the panel goes away, back into
  a hidden parking lot in the same document. The views' canvases are handed
  to the render worker once, at startup (`transferControlToOffscreen`), and
  the app finds controls by `document.getElementById` throughout; both rule
  out content that the engine creates and destroys. Panels use the `always`
  renderer, so a tab in the background keeps its DOM, and a restore uses
  `fromJSON(…, { reuseExistingPanels: true })` so a live panel is moved, not
  rebuilt.
- **The session stores the engine's own serialization** (`api.toJSON()`) in
  the session's versioned `shell` section, plus where closed windows reopen.
  Sessions written before this change (drawers and floating positions) are
  read once, through one path, as an engine-free plan
  (`shell/layout-plan.ts`) and written back in the new shape.

## Version pinning and vendoring

`package.json` pins `dockview-core` to an **exact** version (8.4.1), not a
range. The app has no bundler, and keeps it that way: `build.sh` copies the
package's self-contained ES module (`dist/package/main.esm.min.mjs`, no imports
of its own) to `dist/vendor/`, and an import map in `index.html` maps the bare
specifier onto it. TypeScript resolves the same specifier to the package's
types (`moduleResolution: bundler`), which does not disturb the `./x.ts`
import convention that lets `node --test` run the sources directly.

The ESM build ships no stylesheet — the CSS exists only as a string the UMD
build injects at load — so `build.sh` lifts that string out into
`dist/vendor/dockview.css`, and fails loudly if it cannot find it. The app's
theme maps Dockview's `--dv-*` variables onto its own tokens in `style.css`.

An upgrade is therefore a deliberate act: bump the exact version, rebuild, and
look at the dock in a browser (drag, tabs, edge collapse, floating, a restored
session), since the CSS extraction and the JSON format are the parts most
likely to move. `dockview-core`'s README calls it an internal package and
points at `dockview`; we take the core directly because `dockview` only
re-exports it, and the core is the one file with no imports to vendor.

## The paid-module boundary

Dockview's features are split into modules, some of which ship only in the
commercial `dockview-enterprise` package. The core registers its free modules
itself (floating groups, edge groups, popouts, header actions, the tab context
menu, and others). We use only those, and set **no option that names a paid
module** — the core then logs a missing-module error and the feature does
nothing. In 8.4.1 that excludes: auto-hide edge groups (`autoHideEdgeGroups`,
peek/pin), dock-to-edge drag reveal (`dockToEdgeGroups`), smart guides, layout
history (undo/redo), pinned tabs, multi-row tab overflow and overflow
search/MRU, the DnD compass, and keyboard navigation/docking.

Where the free set falls short we build the small piece ourselves rather than
reach for a paid module: edge groups collapse and expand from a button the
shell renders in the group's header (`collapse()`/`expand()` are free); an
empty edge group is hidden, and shown as a drop rail only while a tab is being
dragged.

## No popouts

Popout windows (moving a group into a new browser window) are not used and
not offered: no `addPopoutGroup` call, and no `popout` item in the tab menu.
A popped-out panel's elements would live in another `document`, where
`document.getElementById` — how the app finds its controls — does not reach
them, and the views' canvases are bound to the worker in this one. Lifting
this would mean first replacing id lookups with references held per panel.

## Why

The hand-built drawers and floating windows had grown a drag, dock, z-stack,
collapse and proportional-height machinery of their own, and still could not
split, tab, maximize or host the views themselves — so every new view would
have been a new layout. A dock engine gives all of that, and the panel API
already put one seam between it and the domain: replacing what is behind
`layout.ts` changed almost nothing in front of it. Dockview was chosen for
being framework-free, dependency-free, MIT-licensed, serializable to plain
JSON, and for supporting long-lived adopted content; a spike (branch
`spike/dockview`, not merged) confirmed the worker-owned canvases and a
virtualized list survive moves, tab switches and `fromJSON`.
