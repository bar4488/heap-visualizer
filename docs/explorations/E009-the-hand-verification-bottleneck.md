---
id: E009
title: "The hand-verification bottleneck: what the person actually checked, and what a machine could have"
status: settled
updated: 2026-07-25
---

# The hand-verification bottleneck — 2026-07-25

Four tickets finished in one session and none of them could be closed. Each sat
at `doing` with every agent-checkable item green and one item outstanding: a
person looking at the app. This records what that check was actually for, where
the line between "a machine cannot do this" and "nobody built the thing that
could" falls, and what would move it.

Nothing here is decided. [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)
stands as written until something explicitly changes it.

## What happened

[T001](../tickets/T001-namespace-heap-session-state.md),
[T002](../tickets/T002-panel-content-as-data.md),
[T007](../tickets/T007-src-dist-layout.md) and
[T003](../tickets/T003-typescript-at-the-contracts.md) were each written to
completion, committed, and left `doing` with a handoff naming what a person had
to look at. They were closed later in the same session, after Bar checked them,
in one pass over all four.

What the agent could establish on its own, and did:

- `cargo test` 33, `node --test` 44, `tsc` clean over two configs.
- A built `dist/` answering HTTP 200 for `/`, `main.js`, `worker.js`,
  `shell/panels.js`, `heap/panels.js`, the wasm, `style.css`, `demo.heapl`, and
  a source map.
- A demonstration that a typo'd message name fails the build and that
  `build.sh` exits non-zero without emitting.

**HTTP 200 is evidence a file exists, not evidence the page works.** That is the
honest boundary of what was verified before handing over. Every asset could
answer 200 while the app throws on the first import and paints nothing.

## Why the person's check mattered

Not one reason — three, and they are worth separating, because they do not have
the same answer.

**(a) Boot and wiring.** Does the page load with no console error, do all module
specifiers resolve in a browser, does the `Worker` construct, does the wasm
instantiate, does the first frame paint anything at all. This was most of what
T007 and T003 actually needed: T007 moved the served tree and T003 rewrote every
import specifier through `tsc`. The specific fear was concrete — `new
Worker('worker.js')` resolves against the *document*, not the module, so an
emitted `dist/js/main.js` would have looked for `dist/worker.js` and failed at
runtime with everything still type-checking and every test passing.

**(b) Behavior through the real worker.** Stepping, playback, seeking, filter,
session save and restore across a reload. The JS suite covers `buildSession →
applySession` against a DOM stub; it does not cover the same round trip through
`localStorage`, a real `Worker`, and an engine that answers. T001's whole risk
lived there.

**(c) Judgment.** Does the map look right, does the drag feel right, is a panel
title in the right place, is the label placement legible. T002 moved seven panel
titles out of `index.html` into a table and into an empty `<span class="ph-t">`
— nothing but a person can say the heads still look correct.

**Only (c) is inherently a person's.** (a) is binary and deterministic. (b) is
mostly deterministic and already has a hook: `window.__heap_visualizer` exposes
`UI`, which exists precisely so a human can drive the app from a console.

## What D001's evidence does and does not cover

D001 rejects browser automation on the grounds that a harness "would have caught
approximately none of the 17 findings in [E002](E002-review-2026-07-24.md)".
That is true, and it was measured against **bug discovery in existing code** —
finding a render hot-path defect, an aliasing `&'static mut`, a hand-synced
allowlist.

The question that blocked these four tickets is a different one:
**regression confirmation after a mechanical change.** Did moving files, or
compiling them, break the boot path. A harness that catches none of E002's
findings could still have answered that in seconds, four times.

*Inference, not evidence:* I believe (a) and most of (b) would have been
mechanically checkable for all four tickets. I have not built the harness, so
this is an estimate, not a measurement.

## The cost structure changed under D001's feet

D001 was written when the repository had **zero** JavaScript toolchain — no
npm, no dev dependencies, nothing. Against that baseline, a browser harness
meant introducing a package manager, a browser driver, and a standing
maintenance cost, to a project that had none.

[T003](../tickets/T003-typescript-at-the-contracts.md) and
[D004](../decisions/D004-typescript-is-the-language-for-web.md) spent that
first cost already: `package.json`, `npm install`, two dev dependencies, and a
build step now exist. **The marginal cost of one more dev-only dependency is no
longer the same number D001 priced.** That is a fact about the repository, not
an argument that a harness is worth it — but D001's cost side deserves
re-pricing before it is cited again.

## What would have prevented the block

Roughly in order of cost, and all of them are suggestions:

1. **A module-graph check with no browser.** Parse every emitted module in
   `dist/`, resolve every relative specifier, and assert each target exists.
   Pure Node, no dependency, maybe forty lines. It would have covered T007's
   and T003's single largest risk — the one that motivated mirroring the old
   layout rather than emitting into `dist/js/`. It does not prove the page
   works; it proves the graph is not broken.

2. **A boot smoke test in a headless browser.** Load the page, capture console
   errors, wait for the worker's `ready` and a `loaded` for `demo.heapl`, assert
   the address canvas is not uniformly blank. One dev dependency, a few hundred
   lines, no pixel assertions and no gesture simulation — deliberately class (a)
   only, and stopping there is what keeps it cheap and stable.

3. **The same harness driving `UI` for class (b).** Seek, step, set a filter,
   save a session, reload, assert the state came back. Uses the console handle
   that already exists. More valuable and more likely to become flaky; worth
   doing only after (2) has proven stable.

4. **Making `main.js` importable without side effects.** It currently wires the
   whole app at import time, which is why no Node test can import it at all.
   Fixing that would let a stubbed-DOM test cover a slice of the boot path with
   no browser — and it is a structural improvement independent of testing.
   Probably belongs with [T008](../tickets/T008-convert-web-to-typescript.md).

What is explicitly **not** the answer: the agent driving a browser by hand,
click by click, to satisfy a done-when item. It is slow, it is unrepeatable, its
result cannot be checked by anyone else, and it re-creates the fixed smoke
checklist that [T006](../tickets/T006-drop-fixed-smoke-checklist.md) deleted for
going unused. **If a check is worth doing every time, it is worth writing down
as code, not as a procedure for either a human or an agent to follow.**

## The batching problem, noticed in passing

Four tickets waited on one verification pass. That is efficient for the person —
one context switch instead of four — and worse for attribution: if the map had
failed to render, the cause was somewhere in four independent changes. The
commits are separate and individually revertible, which is
[D003](../decisions/D003-one-slice-per-commit.md) doing its job, so the damage
was bounded. But "one pass over four tickets" gives less per-ticket confidence
than four passes, and it is worth being honest that the closing evidence for
each of the four is weaker than the ceremony suggests.

*Open:* is the right rule "at most one hand-verification-pending ticket at a
time", or is batching fine as long as commits stay revertible? No evidence
either way yet — one occurrence.

## Open questions

- Is (1), the module-graph check, worth doing unconditionally? It is the
  cheapest item here by a wide margin and needs no decision about browsers.
- Does a class-(a) boot harness earn its cost now that a dev toolchain exists —
  and if it does, does D001 get amended or does a companion decision sit beside
  it saying "discovery stays manual, boot regression does not"?
- Where does such a harness run? There is no CI in this repository. A test
  nobody runs is worse than no test.
- Would any of this have changed the *outcome* for these four tickets, or only
  the latency? Everything came back clean. One clean sample says nothing about
  how often the answer would have been different.

## Outcome

_Settled 2026-07-25 by Bar._

**Nothing here becomes work. No harness, no module-graph check, no ticket.**
[D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) stands exactly as
written, unamended, and no companion decision sits beside it.

The reason is the evidence this document was missing when it was written: the
four changes it worried about all worked first try. The verification pass came
back clean, and it came back clean because the risk was smaller than the
document estimated. Everything above under "what would have prevented the block"
was reasoning from a fear, not from a failure — the section itself marks its
central claim as *inference, not evidence*, and that inference is what did not
hold up. The four open questions are answered the same way: none of them is
worth resolving until something actually breaks.

The general form, which is the part worth keeping: **do not build machinery
against a problem that has not happened.** A cheap check is still cost — to
write, to run, to keep working, and to read past forever after. "It is only
forty lines" is not evidence that it is needed. The protocol already says a
process rule needs two recorded instances of the failure it prevents; this is
the same test applied to tooling, and here there is not even one.

This does not retire the underlying observation. If a mechanical change does
break the boot path and a person catches it, that is instance one, and this
document is where the case restarts — as evidence next time, not inference.

## Correction — 2026-07-25

Appended after settling; the text above is left as written.

The Outcome says "[D001] stands exactly as written, unamended". That stopped
being true the same day. Bar amended D001 later on 2026-07-25, during
[T008](../tickets/T008-convert-web-to-typescript.md), on the objection this
document did not raise: it treated a person's check and a browser harness as
one question, when the actual gap was that *cheap* checks were being handed to
a person along with expensive ones. Amended D001 says an agent runs everything
cheap itself and a person's look is not a gate on every ticket.

**What that does not change is this document's own conclusion.** No harness, no
module-graph check, no boot smoke test — E009's outcome on building new tooling
stands, and the amended decision says so explicitly. The correction is to the
sentence about D001 being unamended, not to the answer.

## Related

- [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md) — the standing
  decision, unchanged by this document.
- [D003](../decisions/D003-one-slice-per-commit.md) — why the batching damage
  was bounded.
- [D004](../decisions/D004-typescript-is-the-language-for-web.md),
  [E008](E008-typescript-and-the-build-boundary.md) — where the toolchain came
  from, and the cost that is now already paid.
- [T006](../tickets/T006-drop-fixed-smoke-checklist.md) — the last attempt at a
  written manual procedure, and why it was dropped.
