# 02 — Engine soundness and boundary design

Three findings in the WASM core that are not performance: one is undefined
behavior, one is an unclear contract, one is a boundary cost the specs already
half-acknowledge.

---

<a id="f7"></a>

## F7 — `app()` hands out aliasing `&'static mut`

**Fixed** in `9ea5201` ("F7: stop handing out aliasing &'static mut App").
`app()` now returns `*mut App`; every use site narrows the borrow to its own
scope (`let a = unsafe { &mut *app() };`). The nested-call sites
(`hp_events_filtered_json`, `hp_tag_t_range`) go through private helpers
(`events_json`, `tag_seq_range`) taking `&mut App` instead of re-entering
another export while holding a borrow — the leaf-entry-point invariant this
relies on is documented on `app()` itself.

**Where** `core/src/lib.rs:64`; demonstrated at `core/src/lib.rs:1042`.

**What**

```rust
fn app() -> &'static mut App {
    unsafe {
        let slot = &mut *APP.0.get();
        if slot.is_none() { *slot = Some(App::new()); }
        slot.as_mut().unwrap()
    }
}
```

Every call mints a fresh `&'static mut App` to the same object, with no
borrow tracking. Rust's aliasing model permits exactly one live `&mut` to a
value; two is undefined behavior regardless of whether the generated code
happens to work.

This is not hypothetical. `hp_events_filtered_json` holds one across the
creation of another:

```rust
pub extern "C" fn hp_events_filtered_json(from: u32, count: u32) {
    let a = app();                                  // &mut App #1, live below
    if !ev_filter_active(a) {
        return hp_events_json(from, count);         // calls app() → &mut App #2
    }
    // ...
}
```

`hp_tag_t_range` (`lib.rs:618`) has the same shape, though NLL ends the first
borrow before the nested call, making it benign under current codegen and still
a Stacked Borrows violation.

**Why it matters** It is UB the optimizer is entitled to exploit — LLVM may
assume the two references do not alias and reorder or elide stores across the
nested call. Nothing is observably broken today; the risk is that a future
inlining decision silently changes behavior, which is the worst class of bug to
chase. Miri would flag it immediately.

The `unsafe impl Sync` on `Global<T>` (`lib.rs:24`) is separately fine: the
target is single-threaded and the comment says so.

**Fix** Mechanical, no ABI change. Either:

```rust
fn with_app<R>(f: impl FnOnce(&mut App) -> R) -> R { /* ... */ }
```

and wrap each export's body, or keep `app()` but have it return `*mut App` and
narrow the borrow at each use site. The nested-call sites need untangling
either way — `hp_events_filtered_json` should call a private helper that takes
`&mut App` rather than re-entering the public export.

---

<a id="f8"></a>

## F8 — Reset responsibility is split between two incomplete mechanisms

**Fixed** in `37f5764` ("F8: make hp_parse_begin a complete reset") — the
first option in the fix list below. `hp_parse_begin` now does `a.cfg =
Cfg::new()` (plus the store/view/parser reset it already did), so the engine
is correct standalone; `specs/08-architecture.md` §8.2 was updated to state
that re-instantiation is purely the memory measure, not the reset mechanism.

**Where** `core/src/lib.rs:107` (`hp_parse_begin`) and `web/worker.js:82`
(re-instantiation).

**What** There are two mechanisms for making a new trace load start clean, and
neither is the contract:

- `hp_parse_begin` resets `selected`, `filter`, `x_zoom`, `x_pan` — but **not**
  `cfg.crop`, `cfg.overrides`, `cfg.tag_colors`, `cfg.color_mode`,
  `cfg.overlap_mode` or `cfg.ghosts`.
- The worker discards the whole WASM instance per load, which resets
  everything. [08-architecture §8.2](../../../specs/08-architecture.md)
  documents this, correctly, as a *memory* measure (Rust never returns pages to
  the browser).

So the partial reset is dead weight — except that it is *incomplete* dead
weight, which is worse than either extreme. A reader cannot tell whether
`hp_parse_begin` is meant to be sufficient, and the omissions look like
oversights rather than decisions.

**Why it matters** No live bug: re-instantiation covers it. But the engine is
also used natively by tests, where re-instantiation does not happen, and the
next person to reuse an instance (a second trace in one instance, a comparison
view) inherits stale crop and per-allocation colors keyed by event index —
indices that now mean different allocations.

**Fix** Pick one and say so in the spec:

- **Either** make `hp_parse_begin` a complete reset (`a.cfg = Cfg::new()` plus
  the store/view/parser reset it already does), making the engine correct on
  its own and re-instantiation purely a memory optimization —
- **or** delete the partial reset and document re-instantiation as the sole
  mechanism, with a note in `hp_parse_begin` that it deliberately does not
  reset config.

The first is one line and keeps the native path honest.

---

<a id="f9"></a>

## F9 — JSON strings on the per-frame boundary

**Not fixed — reassessed as not worth it yet.** F1–F3 shipped and dominated
the measured cost by an order of magnitude, which is exactly the condition
this entry's "why it matters" says to wait for. F5 (also fixed) removed the
per-frame `format!` allocation churn around this same label list without
changing its JSON shape, which was the cheap part of this finding. The
binary-record redesign below is unclaimed; revisit if the label budget is
ever raised past 400 or profiling shows it matters again.

**Where** `core/src/lib.rs:805` (`hp_labels_json`), consumed at
`web/worker.js:191`.

**What** [08-architecture §8.1](../../../specs/08-architecture.md) establishes
JSON strings as the uniform shape for structured results, which is a reasonable
call for metadata, warnings and pick payloads. The label list, however, crosses
**every frame**: built with `format!` in Rust (see [F5](01-render-hot-path.md#f5)),
serialized, then `JSON.parse`d in the worker, to produce at most a few hundred
records of four numeric fields and a short string.

`TASKS.md` already parks the analogous `hp_pick` round trip deliberately, and
that reasoning holds — hover is coalesced and the payload is one object. The
per-frame label list is a different case: it is unconditional and grows with
the viewport.

**Why it matters** Low, and it is not currently the bottleneck — F1–F3 dominate
by an order of magnitude. Worth revisiting only after those are fixed, or if the
label budget (currently capped at 400) is ever raised.

**Fix** If it becomes measurable: emit labels as a packed fixed-stride binary
record in the existing return-area convention (kind, x, y, w, event index,
size), with the one variable-length field — the row address — reconstructed in
JS from `base + row * row_bytes`, which the worker can already compute. The
allocation *names* the worker needs are already on its side (`S.names`).
