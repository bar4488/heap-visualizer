---
id: T019
title: A guide drawer prototype, outside the panel system
status: done
updated: 2026-07-30
---

# T019: A Guide Drawer Prototype, Outside the Panel System

## Context

[E015](../explorations/E015-interactive-tutorial.md) asks for a
reference-density technical guide living in the app. Two things are settled by
steer and are what this ticket builds:

- It is **its own drawer**, not a window in the panel table. That is what
  removes E015's open questions about per-trace persistence, drawer height
  sharing with Events, and "too small / too short" — a bespoke surface answers
  none of them because it inherits none of them.
- It therefore may use a **different design language** than panels, and should:
  it reads as a document beside the app, not as another settings window.

Still open in E015 and deliberately *not* decided here: how much content there
is, how wide the action vocabulary gets, and whether reading position persists.
This prototype exists so those are judged against something running.

## Outcome

The app has a guide drawer at the left edge of the workspace, outside the panel
system, rendering plain-markdown content from `src/web/guide/`, whose prose can
highlight real UI elements and act on them **only by driving the real
controls**.

## Done when

- [x] `rg -n 'guide' src/web/heap/panels.ts` returns nothing — the guide is in
      no panel record, has no dock/float/session geometry, and is not a
      `.panel`.
- [x] A toolbar Guide button toggles the drawer; it opens at a reading width at
      the left edge of `#workspace`, outside `#drawer-left`, and its width is
      draggable.
- [x] Content is plain markdown under `src/web/guide/`, copied to `dist/` by
      `build.sh`, and each file reads as complete prose opened raw.
- [x] Sections cover the map, time, range/allocation selection, filters, and
      tags/marks.
- [x] Scenario traces under `src/web/guide/traces/` demonstrate the cases the
      bundled demo does not, and are offered as `?trace=…&guide=1` links rather
      than through a loader in `guide.ts`.
- [x] A `#show:<id>` link highlights that real element; a `#do:<id>` link
      clicks it; a `#set:<id>=<v>` link sets it and dispatches the event the UI
      already listens for.
- [x] `rg -n 'postMessage|worker' src/web/guide.ts` returns nothing: the guide
      reaches app state only through real controls, never a parallel path.
- [x] `npx tsc -p tsconfig.json` and `npx tsc -p tsconfig.test.json` pass.
- [x] Spec matches: SHELL-001 names the guide drawer, and a requirement states
      it is outside SHELL-002/003 and acts only through real controls.
- [x] Hand smoke-tested per
      [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md).

## Work log

**2026-07-29.** Prototype written: `src/web/guide.ts`, `#guide` markup in
`index.html`, a guide section in `style.css`, two content files under
`src/web/guide/`, a `cp -r` step in `build.sh`, and `initGuide()` called from
`main.ts`. Spec updated: SHELL-001 workspace line plus SHELL-009.

Two decisions worth keeping:

- **`#show:` on a closed panel clicks that panel's real toolbar toggle**, using
  a panel-id → toggle map read from `heapPanels()`. This is the one thing the
  guide needs from the panel table, and reading it is what SHELL-003 exists
  for — a second hand-written list of panel ids in `guide.ts` is what it
  forbids. Prose can therefore point at Layout or Filter whether they are open
  or not, and pointing never closes anything.
- **`#set:` dispatches `input` and, for text inputs, also `change`**, because
  the layout/appearance controls are all wired `onchange`
  (`main.ts:753-789`) while `filter-source` is wired `oninput`
  (`main.ts:1133`). Firing both is deliberate rather than encoding per-control
  knowledge here.

**2026-07-29, second pass.** Design language pulled onto the app's own tokens
(`--bg2`, `--border`, `--accent`, system font at 12.5 px) — the first pass used
a warm serif surface, which read as a different product. Content rewritten
terser and bullet-first, and split into five sections: the map, time,
selecting, filters, tags and marks.

Scenario traces added under `src/web/guide/traces/`, because the bundled demo
does not exhibit several documented cases (a real overlap, a freed nested
allocation, `usable` slack, a double free, an unknown-id free, a realloc chain
that moves, a long idle gap between two bursts). They are hand-written JSONL
with `seq` omitted — stream position assigns it (TRACE-007) — so each file is
short enough to read beside the prose it illustrates.

**How a scenario loads matters.** It is a plain link to
`index.html?trace=guide/traces/<file>.heapl&guide=1`: existing `?trace=` autoload
(TOOL-002), plus a `guide` parameter so the reader lands back in the guide. A
`#load:` verb calling the loader directly would have been the obvious move and
is exactly the parallel path SHELL-009 forbids; the cost of avoiding it is a
page reload per scenario, which is cheap for files this size.

**2026-07-30, third pass.** Three fixes and one addition from use:

- Scenario links pointed at `guide/<file>.heapl`; the files are in
  `guide/traces/`. Every one would have 404'd.
- **An action must not move the reader's place in the prose.** `scrollIntoView`
  scrolls *every* scrollable ancestor and animates asynchronously, so
  highlighting a docked control shifted the guide out from under the reader.
  Replaced with a scroll of the single nearest scrolling ancestor, only when
  the target is actually out of view, never through `#guide`
  (`scrollParent()`), plus a pin of `#guide-body.scrollTop` across the whole
  action in case an app handler focuses something.
- The map section had no way to get a trace loaded, so its first actions did
  nothing. It now opens with `sites.heapl` and Demo.
- `colors.heapl` added: the color modes had been pointed at `defects.heapl`,
  whose 7 allocations show a log2 size ramp and a categorical palette as
  nothing at all. 156 allocations, 6 sites, 4 threads, 16 B – 64 KiB, 125 live
  at the end, laid out so address order is both size order and birth order —
  which makes size and age resolve as gradients rather than speckle.

**Verified.** `npx tsc` passes under both configs; `./build.sh web` emits
`dist/guide/` with the five sections and five traces; all four hand-written
traces parse as JSONL with monotonic `t`. The match counts quoted in
`filters.md` were computed from `sites.heapl` rather than asserted — which
caught two wrong numbers (26 events not 28 in `bursts.heapl`, and
`read_buffer && !freed` matches 2 not 1).

**2026-07-30, completion.** A person tested the changes in the browser,
covering the rendered and interactive part that the automated suites do not.
The agent re-ran both TypeScript configurations, the web tests, both Rust test
suites, `./build.sh web`, and `git diff --check`; all passed. The built tree
contains all five guide sections and all five scenario traces. The two
boundary searches in the done-when list return no matches.

## Result

The guide is a shipped, resizable workspace surface with five markdown
sections and five purpose-built traces. Its action vocabulary highlights,
clicks, or sets real controls, with no direct path into application state.
Browser use and every cheap repository check passed.

## Non-goals

- Full guide content. Two sections is enough to judge the surface.
- Persisting open state or reading position (E015 question, unsettled).
- Any change to the panel table, drawer docking, or the session format.
- Spotlight/dimming treatments; one highlight treatment is enough to judge.
