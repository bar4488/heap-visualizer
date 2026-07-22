# heap-visualizer — Specifications

This folder is the authoritative specification of heap-visualizer, split into
modules that are independent to read but together describe the whole app. It is
the reference for future edits, refactors, and analysis of the code: when
behavior and spec disagree, either the code has a bug or the spec must be
updated in the same change.

## Conventions

- Specs describe **what** the app does and **why** each decision was made, at a
  high level. Implementation detail appears only where the implementation *is*
  the decision — a non-trivial choice made for performance or an opinionated
  style — and is called out as such.
- Wire-format and semantic rules use RFC-style language (**must**, **should**,
  **may**). Everything else is descriptive.
- File/symbol references (e.g. `core/src/state.rs`, `hp_seek_seq`) are
  navigation aids, not part of the contract.

## Module map

| Spec | Covers | Primary code |
|------|--------|--------------|
| [01-overview](01-overview.md) | Goals, the three coordinated views, terminology, repo layout | — |
| [02-trace-format](02-trace-format.md) | The `.heapl` JSONL wire format: records, ordering, validity | `core/src/parse.rs`, `core/src/json.rs` |
| [03-core-model](03-core-model.md) | Columnar event store, live set, time travel, warnings | `core/src/store.rs`, `core/src/parse.rs`, `core/src/state.rs` |
| [04-address-map](04-address-map.md) | The address-line: row layout, collapsing, coloring, picking | `core/src/state.rs`, `core/src/render.rs` |
| [05-timelines](05-timelines.md) | The temporal and sequential strips: binning, zoom, tag lanes | `core/src/timeline.rs`, `web/main.js` |
| [06-playback-navigation](06-playback-navigation.md) | Playhead, seeking, playback, stepping, jump/search, scroll anchoring | `web/worker.js`, `web/main.js` |
| [07-analysis](07-analysis.md) | Tags, names, marks, filter, crop, selection, `.heapa` files, persistence | `web/main.js`, `core/src/lib.rs` |
| [08-architecture](08-architecture.md) | The three-layer runtime: WASM core, worker, DOM; ABI and protocol | `core/src/lib.rs`, `web/worker.js` |
| [09-ui-shell](09-ui-shell.md) | Toolbar, floating/dockable panels, events panel, allocation windows, shortcuts | `web/main.js`, `web/index.html` |
| [10-tooling](10-tooling.md) | Trace generator, build pipeline, tests | `gen.py`, `build*.sh`, `core` tests |

Reading order for newcomers: 01 → 02 → 03 → 04 → 05, then the rest as needed.
