---
id: E015
title: A technical guide drawer inside the app
status: open
updated: 2026-07-31
---

# E015: A Technical Guide Drawer Inside the App

## Summary

The app has no onboarding beyond the toolbar's Open/Demo buttons
([SHELL-001](../../spec/09-ui-shell.md#shell-001-layout)) and whatever a new
user infers from poking at panels. The ask: a **reference-density technical
guide**, living in a wide drawer on the left of the running app, that reads
like markdown — plain prose, skimmable, no bespoke authoring tool — and whose
prose can **highlight or change the real app** as the reader moves through it.

Two things it is explicitly not:

- **Not a tour.** No "Welcome! Let's get started", no numbered hand-holding, no
  encouragement. The audience already knows what `malloc` is and wants to know
  what *this tool* does with it: exact units, the actual filter grammar, real
  keybindings, what the engine is and isn't tracking.
- **Not a separate screen.** Superseded below.

## Steering history

- **2026-07-29 (a)**: it must not be a panel — it is its own screen
  (`tutorial.html`), an interactive article with embedded toy widgets in the
  Explorable Explanations sense.
- **2026-07-29 (b)**: that was rejected as too soft — "slop" —
  and for the wrong reason architecturally: an article with toy widgets
  *simulates* the tool next to the tool. The guide belongs **inside** the app,
  as a big left drawer, so its live examples are the real app in the real
  state, and there is no second renderer to keep honest.
- **2026-07-29 (c), current**: it is **its own drawer**, not a window in the
  panel table. Reasoning as given: a bespoke surface feels visibly "outside"
  the app, is free to use a different design language than panels, and
  *dissolves* rather than answers the questions (b) raised about per-trace
  persistence, drawer height shared with Events, and being too small or too
  short — a surface that inherits none of the panel machinery inherits none of
  its constraints.

The (a) reasoning is kept only as history; the constraints below are written
against (b) and (c). Nothing here binds anything — see
[the protocol on explorations](../../PROTOCOL.md).

## Why it matters

The three coordinated views, time travel, and the analysis layer
([01-overview](../../spec/01-overview.md)) are the whole point of the app, and
none is self-explanatory from chrome alone. The specific gap for a technical
user is not motivation, it is **precision**: which allocation-expression fields
exist, what "row bytes" actually quantizes, what the playhead's `seq` counts,
what a warning means about the trace. Today the only precise account of any of
that is `spec/`, which is contributor-facing and normative, not a thing a user
reads while driving the app.

Being in-app is what makes it worth building rather than writing a manual: the
sentence that names a control can also **point at it**, and the sentence that
describes a filter can **apply it**.

## Constraints from the existing architecture

- **It is deliberately outside the panel machinery.** Per steer (c) the guide
  is *not* a record in `src/web/heap/panels.ts:35` and not a `.panel`, so
  [SHELL-002](../../spec/09-ui-shell.md#shell-002-panels-are-windows) (windows),
  [SHELL-003](../../spec/09-ui-shell.md#shell-003-panels-are-declared-as-data)
  (declared as data) and
  [SHELL-004](../../spec/09-ui-shell.md#shell-004-docking-drawers) (docking,
  collapse-to-rail, session-persisted geometry) do not apply to it. The cost is
  that width-drag is reimplemented in ~15 lines instead of inherited; the gain
  is that nothing about it has to be reconciled with per-trace session state.
  It sits outside `#drawer-left`, so the existing left drawer — which holds
  Events by default
  ([SHELL-008](../../spec/09-ui-shell.md#shell-008-the-default-layout)) — is
  untouched, and the guide never shares height with a panel.
- **It still needs the panel table for one thing**: to point at a *closed*
  panel, it maps panel id → toolbar toggle from `heapPanels()` and clicks the
  real button. Reading that table is what SHELL-003 is for; keeping a second
  list of panel ids in the guide is what it forbids.
- **`?trace=demo.heapl` and `btn-demo`** ([TOOL-002](../../spec/10-tooling.md),
  `src/web/main.ts:266`) already load the bundled demo. The guide's first
  action — "load something to look at" — is an existing call site.
- **Highlight primitives already exist** for "where did that happen?":
  `.addr-flash`, `.rect-flash`, `.rect-ping` (`src/web/style.css:445-469`) and
  the `.drop-target` dashed outline (`:159`), plus the status info line
  convention ([SHELL-007](../../spec/09-ui-shell.md#shell-007-status-and-feedback-conventions)).
  Highlighting a *chrome* element (a toolbar button, a panel, a drawer) has no
  precedent yet.
- **No markdown renderer in the tree.** `grep -rn 'markdown\|marked' src/web`
  finds nothing; the app writes HTML through `setHTML`/`innerHTML`
  (`src/web/shell/dom.ts:34`). Rendering markdown is either a build-time step
  in `build.sh` or a small client-side renderer — a new dependency either way,
  and untrusted-HTML rules apply if it is client-side.
- **[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)**: no
  browser automation. A guide that drives the UI for the *user's* benefit is
  fine; a suite that drives the guide to verify it is what D001 declines.
- **`src/` in, `dist/` out.** Guide content is hand-written under `src/`; if it
  needs building, that step goes in `build.sh`.
- **`docs/` is the protocol's process directory**, not a home for end-user
  product prose. Guide content needs its own location.

## Questions

- ~~Is it a panel in the table, or a drawer of its own?~~ **Settled by steer
  (c): its own drawer.** Kept here because the reason is the interesting part —
  in the panel table it would have inherited per-trace session geometry
  ([SHELL-002](../../spec/09-ui-shell.md#shell-002-panels-are-windows),
  [ANL-007](../../spec/07-analysis.md#anl-007-persistence--heapa-files-and-autosave)),
  and "how far I got in the guide" is not a fact about a trace. Outside the
  table there is nothing to reconcile.
- **Does anything about the guide persist at all?** Open, and now a free
  choice rather than a constraint: open/closed, width, and reading position
  could persist globally (`heapviz:prefs`, which already exists for
  non-trace preferences), per trace, or not at all. The prototype persists
  nothing.
- **How wide is "big"?** The prototype opens at 380 px and drags between 280
  and 720. A wide surface permanently narrows the three views, which are
  supposed to own the screen — worth judging from use, not from argument.
- **What does "highlight" mean mechanically?** Candidates: outline the target
  element in place (cheapest, composes with everything); outline plus a
  transient pulse reusing the flash keyframes; spotlight, i.e. dim everything
  *but* the target (most legible, but it is an overlay over the whole app and
  fights the "you are still using the real app" premise). Targets are of three
  kinds — a chrome element (toolbar button, panel), a region of a view (an
  address range, a time span), a row in a list — and they may not want the
  same treatment.
- **What may an action from prose change?** A load, a playhead seek, opening a
  panel, applying a filter expression, setting a layout/appearance option are
  all plausible. The constraint worth stating up front: an action must go
  through the **same call site the UI uses**, never a parallel path into state,
  or the guide becomes a second undocumented API onto the app that drifts.
  Open: whether actions are reversible/undoable, and whether an action that
  clobbers the reader's own filter or marks must ask first.
- **How markdown-like, precisely?** The proposal below is: plain markdown, with
  exactly one non-prose element — a link with a recognized scheme (or a fenced
  block) naming a highlight target or an action. A reader opening the raw `.md`
  still gets the whole technical content; only the live behavior is lost.
- **Where does content live?** `src/web/guide/*.md` (shipped in every build,
  next to the code it describes) versus a sibling of `spec/`. Note `spec/` is
  normative requirements, not user prose — reusing it directly blurs what is
  binding.
- **Does the guide restate spec facts, or cite them?** Restating creates two
  owners for one behavior fact and it *will* drift; citing keeps one owner but
  sends a user into a contributor-facing document. Possibly: guide explains and
  demonstrates, spec remains the only place a normative claim is written, and
  the guide links requirement IDs.
- **Scope of the first pass.** Minimum is the three views plus time travel;
  open whether tags/marks/filter ([07-analysis](../../spec/07-analysis.md)) is
  the same guide, a later section, or a later ticket.

## Ideas

- **One `Guide` record in `src/web/heap/panels.ts`**, `dock: 'left'`, with a
  toolbar toggle beside Open/Demo — discoverable at the one moment a new user
  is looking at an empty workspace.
- **Content as plain markdown**, one file per section (`address-map.md`,
  `time-travel.md`, `filter-grammar.md`, …), rendered into the drawer. Two
  inline hooks, both degrading to readable text:

  ```markdown
  The playhead counts events, not time: `seq` is an index into the event
  stream ([NAV-001]). Step with [→](#seek:+1), or [jump 100](#seek:+100).

  Row bytes quantizes each map row to a fixed span — see
  [the Layout panel](#show:layout-panel), currently [4 KiB](#set:rowBytes=4096).
  ```

  `#show:` highlights, `#set:`/`#seek:` act. Anything not matching a known
  scheme renders as an ordinary link.
- **A table of contents in the drawer bar**, not a "next" button. The reader is
  looking things up as much as reading through; a linear stepper would impose
  the tour shape the ask rejects.
- **Register, stated as a rule for whoever writes the prose**: every paragraph
  either states a mechanism, a unit, a grammar, or a keybinding. No greeting,
  no emoji, no second person cheerleading, no "simply". Short sentences, real
  numbers, and the honest limitations (what the engine does not track, where
  the address map lies for legibility) said out loud.
- **Prose points at the demo trace by default**: with `demo.heapl` loaded, a
  section can name a *specific* interesting region ("the realloc chain around
  seq 41,200") and jump there, which is exactly what the separate-screen
  version needed toy fixtures to fake.

## Risks

- **Guide actions become a back door into app state.** If `#set:` reaches into
  internals rather than the UI's own call sites, it is a second API with no
  spec and no tests, and every refactor of `main.ts` silently breaks prose.
  This is the main technical risk of the in-app approach and the reason to
  route every action through existing handlers.
- **Prose restating behavior drifts from the spec.** A guide that says "row
  bytes defaults to 4 KiB" is a second owner for that fact. Citing over
  restating, and keeping normative claims in `spec/`, is the mitigation.
- **A wide left drawer costs the views their screen.** SHELL's guiding stance
  is that the views own the screen; a guide big enough to read comfortably is
  big enough to hurt. Collapse-to-rail
  ([SHELL-004](../../spec/09-ui-shell.md#shell-004-docking-drawers)) already
  exists and may be enough.
- **Client-side markdown rendering is an HTML injection surface** if content is
  ever fetched rather than built in. Build-time rendering avoids the question
  entirely.
- **Scope creep**: "guide" grows into a full user manual. Keeping it to the
  demo plus core features is a non-goal worth writing into whatever ticket
  follows.
- **Verification is by hand** (D001), and a guide that lies — a highlight
  pointing at a control that was renamed, an action referencing a removed
  setting — is worse than no guide. Worth considering one cheap build-time
  check that every `#show:`/`#set:` target resolves to something the app
  actually declares.

## Settled by building it (2026-07-29)

- **Design language.** The first pass used a warm serif reading surface to make
  the drawer feel outside the app. It read as a different product. It now uses
  the app's own tokens and system font; being a wide, chrome-less column is
  enough separation.
- **Register.** "This is X, not Y, not Z" framing and any prose that sells the
  tool are out. Statements, in points, assuming the reader knows what the
  product is and wants to use it well.
- **An action must not move the reader's place.** Highlighting a control
  scrolled the prose out from under the reader, because `scrollIntoView` acts
  on every scrollable ancestor. The rule this settles into: a guide action may
  change the app, and may not change where the reader is in the guide.
- **A scenario has to be built for the claim it illustrates.** Pointing the
  color modes at the defect trace showed a log2 ramp across 7 allocations,
  i.e. nothing. Each scenario is now shaped by what its section asserts —
  `colors.heapl` puts address order in step with both size and birth order so
  the ramps resolve as gradients.
- **Scenario traces.** The bundled demo does not exhibit several documented
  cases (a real overlap, freed-nested, `usable` slack, a double free, an
  unknown-id free, a realloc chain that moves, a long idle gap). Rather than
  change `gen.py` — which would alter the trace every other ticket is measured
  against — the guide ships small hand-written `.heapl` files under
  `src/web/guide/traces/`. This is the earlier "small curated fixtures" idea,
  with the important difference that they load into the **real** app rather
  than into a toy widget, so there is still one renderer.
- **How a scenario loads**, and it is the interesting one: a plain link to
  `?trace=…&guide=1`, using existing autoload
  ([TOOL-002](../../spec/10-tooling.md)). A `#load:` verb calling the loader
  directly is the obvious alternative and is exactly the parallel path the
  no-second-API rule forbids. Cost: a page reload per scenario.

## Derived artifacts

- **[T019](../tickets/T019-guide-drawer-prototype.md)** — the prototype:
  `#guide` at the left edge of the workspace, `src/web/guide/*.md`,
  `#show:` / `#do:` / `#set:` acting on real controls.
- **[SHELL-009](../../spec/09-ui-shell.md#shell-009-the-guide-surface)** — the
  guide surface is not a window, and reaches app state only through real
  controls. Written with T019 because the code would otherwise knowingly
  disagree with SHELL-001's account of the workspace.
- **[T024](../tickets/T024-guide-renderer-tests.md)** — the markdown renderer
  the prototype shipped untested.

## Where it stands, 2026-07-31

Re-grounded against the code rather than against the proposal above. What
shipped, and is true now:

- Five sections under `src/web/guide/` — the map, time, selecting, filters,
  tags and marks — plus five hand-written scenario traces under
  `src/web/guide/traces/`. Both directories are copied to `dist/` by
  `build.sh`.
- The action vocabulary is exactly the three verbs proposed: `#show:` rings an
  element, `#do:` clicks it, `#set:` assigns and dispatches. Nothing was added.
- Two constraints came out of use rather than design, and both are in
  `guide.ts`: a `#show:` on a control inside a closed panel opens that panel by
  clicking its **real** toolbar toggle, read from `heapPanels()`; and no action
  may move the reader's place in the prose, which cost `scrollIntoView` and
  bought a nearest-scrollable-ancestor scroll plus a pinned `#guide-body`
  scroll position.
- Nothing persists. Not open state, not reading position, not the dragged
  width. The `?guide=1` parameter is the whole of it.

## Outcome

Open — but the surface question is settled and built. Settled: it lives inside
the running app; it is **its own drawer**, outside the panel system and free to
look different; its register is technical reference, not a guided tour; and
actions reach the app only by driving real controls.

Still open, and answerable from use rather than argument:

- **What persists.** Nothing does. Whether reading position or open state
  should is the question the bespoke-drawer choice deferred, and it is still
  deferred.
- **Whether one highlight treatment is enough**, now that `#show:` also has to
  open a closed panel to reach its target.
- **How wide the action vocabulary should get.** `show`/`do`/`set` covered all
  five sections without strain, which is evidence but not a limit.
- **How much content there should be**, and **whether prose cites or restates
  spec facts.** The five sections restate; nothing has yet gone stale against
  the spec, so the cost of that choice is still unpaid rather than absent.

This file stays open until those are answered from using the thing. It is not
waiting on a decision anyone can make by reading it.
