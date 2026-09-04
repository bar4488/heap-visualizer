---
id: E007
title: "Where the web layer is going, and in what order"
status: settled
updated: 2026-07-24
---

# Web layer: architectural direction — 2026-07-24

Where `web/` should go, in what order, and what should explicitly wait.

**The destination is a domain-independent shell hosting multiple analysis
domains, of which heap is the first.** More domains are planned. This document
is the route there: it stages the work so that each step is verifiable and
useful on its own, and so that the host API is designed once — against a real
second domain — rather than guessed at now and reshaped later.

An earlier proposal from the same day argued for building that host
immediately. Its destination was right and its vocabulary is kept here; its
ordering was not, and the document has been removed. Section 2 records why, so
the sequencing argument does not have to be re-had.

Context: [2026-07-24 review](E002-review-2026-07-24.md), in particular
[F10](E005-web-structure.md#f10), which is the one finding from
that pass still open.

---

## 1. The problem, stated precisely

`web/main.js` is 2,979 lines in one flat scope with zero imports and zero
exports. That is the symptom. The problem underneath it is **ownership**: the
file mixes two categories of code that have nothing to do with each other.

**Shell code** — code whose meaning does not depend on heap traces at all:

| Lines | What |
|---|---|
| `main.js:977–1080` | panels as draggable windows: `makePanelWindow`, `showPanel`, `raisePanel`, z-stack |
| `main.js:1082–1325` | dockable drawers: `dockPanelAt`, `undockPanel`, drop preview, dividers, `applyDrawersState` |
| `main.js:2951–2979` | tooltip ownership and positioning |
| `main.js:397–435` | `setHtml`, `delegate`, `toCss`/`toCssLen` |

**Domain code** — code whose meaning comes entirely from heap traces: tags,
names, colors, marks, the events list, timelines, the address line, filters,
crop, playback, `.heapa` analysis files.

Roughly 400 of the 2,979 lines are shell. They are already domain-independent
in fact; nothing in `makePanelWindow` knows what an allocation is. They are
just not *separated*, so the distinction cannot be relied on, tested, or
enforced — and every one of the 89 `worker.postMessage` sites and 22 `UI`
fields sits in the same namespace as all of it.

This is what makes a second domain expensive today. Adding one to the current
file would mean either copying the window/drawer machinery or threading new
domain code through the same shared mutable scope. Neither is acceptable, which
is why the split comes first regardless of when the second domain lands.

The second problem is that **there is nothing to lean on while changing any of
it**. `cargo test` covers the Rust engine well (33 tests asserting real
invariants). The JS layers have no automated tests at all — recorded as an
intentional stance in [specs/10.3](../../spec/10-tooling.md) — and web
changes are smoke-tested by hand. That is the reason F10 was deferred rather
than fixed in the last pass, and it remains the binding constraint on
everything below.

---

## 2. Sequencing: why the host comes last

The full host — registries for document types, views, panels and commands; a
generic document model; opaque cross-domain selection routing; versioned
domain state and migrations — is where this ends up. It is deferred to Stage 4,
after the split and after TypeScript, for four reasons:

1. **The second domain is planned but not yet specified.** Every extension
   point in a host is a guess about what its consumers need. Designed against
   heap alone, the API encodes heap's accidents; the mistake surfaces when the
   second domain arrives and does not fit, and the API gets paid for twice. One
   real second consumer converts most of the open questions in §5 from
   speculation into requirements.

2. **The split is required either way, and is the larger share of the work.**
   Whatever the host's API turns out to be, the shell code must first stop
   living in the same scope as heap code. Doing the split first means the host
   is a small addition to a clean seam rather than a rewrite of a tangled one.

3. **The verification gap makes a big-bang change unaffordable.** A mechanical
   six-file split was already judged too risky without runtime verification. A
   host built at the same time as the split is an order of magnitude more
   change on the same untested base, in a codebase whose web layer is
   smoke-tested by hand.

4. **The host's shape depends on decisions not yet made.** Does a filter belong
   to a document or to a visualization? Which panel scopes are needed? Are
   multiple traces open at once? Each answer changes the API. They are listed
   in §5 as the things to settle before Stage 4 begins, not before Stage 1.

The vocabulary from the earlier proposal is kept and used throughout:

- a **panel type** is a capability a domain provides;
- a **panel instance** is a window the shell owns and places;
- the **panel content** and its behavior belong to the domain;
- state divides into **workspace** (shell-owned), **view** (domain-owned,
  transient), and **analysis data** (user-authored, durable).

The last one is not new — the code already makes exactly that split, it just
does not name it: `PREFS_KEY` localStorage for app preferences, the per-trace
session for layout and view state ([07-analysis §7.7](../../spec/07-analysis.md)),
and the `.heapa` file for analysis data.

---

## 3. Constraints to honor now, so Stage 4 stays cheap

These cost little today and are expensive to retrofit. Every stage below is
written to satisfy them; they are collected here because they are the reason
several choices in Stages 1–3 look stricter than a plain refactor would need.

- **The shell never names a domain concept.** No `'events-panel'` string, no
  heap type, no `.heapa` knowledge in `web/shell/`. Enforceable by grep, and
  the single most important one — it is what makes the shell reusable at all.
- **Domain state is namespaced in persisted files from the start.** Session and
  preferences get a domain key around domain-owned fields *during Stage 1*,
  while there is exactly one writer and the migration is trivial. Retrofitting
  a namespace onto saved sessions after users have them is a migration nobody
  wants to write.
- **Persisted domain state carries a version field.** Same reasoning, same
  cost: one field now, a migration path later.
- **Selection and navigation payloads stay opaque to the shell.** Where the
  shell touches a selection (`UI.sel`, `selMirror`, the overlay bands), it
  moves it around without interpreting it. Today it mostly does this already;
  keep it that way rather than letting shell code read `.seq`.
- **Panel content is supplied by data, not by the shell reaching for it.** The
  Stage 2 table. A registry is then additive — the same records, plus lifecycle
  — rather than an inversion of control flow.
- **One domain's worker protocol stays its own.** The heap worker is heap's.
  Don't generalize the message layer (`rpc.js` is already the right size); a
  second domain gets its own worker and its own protocol.

Deliberately *not* constrained: naming. Heap concepts keep heap names. Nothing
gets renamed to a generic term to look reusable — that trade is made when a
second implementation actually exists to share the name.

---

## 4. The plan

Four stages. Each is independently valuable, each leaves the app shippable, and
each is verifiable by the time it starts.

### Stage 0 — buy verification (~1 day)

Everything else is gated on this. It is deliberately the cheapest possible
thing that removes the "no way to check a refactor" objection, and it stays
within the zero-toolchain stance: `node --test` ships with Node, no bundler, no
npm dependencies, no browser.

**Pure-function tests** over the code that is already module-shaped:

- `web/fmt.js` in full — `fmtBytes`, `fmtHexSize`, `fmtAllocSize` across all
  format modes, `fmtNum`, `parseSize` (including the failure path from
  [F17](E006-minor-findings.md#f17)), `esc`.
- **`clampView`** specifically. Its entire purpose is that the main thread's
  optimistic local zoom agrees with the worker's authoritative clamp; it lives
  in `fmt.js` precisely so the two cannot drift. That agreement is currently
  guaranteed by a comment. Test it.
- `normAddr` and the address-range normalization at `main.js:862–880`.
- A `buildSession` → `applySession` round-trip (`main.js:2067`, `:2111`) over a
  representative fixture: filters, layout, view, crop, window and drawer state,
  playhead. This is the single highest-value test in the list — session shape
  is what Stages 1 and 2 are most likely to break, and it is the breakage a
  user notices last.
- A `buildMarks`/`applyMarks` round-trip (`main.js:1966`) over a `.heapa`
  fixture, including the unknown-field preservation the format promises.

Extracting these for testability requires no restructuring: they are already
pure or nearly so. Where one reads the DOM (`allocSizeFormat()` at
`main.js:63`), pass the mode in — the same change `fmt.js` already made.

**A written smoke checklist.** `window.__heap_visualizer` already exposes `UI`
for console poking. Turn the ad-hoc smoke test into a fixed, repeatable script
against `demo.heapl`: load → dock a panel left → resize the drawer → tag a
selection → name an allocation → save session → reload → confirm restore →
save `.heapa` → reload → apply. Same sequence every time, so a regression has a
consistent place to show up.

**Done when:** `node --test web/` passes and the checklist exists as a file.

### Stage 1 — split `main.js` on the shell/domain seam

This is F10, but cut by ownership rather than by the banner comments (the
original fix list followed the banners, which is why it produced six modules of
uneven value). The cut line here is the one the host will later formalize, so
this stage is where most of the milestone's value is actually delivered.

Order matters: shell first, because it is the part with no domain coupling and
therefore the safest, and because having it out makes the domain modules
obvious.

| # | Module | Contents | Domain knowledge |
|---|---|---|---|
| 1 | `web/shell/panels.js` | `makePanelWindow`, `showPanel`, `raisePanel`, `panelZ`, float rects | none |
| 2 | `web/shell/drawers.js` | `dockPanelAt`, `dockPanel`, `undockPanel`, drop preview, `wireVResize`, `wireDrawerWidthResize`, `refreshDrawerDividers`, `applyDrawersState` | none |
| 3 | `web/shell/tooltip.js` | `showTooltip`, `hideTooltip`, `positionTooltipNearMouse`, `tooltipOwner` | none |
| 4 | `web/heap/analysis.js` | tags, names, colors, time marks, address marks, `.heapa` build/apply | all |
| 5 | `web/session.js` | `buildSession`, `applySession`, autosave, `sessionKey` | boundary |
| 6 | `web/heap/events-panel.js` | `evState`, virtualized list, drag-select, `flashRects` | all |

The `shell/` and `heap/` directories are the milestone made visible: the
directory a file sits in states who owns it, and "does the shell know about
heaps" becomes a question `grep -r heap web/shell/` answers.

**Rules for each slice**, all of which exist to keep the risk that closed F10
from recurring:

- **One slice per commit, smoke-tested before the next begins.** Six modules in
  one pass is the granularity that was correctly judged too risky.
- **No module imports `UI`.** The circular-import initialization-order hazard
  flagged last time is avoided by construction, not by care: shell modules
  receive what they need as arguments, and hand results back through explicit
  callbacks.
- **The `PANEL_IDS` list (`main.js:984`) stays in `main.js`** for now — it is
  the domain saying which panels exist, which is exactly the handoff Stage 2
  formalizes.
- **`session.js` is the boundary module** and the one to be most careful with:
  it serializes shell state (window/drawer geometry) *and* domain state (view,
  crop, filters). This is where the namespacing constraint from §3 is applied —
  domain-owned fields move under a `heap` key with a version, in the same
  commit, with the Stage 0 round-trip test rewritten to cover both the new
  shape and reading the old one.
- If a slice turns out to need more than a lift-and-shift, stop and split it
  further rather than reaching for a redesign mid-move.

**Done when:** `main.js` is trace/worker/toolbar wiring plus the three
coordinated views, `web/shell/` contains no domain identifiers, and persisted
domain state is namespaced and versioned.

### Stage 2 — declare panel content as data

With `shell/` extracted, formalize how a panel's content is supplied — as a
plain table handed to the shell at startup:

```js
// heap/panels.js
export const HEAP_PANELS = [
  { id: 'filter-panel', title: 'Filter', build: buildFilterPanel, onState: null },
  { id: 'events-panel', title: 'Events', build: initEventsPanel,  onState: updateEventsPanel },
  // ...
];

// main.js
shell.panels.register(HEAP_PANELS);
```

No lifecycle, no activation, no discovery, no manifest, no versioning — that is
Stage 4's job, and it is additive to exactly this shape.

Worth doing on its own terms: it deletes the hand-maintained `PANEL_IDS` array,
gives each panel one declared place where its title and build function live,
and turns "the shell knows nothing about heaps" into something the code
enforces rather than something this document asserts. It is also the smallest
honest test of the seam — if a panel cannot be expressed as one of these
records, that is a finding about the split, surfaced while it is still cheap
to fix.

### Stage 3 — TypeScript at the contracts

Gated on Stage 1: types pay off over declared module seams, and typing an API
nobody has used yet is how you get types that describe the wrong thing.

With no automated tests over ~3,800 lines of JS, types would be the only
checking that code ever receives — a stronger argument for TS here than in a
typical project, not a weaker one. It also matters more once there are two
domains: the shell/domain contract is precisely the kind of implicit agreement
that types keep honest across a boundary two different pieces of code depend
on. Adopt in this order, by where untyped contracts actually cost:

1. **The `main.js` ↔ `worker.js` message protocol.** 89 `postMessage` sites, a
   30-case `onmessage` switch, and a message shape agreed by convention alone.
   This is where a typo is currently a silent no-op.
2. **The persisted shapes** — session (now namespaced and versioned) and
   `.heapa`. Types describe them; runtime validation still parses them, because
   compile-time types cannot validate a file off disk. Both are needed, and the
   Stage 0 round-trip tests become the fixtures.
3. **The shell/panel records** from Stage 2 — the contract Stage 4 will widen.

The runtime stays exactly what it is: native HTML, CSS, ES modules, Web
Workers, OffscreenCanvas, WASM. A compile step that emits ordinary browser
modules, and nothing else — no bundler, no framework.

**This reverses a documented decision.** [specs/10.2](../../spec/10-tooling.md)
records the zero-JS-build stance — *"no bundler, no npm"* — as intentional.
Amend it in the same commit, stating that the stance was traded for typed
contracts and why. Do not leave the spec contradicted by the tree.

### Stage 4 — the host, designed against the second domain

Entered when the second domain is concrete: named, with a known data source, a
known set of views, and someone ready to build it. Then, and not before:

- registries for document types, views, panels and commands, grown from the
  Stage 2 records;
- a generic document model, with domain state opaque to the shell;
- selection and navigation carried by the shell without interpretation;
- workspace persistence separated from per-domain state (Stage 1 already
  namespaced it, so this is a widening, not a migration);
- domain registration and cleanup.

Build it *while* building the second domain, not before. The first consumer
after heap is what tells you which of §5's questions have real answers, and an
extension point with two implementations is an abstraction; with one it is a
guess.

## 5. Questions to settle before Stage 4

Not answerable today, and not blocking Stages 0–3. Each changes the host's
shape, so collect answers as the second domain takes form:

- What is the second domain, concretely? Its data source, its views, and which
  parts of the heap UI it would and would not want.
- Are multiple documents open at once, and if so of mixed kinds? This is the
  biggest one: it touches the single-global-engine-instance decision in
  [08-architecture §8.1](../../spec/08-architecture.md), session
  persistence, and the whole toolbar. It is a large user-facing feature, and it
  should be decided as one — not arrive as a side effect of a refactor.
- What is the smallest useful generic document model, and what stays opaque?
- Which panel scopes are needed: application, document, view, multi-instance?
  (Pinned allocation windows already need multi-instance.)
- Does a filter belong to a document or to an individual visualization?
- How is a selection identified and restored without the shell knowing its
  schema?
- Do tags and marks generalize, or are they heap-shaped? Answer from the second
  domain's needs, not from heap's implementation.

## 6. Split out as their own proposals

Real ideas with user value independent of any boundary. Judge them on that, not
as side effects of a refactor:

- **Undo/redo over analysis data.** Renaming an allocation, editing a tag,
  moving a mark. Needs its own scope: which operations are transactional, how
  it interacts with `marksDirty` and autosave, whether it is per-trace. If it
  lands before Stage 4, keep it heap-owned; generalizing it is a Stage 4
  question.
- **Multiple open traces.** See §5 — large, user-facing, and a prerequisite
  question for the host rather than part of it.

## 7. Summary

The end state is a shell hosting several analysis domains. The route there runs
through the split, not around it: ~400 lines of `main.js` are already
domain-independent, and separating them is both the bulk of the work and the
part that does not depend on knowing what the second domain is.

Do Stage 0, then 1, 2, 3 — each verifiable, each useful on its own, each
leaving the host cheaper to add. Start Stage 4 when there is a second domain to
design it against, and build the two together.

## Derived artifacts (added 2026-07-25)

This document binds nothing on its own. The work it proposes lives in tickets,
which own status; the rationale it argues lives in a decision record:

- [D002](../decisions/D002-shell-split-before-host.md) — why the host is last.
- Stage 0 and Stage 1 — done, before this repository adopted the protocol;
  `git log 41f4e37..a18c1ce`.
- T001 — the namespacing
  constraint from §3, carried out of Stage 1.
- T002 — Stage 2.
- T003 — Stage 3.
- T004 — Stage 4, and §5's open questions.

§6's two proposals (undo/redo, multiple open traces) have no tickets: neither is
started, and each needs its own exploration first.
