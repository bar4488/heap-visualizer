# Code review — 2026-07-24

A full read of the code base (~9.4k lines: seven Rust modules, `web/worker.js`,
`web/main.js`, `web/index.html`) with the render hot path measured rather than
estimated. Nothing in this review was fixed; every finding below is open.

Findings are rated by what they cost, not by how easy they are to fix:

| ID | Finding | Area | Severity |
|----|---------|------|----------|
| [F1](01-render-hot-path.md#f1) | Per-allocation row loop never clips to the visible range | render | **high** |
| [F2](01-render-hot-path.md#f2) | Live-set walk is bounded by `max_span`, a global worst case | render | **high** |
| [F3](01-render-hot-path.md#f3) | `ensure_rows()` fully rebuilds on every seek | layout | **high** |
| [F4](01-render-hot-path.md#f4) | Rasterizer inner loops are element-indexed | render | medium |
| [F5](01-render-hot-path.md#f5) | Per-frame allocation churn in `render_addr` | render | low |
| [F6](01-render-hot-path.md#f6) | Timeline tag lanes are O(events in view) | timeline | medium |
| [F7](02-engine-soundness.md#f7) | `app()` hands out aliasing `&'static mut` | soundness | **high** |
| [F8](02-engine-soundness.md#f8) | Reset responsibility split between two incomplete mechanisms | engine | medium |
| [F9](02-engine-soundness.md#f9) | JSON strings on the per-frame boundary | engine | low |
| [F10](03-web-structure.md#f10) | `main.js` is 3k lines in one flat scope | web | **high** |
| [F11](03-web-structure.md#f11) | Five hand-rolled worker request/response mechanisms | web | medium |
| [F12](03-web-structure.md#f12) | `innerHTML` rebuild + rewire on every state change | web | medium |
| [F13](03-web-structure.md#f13) | Three coordinate systems reconciled ad hoc | web | medium |
| [F14](03-web-structure.md#f14) | `onmessage` switch with a hand-synced allowlist | web | low |
| [F15](03-web-structure.md#f15) | `fmtBytes` / `clampView` duplicated between the two JS layers | web | low |
| [F16](04-minor.md#f16) | `to_tag.dedup()` is dead code | engine | trivial |
| [F17](04-minor.md#f17) | `parseSize` fails silently, unlike its sibling inputs | web | trivial |

F1, F2 and F3 are violations of a stated invariant, not merely missed
optimizations — see [01](01-render-hot-path.md) and
[08-architecture §8.1](../../../specs/08-architecture.md).

## Standing assessment

**Rust core: 8/10. Web front end: 5/10.**

The engine is soundly designed. The columnar store, snapshot + bidirectional
incremental replay, prefix-sum timeline binning, lazy columns, and the
worker/OffscreenCanvas split are the right calls and are cleanly executed. The
comments carry decisions and their rationale rather than restating the code
(`GHOST_MARK` idempotence, empty-array-vs-absent filter keys, the anchor-pin
lifecycle), and the 33 tests assert real invariants — snapshot seek ≡ forward
replay, pick prefers the newest overlap, anchor stability across a layout
reflow — not smoke.

The flaws cluster in three places: a render loop that does not clip to the
viewport, a front end with no internal boundaries, and one soundness bug.

## Method

Measurements come from a **scratch copy** of `core/` (the repository itself was
not modified) built with the release profile, driven by a synthetic 300k-event
trace over a 256 MiB address space with 50k allocations live at the measurement
point, rendered at 1600×900 with the default 12 px rows — 76 rows and 70
allocations actually visible.

`bench/` holds the harness. To reproduce:

```sh
cp -r core /tmp/hv-bench && mkdir -p /tmp/hv-bench/examples
cp docs/findings/2026-07-24/bench/*.rs /tmp/hv-bench/examples/
sed -i '/^panic = "abort"$/d' /tmp/hv-bench/Cargo.toml   # examples need unwind
cd /tmp/hv-bench && cargo run --release --example render_cost
```

`render_cost.rs` reports wall time and runs as-is. `row_iters.rs` additionally
counts loop iterations and **does not compile until** the counter patch
documented in its header is applied to the scratch copy of `render.rs` — build
it by name (`--example row_iters`) so the other harness is unaffected.

Absolute times are machine-dependent; the ratios between rows are the finding.

## Reading order

[01-render-hot-path](01-render-hot-path.md) first: it is where the measured
cost is, and F1 is a one-line fix. [02-engine-soundness](02-engine-soundness.md)
next for F7, which is small, mechanical, and removes undefined behavior.
[03-web-structure](03-web-structure.md) is the largest body of work and the
least urgent — nothing there is broken, it is all future cost.
[04-minor](04-minor.md) is a cleanup list.
