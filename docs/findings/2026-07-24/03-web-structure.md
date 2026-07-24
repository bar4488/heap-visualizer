# 03 — Web layer structure

Nothing here is broken. Every finding in this file is future cost: the front end
works and is legible section by section, but it has no internal boundaries, so
every change is a whole-file change.

The Rust side is *not* spaghetti — module boundaries are clean and each file has
one job. This is entirely about `web/`.

## Shape

| Metric | `web/main.js` |
|---|---|
| lines | 3,049 |
| exports / imports | 0 |
| module-level mutable bindings besides `UI` | 14 |
| `UI` fields | 22 |
| `worker.postMessage` call sites | 89 |
| `innerHTML` assignments | 25 |
| `querySelectorAll` rewiring loops | 45 |
| ad-hoc `/dpr` conversions | 30 |

`web/worker.js` is 817 lines: a 30-case `onmessage` switch containing a
15-case nested switch.

---

<a id="f10"></a>

## F10 — `main.js` is 3k lines in one flat scope

**Partially addressed, not fixed.** `fmt.js` and `rpc.js` — the two modules
this entry's fix list says to do first — were extracted as part of F15 and
F11 respectively, and the `setHtml`/event-delegation work from F12 removed
some of the list-rebuild churn this entry also names. The remaining split
(`panels.js`, `events-panel.js`, `analysis.js`, `session.js`, `timeline.js`,
`addr-view.js`) was deliberately left undone: see the root
[README's "F10: why it's still open"](README.md#f10-why-its-still-open) for
the reasoning (call-site fan-out + no runtime verification available on the
fixing side). `main.js` is smaller than it was but still one flat scope.

**Where** `web/main.js` throughout.

**What** Trace loading, panel drag-docking, drawer management, the virtualized
events list, tags, marks, session persistence, timeline interaction, tooltips,
the search overlay and the allocation detail panel all share one namespace. Any
of the 89 `postMessage` sites can read or write any state.

State lives in two places that are not distinguished: the `UI` object (22
fields, mixing durable state like `tags`/`bookmarks` with per-frame caches like
`state` and transient interaction state like `sel`/`selMirror`), and 14 loose
module-level bindings that are effectively a second, undeclared state object:

```
hoverRects   searchItems  searchSel      panelZ         lastAddrMarkYs
lastSessionJson  sessionSaveTimer  tlHoverReq  convertReq  convertInFlight
convertCb    pickQueue    tooltipOwner   mouse
```

**Why it matters** The file is well sectioned with banner comments and the
functions are individually small, which carries it much further than most 3k-line
files get. But there is no unit smaller than "the file" to reason about, test, or
change in isolation — and no way to tell from a function signature what it may
touch.

**Fix** Split along the seams the banner comments already mark, in rough order
of independence (each is close to a lift-and-shift, since the worker is already
`{ type: 'module' }`):

| Module | Contents |
|---|---|
| `fmt.js` | `fmtBytes`, `fmtTime`, `fmtNum`, `parseSize`, `esc` — also imported by the worker, see [F15](#f15) |
| `rpc.js` | the worker request layer, see [F11](#f11) |
| `panels.js` | `makePanelWindow`, drawers, docking, drop preview (~330 lines, self-contained) |
| `events-panel.js` | `evState`, virtual list, drag-select |
| `analysis.js` | tags, names, marks, `.heapa` build/apply |
| `session.js` | `buildSession`/`applySession`/autosave |
| `timeline.js` | `setupTimeline`, `clampView`, hover |
| `addr-view.js` | pick, hover rects, scroll anchoring echo suppression, horizontal zoom |

Do `fmt.js` and `rpc.js` first: they are small, they are imported by everything
else, and `rpc.js` deletes duplication rather than just moving it.

---

<a id="f11"></a>

## F11 — Five hand-rolled worker request/response mechanisms

**Fixed** in `095829e` ("F11: one worker request/response layer
(web/rpc.js)"). `rpc.js` provides `request()` (one-shot) and
`requestLatest()` (coalesced per key — a superseded request's promise is
dropped, not resolved), sharing one `reqId → resolver` map; the five reply
cases in `worker.onmessage` collapsed to one default branch. The worker now
answers `pick`/`tlhover`/`tags-dump` even before a trace loads (previously a
request made before load could leave the in-flight slot stuck forever).

**Where** `web/main.js:2730` (pick), `:2584` (timeline hover), `:2619`
(convert), `:1920` (`allocInfoWaiters`), `:1932` (`dumpWaiters`).

**What** Five implementations of "ask the worker something and handle the
reply", in three distinct styles:

- **`pick`** — `pending.pick` + `pickQueue` + `flushPick`, coalescing: keep only
  the newest request while one is in flight.
- **`tlhover`** — `pending.tl` + `tlHoverReq` + `flushTlHover`. Identical
  coalescing logic, separately written.
- **`convert`** — `convertReq` + `convertInFlight` + `convertCb` + `flushConvert`.
  Same again, plus a callback slot.
- **`alloc-info`** and **`tags-dump`** — two `Map`s keyed by `reqId` holding
  promise resolvers. Identical to each other.

Each carries its own stale-reply guard (`if (m.reqId !== pending.x) return;`),
and each is wired into the central `worker.onmessage` switch by hand.

**Why it matters** Five places to get the stale-reply check right, five places
a new query type could be added inconsistently, and the coalescing policy —
the part that actually prevents a backlog during a fast drag — is stated three
times.

**Fix** One `rpc.js`:

```js
request(type, payload)              // → Promise, for one-shot queries
requestLatest(key, type, payload)   // → Promise, coalesced per key
```

Both share one `reqId → resolver` map and one dispatch entry in `onmessage`;
`requestLatest` drops the superseded promise instead of resolving it. That
replaces all five mechanisms and removes the `pending` object entirely. The
five reply cases in the `onmessage` switch collapse to one default branch that
resolves by `reqId`.

---

<a id="f12"></a>

## F12 — `innerHTML` rebuild + rewire on every state change

**Fixed** in `b2b10c5` ("F12: stop rebuilding + rewiring lists on every state
change"). The color-picker handler now updates only the affected row's
swatch on `oninput` and rebuilds the names list on `change`, so a live drag
no longer destroys the input the user is dragging. Structurally, the
`build*Section` family goes through `setHtml` (skips when markup is
unchanged) plus a small `delegate()` helper — one listener per (container,
event type), dispatching on `data-*` — removing 17 of the 45
`querySelectorAll` rewiring loops.

**Where** 25 sites; the pattern is `build*Section()` — e.g. `web/main.js:1666`
(`buildTagsSection`), `:1748` (`buildNamesSection`), `:1831`
(`buildAddrMarksSection`).

**What** Each renders a template string into `innerHTML`, then re-attaches every
handler with a `querySelectorAll` loop. Any change to any item rebuilds and
rewires the whole list.

The sharp edge is at `web/main.js:2870`, in the detail panel's colour picker:

```js
q('.d-color').oninput = () => {
  UI.allocColors.set(info.e, q('.d-color').value);
  worker.postMessage({ type: 'alloc-color', e: info.e, rgb: ... });
  buildNamesSection();     // ← rebuilds the whole names list, per input tick
  markDirty();
};
```

`oninput` on `<input type="color">` fires continuously while the user drags
inside the picker, so this destroys and recreates the names list — including
its own `<input type="color">` elements — on every tick of a live drag.

**Why it matters** Wasted work is the least of it: rebuilding inputs while one
is being interacted with drops focus and selection state, and any element the
user is mid-gesture on is replaced underneath them.

**Fix** Two independent steps:

1. Immediate: in that handler, update only the affected row's swatch (or debounce
   the rebuild to `change`, keeping `oninput` for the engine message so the map
   still updates live).
2. Structural: the existing `setHtml()` helper (`main.js:433`) already skips
   assignment when markup is unchanged — extend that discipline to the
   `build*Section` family, and use event delegation (one listener on the list
   container, dispatching on `data-*`) instead of rewiring N handlers. That
   removes most of the 45 `querySelectorAll` loops.

---

<a id="f13"></a>

## F13 — Three coordinate systems reconciled ad hoc

**Fixed** in `a275866` ("F13: one conversion boundary between device px and
CSS px"). `toCss(rect, minWH)`/`toCssLen` on the main-thread side and
`toDevice` on the worker side replace the scattered `/dpr`/`*dpr`
expressions at `drawMoveLink`, `flashRects`, the scroll-spacer computations,
and the pick/addr-at/tlhover/scroll/rowPx message handlers. Canvas-drawing
constants (fonts, label padding) kept their explicit `dpr` factors — those
are device-px layout, not boundary crossings, per the fix note below.

**Where** 30 `/dpr` divisions scattered across `web/main.js`; the reverse
`* dpr` conversions in `web/worker.js`.

**What** The app juggles device pixels (canvas raster, engine geometry), CSS
pixels (DOM overlays, pointer events) and virtual scroll pixels (the address
line's full height). Conversions happen inline at each use:

```js
content += `<rect class="hover-rect" x="${r.x / dpr}" y="${r.y / dpr}"
  width="${Math.max(1, r.w / dpr)}" height="${Math.max(1, r.h / dpr)}"/>`;
```

**Why it matters** The rule "engine geometry is device px, DOM is CSS px" is
real and consistently followed — but it is enforced by 30 individually-correct
divisions rather than by a boundary. One missed conversion is a subtly
misaligned overlay that only shows on non-integer-DPR displays, which is
exactly the configuration least likely to be tested.

**Fix** A pair of helpers (`toCss(rect)`, `toDevice(pt)`) applied once where
worker geometry enters the DOM layer — chiefly `drawMoveLink`, `flashRects`,
`renderAddrMarkLines` and the pick/hover rect paths. The conversion then exists
in one place per direction.

---

<a id="f14"></a>

## F14 — `onmessage` switch with a hand-synced allowlist

**Fixed** in `770ee97` ("F14: settings table replaces the hand-synced
pre-load allowlist"), matching the fix shape below: a `SETTINGS` table keyed
by setting name, each entry carrying its `preLoad` flag next to its `apply`
function. The outer 30-case switch (playback, tags, filter, etc.) was left
as-is — the entry's "same treatment suits the outer switch" was noted but not
required by this fix, since that switch's `!S.loaded` guards aren't a
duplicated-list problem the way `set`'s allowlist was.

**Where** `web/worker.js:418` (30 cases), `:603` (`set`, 15 nested cases),
allowlist at `web/worker.js:604`.

**What** The `set` case guards against pre-load messages with a literal list of
keys duplicated from the nested `case` labels below it:

```js
if (!S.loaded && !['rowPx', 'locked', 'sizeLabels', 'addrLabels',
    'allocSizeFormat', 'overlapMode', 'ghostMode'].includes(m.key)) break;
```

Two lists that must agree, with nothing enforcing it. Adding a settable that
should work before a trace is loaded requires remembering to edit both.

**Why it matters** Low — the failure mode is a silently dropped setting, not a
crash. But it is invisible until someone notices a toolbar toggle does nothing
on a fresh page.

**Fix** Replace both with one table:

```js
const SETTINGS = {
  rowPx:  { preLoad: true,  apply: (v) => { /* ... */ } },
  rowBytes: { preLoad: false, apply: (v) => { /* ... */ } },
  // ...
};
```

The guard reads `SETTINGS[m.key].preLoad`, so the fact lives next to the
handler. Same treatment suits the outer switch, whose cases are already
uniform (`if (!S.loaded) break;` appears 15 times, and `!S.loaded` guards
appear 25 times in all).

---

<a id="f15"></a>

## F15 — `fmtBytes` / `clampView` duplicated between the two JS layers

**Fixed** in `0d3ffdd` ("F15: extract shared web/fmt.js for the two JS
layers"). `web/fmt.js` now holds `fmtBytes`/`fmtHexSize`/`fmtAllocSize`
(format mode passed as an argument, as suggested)/`fmtNum`/`parseSize`/`esc`/
`clampView`, imported by both `main.js` and `worker.js`. The Rust ↔ JS
palette mirror was left alone, as this entry recommends.

**Where** `web/main.js:56` ↔ `web/worker.js:325` (`fmtBytes`, `fmtAllocSize`);
`web/main.js:2473` ↔ `web/worker.js:408` (`clampView`); `CAT`/`RAMP` at
`web/main.js:9` ↔ `core/src/render.rs:18`.

**What** Three pairs of mirrored definitions, each carrying a comment telling
the reader to change both together.

**Why it matters** The **Rust ↔ JS** duplication is defensible and correctly
documented: the engine paints pixels, `main.js` paints DOM chrome, and sharing
would mean exporting the palette across the WASM boundary every frame for no
benefit. `TASKS.md` already settled this. Keep it.

The **`worker.js` ↔ `main.js`** duplication is not defensible. Both are JS, and
the worker is already constructed as `{ type: 'module' }` (`main.js:16`), so a
shared `fmt.js` works today with no build step and no bundler:

```js
import { fmtBytes, fmtAllocSize, clampView } from './fmt.js';
```

`clampView` in particular *must* stay bit-identical between the two — its whole
purpose is that optimistic local zoom agrees with the worker's authoritative
clamp. That is a correctness requirement currently enforced by a comment.

**Fix** Extract `web/fmt.js` with `fmtBytes`, `fmtAllocSize`, `fmtHexSize` and
`clampView`; import from both sides. `fmtAllocSize` needs its format mode passed
in as an argument rather than read from the DOM (`main.js`) or module state
(`worker.js`) — that is the only real work involved.
