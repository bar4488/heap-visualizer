# Findings from the full code read (2026-07-22)

Issues noticed while grounding `specs/` in the code: bugs, performance risks,
redundancy, and design choices worth revisiting. None is a hard blocker at the
current target scale (millions of events); items are ordered by severity
within each section.

## Bugs

- [ ] **Overlap warning misses nested overlaps** — `core/src/parse.rs`
  (overlap check in `apply`): only the nearest live block *by start address*
  on each side is tested. A new allocation landing inside an earlier, larger
  block whose start is not adjacent (e.g. A `0x1000+0x10000`, B `0x5000+0x10`,
  new alloc at `0x6000`) is not flagged, even though A covers it. The
  rasterizer's orange pixel-overlap flag partially compensates, but only for
  on-screen, fully-covered pixels. Fix: query an interval structure (e.g. walk
  back while `prev.end > addr`, bounded by `max_span` like the pick path).
- [ ] **`\u` surrogate pairs are not decoded** — `core/src/json.rs`
  (`unescape`): a supplementary-plane character escaped as a surrogate pair
  (`"😀"`) decodes to two U+FFFD replacement chars. Site names /
  titles with emoji or CJK-extension chars are garbled.
- [ ] **Anchor pin is never cleared** — `hp_set_anchor_pin` (`core/src/lib.rs`)
  only ever sets `Some`; nothing clears it until the next trace load. After
  any anchored seek, the last anchor row stays laid out forever, even when
  empty and no longer at the top of the viewport — a phantom row in
  live-rows mode. Worker should clear the pin once the anchor is restored (or
  the engine should treat it as valid for one layout only).
- [ ] **Warning `seq` attribution is off for skipped lines** —
  `core/src/parse.rs`: warnings for records that produce no event row
  (malformed line, creator without `addr`) are attached to `store.len()`,
  i.e. the *next* event's index. "Jump to warning" from the UI lands one
  event late in those cases.
- [ ] **Anchor address formatting loses precision above 2^53** —
  `web/worker.js` `postState`: `(anchor.hi * 0x100000000) + anchor.lo` uses
  Number arithmetic, while every other address crossing uses BigInt. Only
  matters for >8 PiB addresses, but it's an inconsistency waiting to bite.

## Performance

- [ ] **`render_addr` walks the entire live set every frame** —
  `core/src/render.rs`: pass 2 iterates all live allocations regardless of
  the viewport, skipping off-screen rows per allocation. O(live) per frame is
  the main scaling cliff for traces with very large live sets (hundreds of
  thousands+ live). The live set is already ordered by address; a
  binary-search entry at the first visible row's address (bounded by
  `max_span`, like `pick`) would make it O(visible + log live).
- [ ] **Age mode adds a second full live-set scan per frame** —
  `age_normalizer` (`core/src/render.rs`) finds the oldest live birth by
  iterating everything. Could be maintained incrementally by the `View`, or
  at least cached per playhead position.
- [ ] **Per-frame DOM churn in `onState`** — `web/main.js`: every worker
  state message (i.e. every rendered frame during playback/drag) rebuilds
  `innerHTML` for the move-link SVG, both strips' bookmark flag lists,
  address-mark lines, and crop/selection bands. Small lists today, but it's
  layout/GC pressure ~60×/s; should diff or only rebuild on actual change.
- [ ] **Store memory: ~120 B/event across always-allocated columns** —
  `core/src/store.rs`: `old_addr`/`old_size` (u64×2) exist for every event
  but are meaningful only for `R`; `usable` is u64 for a rarely-present hint;
  `stack`/`extra` are u32 columns even when the trace has none. At 10 M+
  events this is the difference between fitting comfortably in wasm32 memory
  and not. Consider side-tables keyed by event index for R-only/optional
  columns.
- [ ] **WASM memory never shrinks across loads** — loading several large
  traces in one session ratchets linear memory up to the high-water mark
  (Rust frees to the allocator, not the browser). Cheap fix if it matters:
  recreate the worker per load.
- [ ] **`hp_pick` JSON round-trip per mousemove** — hover picking serializes
  the full info blob (including rects) to JSON and parses it on the worker for
  every coalesced mousemove. Fine now; would be the first thing to feel a
  bigger info payload. (Coalescing already prevents backlog — keep that.)
- [ ] **gen.py realloc is O(live) per event** — `_do_realloc` does
  `list(self.live.keys())` to pick a victim; generating multi-million-event
  traces with a high realloc rate is quadratic-ish. Tooling-only.

## Redundant code

- [ ] **Dead `sel_rect` in `render_addr`** — `core/src/render.rs:482,628` —
  assigned when the selected allocation is drawn, never read. Delete.
- [ ] **`showTooltip` called with 4 args** — `web/main.js:2358`
  (`onTlHoverResult`): passes `q.xClient ?? 0, q.clientY` to a 2-parameter
  function, and `q.xClient` doesn't even exist. Positioning actually comes
  from `positionTooltipNearMouse()`. Drop the extra args.
- [ ] **Session applied twice on load** — `onLoaded` runs `restoreSession()`
  and then `restoreMarksAutosave()`, whose marks blob embeds its own session
  snapshot, so `applySession` runs twice back-to-back (double seeks, double
  filter/layout messages, pinned windows torn down and rebuilt). Either strip
  `session` from the marks *autosave* (keep it in the exported file) or skip
  the first restore when a marks autosave exists.
- [ ] **Duplicated constants/helpers across layers** — `CAT`/`RAMP` palettes
  exist in both `core/src/render.rs` and `web/main.js`; `fmtBytes`/
  `fmtAllocSize` exist in both `worker.js` and `main.js`; `clampView` is
  intentionally mirrored (worker + main) but undocumented at the main-thread
  copy. All must be kept in sync by hand — at minimum point each copy at its
  twin; better, have the engine export the palette once.
- [ ] **Test dead code** — `core/src/lib.rs` `snapshot_seek_matches_replay`:
  the `fresh` View and the `for e in 0..target {}` loop do nothing. Delete.
- [ ] **`lb.size === undefined` fallback in worker label drawing** —
  `web/worker.js` `renderAddr`: `k===2` labels always carry `size`; the
  `lb.text` fallback is unreachable.

## Debatable design choices (revisit deliberately, don't "fix" casually)

- [ ] **Site-less allocations pass site filters** — `Filter::pass`
  (`core/src/render.rs`): an allocation with no `site` is unconstrained by the
  site selection (same for `thr`). Selecting "none" therefore still shows
  site-less allocations. Tests pin this as intended; the alternative (treat
  missing as its own bucket with a checkbox) is arguably more predictable.
  Documented in specs/07; decide once and keep.
- [ ] **Giant allocations (>65536 rows) only occupy their first/last rows in
  the layout** — `View::occ_add` / `build_all_rows` cap: the middle rows of a
  single terabyte-scale allocation collapse as if empty (rationale: don't
  stall layout). Correct trade-off, but the middle of such an allocation
  renders as a gap marker, which reads as "nothing here". Worth either
  documenting in-UI or special-casing gap markers that lie inside one
  allocation.
- [ ] **Unconditional 2 s localStorage autosave** — `scheduleSessionAutosave`
  serializes and writes the session every 2 s while a trace is loaded, even
  when idle. Harmless but wasteful; a dirty flag like the marks path already
  has would do.
- [ ] **Events-list position is approximate past the spacer cap** —
  `EV_MAX_SPACER` (12 M px) index-maps scroll beyond ~700 k events; drag
  selection in the list (`yToSeq`) is then approximate too. Accepted
  browser-limit workaround; keep the constant next to a comment saying which
  UX degrades past it (it does today — preserve when touching).
- [ ] **`case 'ready'` declares `const url` in an unbraced switch case** —
  `web/main.js` worker `onmessage`: works, but is scoped to the whole switch;
  brace the case like the others.
- [ ] **Numeric jump grammar doesn't accept scientific notation** —
  `execJump`: `1e6` as a *seq* parses as `1` (`parseInt`); only `t:1e6`
  works. Either accept `1e6` for seq or make the placeholder/`title` say
  integers only.
