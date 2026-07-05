# Improvement tasks (2026-07-06)

Batch of UX improvements requested for the viewer. Checked off as implemented.

- [x] **1. Step selects the related allocation** — stepping fwd/back selects (outlines)
  the allocation the malloc/free/realloc touches, not just centers it.
- [x] **2. Event list panel** — "Events" toolbar button opens a virtualized, sequenced
  list of all events; clicking one seeks there and selects the allocation it
  touches; a "follow" checkbox keeps the current event in view.
- [x] **3. Horizontal zoom on the address line** — timeline-style zoom of the byte
  (x) axis; row size is untouched. Ctrl/alt+wheel zooms around the cursor,
  shift+wheel / horizontal scroll pans, the toolbar shows `↔ ×N` with click-to-
  reset. Picking, hover, overlays, marks and shift+click honor the zoom.
- [x] **4. Select-all / deselect-all on checkbox lists** — "all · none" links on the
  filter panel groups (sites, threads) and the tags list.
- [x] **5. Locked viewport mode** — 🔓/🔒 toggle next to the step buttons (key: L);
  when locked, stepping keeps the address view anchored (no auto-scroll).
- [x] **6. Tag by frees** — the range-selection popover has "Tag allocs" (created in
  range) and "Tag freed" (freed in range) actions.
- [x] **7. Highlight mallocs when stepping** — stepping onto an M event outlines the
  new allocation in green (like frees flash red) — small mallocs are findable.
- [x] **8. Marked addresses always reachable** — address marks are pinned: their rows
  stay in the layout even when nothing is live there.
- [x] **9. Don't get scrolled away when everything is freed** — the scroll anchor
  (top-of-viewport address) is transiently pinned across seeks, so the row you
  are looking at survives even if all its allocations are freed.
- [x] **10. "all rows" mode** — toolbar checkbox that lays out every row any
  allocation *ever* touches (playhead-independent), so the map never reflows
  as allocations come and go.
- [x] **11. In-allocation labels** — centered label inside each allocation wide
  enough: "name · 0xsize" if it fits, else the name, else the hex size.
  Toggleable via the "sizes" checkbox; names come from the Analysis panel.
- [x] **12. Flash-where-is-it from the event list** — clicking the already-current
  event in the Events panel scrolls/pans to it and pulses its exact location
  (rect flash + expanding ping ring for tiny allocations).
- [x] **13. Fix: overlay highlights offset to the right** — the addr canvas was
  sized from the scroll container (which includes the scrollbar) but displayed
  at content width; now measured from `#addr-view` so raster and overlays align.
- [x] **14. Stepping opens the allocation dialog** — stepping onto (or jumping to)
  a malloc/free/realloc fills and opens the detail panel for the allocation it
  touches (`hp_alloc_info`, shared with the pick path).
- [x] **15. Layout dialog** — the address-line layout controls (row bytes,
  collapse, all rows, sizes, row zoom, color) moved from the toolbar into a
  "Layout" panel behind a toolbar button.
- [x] **16. Draggable, stacking panels** — every panel is a window: drag it by
  its header; the last panel opened or touched rises to the top of the stack.
- [x] **17. Demo seq warning fixed** — gen.py gave the header `seq:0` and started
  events at 1; per spec §3.7 seq is the 0-based index among event records only.
  The header no longer consumes a seq and `web/demo.heapl` was regenerated.
- [x] **18. Label on the middle line** — a multi-row allocation's name/size label
  sits on the middle of its visible rows (rounded to the top), not the first.

## Verification
- [x] `cargo test` in `core/` — 17 tests pass (new: tag-by-free, pinned rows,
  anchor pin, show-all layout, x-zoom picking, malloc move-link)
- [x] `./build.sh` — wasm builds and staged into `web/`
- [ ] Manual smoke-test in browser with `demo.heapl`
