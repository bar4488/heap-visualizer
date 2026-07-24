# Web smoke checklist

The fixed, repeatable script for verifying `web/` by hand. `cargo test` covers
the engine and `node --test 'web/**/*.test.js'` covers the pure functions and
the two persisted round-trips; everything below is what neither can reach —
rendering, pointer interaction, and the worker round trip in a real browser.

Run it **before starting the next refactor slice**, not after several. Same
sequence every time, so a regression has a consistent place to show up.

## Setup

```
./build.sh && ./serve.py
```

Open `http://localhost:8000/?trace=demo.heapl`. Use a fresh profile or clear
`localStorage` first when a step below depends on starting clean:

```js
Object.keys(localStorage).filter(k => k.startsWith('heapviz:')).forEach(k => localStorage.removeItem(k))
```

## The script

Each step names what it covers, so a failure points at a module.

| # | Do | Expect | Covers |
|---|---|---|---|
| 1 | Load `?trace=demo.heapl` | Address map paints, both timelines fill, status bar shows the event count | worker bootstrap, `main.js` load path |
| 2 | Drag the playhead on the temporal strip, then the sequential strip | Map redraws continuously; the other strip's echo band tracks it | timeline interaction, domain conversion |
| 3 | Press space | Playback runs and stops | playback controls |
| 4 | Open **Filter**, drag its header to the left edge | Drop indicator line appears, panel docks into the left drawer | `shell/panels.js`, `shell/drawers.js` |
| 5 | Open **Events**, drag it to the left edge below Filter | Two panels stacked, a divider between them | `shell/drawers.js` drop positioning |
| 6 | Drag that divider up and down | Only the two adjacent panels resize; the others hold their height | `wireVResize` |
| 7 | Drag the drawer's outer edge | Drawer width changes and stops at the 160/600 px limits | `wireDrawerWidthResize` |
| 8 | Drag Filter's header back to the middle | It pops out of the drawer immediately on drag start and floats where dropped | `undockPanel` pick-up path |
| 9 | Shift-drag a range on the sequential timeline | Selection band on both strips, popover appears | selection, `updateSelOverlay` |
| 10 | In the popover, type a tag name and apply | Tagged allocations recolor; the tag appears in **Marks** with a count | `heap/analysis.js` tagging |
| 11 | Click an allocation on the map | Allocation panel opens with size, site, lifetime | pick path, detail panel |
| 12 | Name it in that panel and give it a color | Name appears in **Marks → names**; the allocation recolors on the map | `heap/analysis.js` names/colors |
| 13 | Pin the allocation panel (📌), then click a different allocation | The pinned window stays; a fresh live panel opens | pinned windows |
| 14 | Shift-click the address map | Address mark added, flag line drawn across the map | address marks |
| 15 | Press `m` | Time mark added at the playhead; flag on both strips | time marks |
| 16 | Scroll the **Events** list; click a row | List virtualizes without gaps; clicking jumps and flashes the allocation | `heap/events-panel.js` |
| 17 | Drag vertically inside the Events list | Seq range selects, same popover as step 9 | events drag-select |
| 18 | Tick **filtered** in Events, set a size filter | Row count changes, scrolling still lands on real rows | filtered virtualization |
| 19 | Reload the page | Layout, drawers, filters, zoom, playhead and all marks come back | session + marks autosave |
| 20 | **Marks → Save…** | A `demo.heapa.json` downloads | `.heapa` export |
| 21 | Clear `localStorage` (snippet above), reload, then **Marks → Load…** that file | Tags, names, colors, marks *and* the saved layout all return | `.heapa` import, folded session |
| 22 | Resize the browser window | Map and timelines re-layout; marks and selection bands stay on their anchors | resize path, anchor stability |

## Notes

- Step 19 is the one that catches session-shape regressions the unit tests
  can't: they use a stub DOM, so only the real page proves the ids still line
  up.
- Steps 4–8 are the shell. If one of those breaks, `grep -r heap web/shell/`
  should still come back empty — the shell having gained domain knowledge is a
  separate (worse) failure than a broken drag.
- `window.__heap_visualizer` exposes `UI` for poking between steps.
