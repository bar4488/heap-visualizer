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
- File/symbol references (e.g. `src/core/src/state.rs`, `hp_seek_seq`) are
  navigation aids, not part of the contract.

## Requirement identifiers

Every requirement carries a permanent identifier matching `^[A-Z]+-[0-9]{3}$`,
written as the heading it sits under: `## MAP-003: Layout stability`. **Cite a
requirement by its identifier, never by a section number** — a section number
breaks the first time a section is inserted above it, which is the edit a
growing spec makes most often.

Identifiers are permanent and never reused: a new requirement takes the next
free number for its prefix, wherever in the file it belongs, and a deleted one
leaves a hole. Their numeric order is therefore not the reading order, and a
file may split or merge without any identifier changing. Descriptive prose and
rationale carry no identifier — only statements something could conform to or
violate.

Finding everything that touches one: `rg 'MAP-003' .`

## Module map

| Spec | Prefix | Covers | Primary code |
|------|--------|--------|--------------|
| [01-overview](01-overview.md) | — | Goals, the three coordinated views, terminology, repo layout | — |
| [02-trace-format](02-trace-format.md) | `TRACE-` | The `.heapl` JSONL wire format: records, ordering, validity | `src/core/src/parse.rs`, `src/core/src/json.rs` |
| [03-core-model](03-core-model.md) | `MODEL-` | Columnar event store, live set, time travel, warnings | `src/core/src/store.rs`, `src/core/src/parse.rs`, `src/core/src/state.rs` |
| [04-address-map](04-address-map.md) | `MAP-` | The address-line: row layout, collapsing, coloring, picking | `src/core/src/state.rs`, `src/core/src/render.rs` |
| [05-timelines](05-timelines.md) | `TL-` | The temporal and sequential strips: binning, zoom, tag lanes | `src/core/src/timeline.rs`, `src/web/main.ts` |
| [06-playback-navigation](06-playback-navigation.md) | `NAV-` | Playhead, seeking, playback, stepping, jump/search, scroll anchoring | `src/web/worker.ts`, `src/web/main.ts` |
| [07-analysis](07-analysis.md) | `ANL-` | Tags, names, marks, filter, crop, selection, `.heapa` files, persistence | `src/web/main.ts`, `src/core/src/lib.rs` |
| [08-architecture](08-architecture.md) | `ARCH-` | The three-layer runtime: WASM core, worker, DOM; ABI and protocol | `src/core/src/lib.rs`, `src/web/worker.ts` |
| [09-ui-shell](09-ui-shell.md) | `SHELL-` | Toolbar, floating/dockable panels, events panel, allocation windows, shortcuts | `src/web/main.ts`, `src/web/index.html` |
| [10-tooling](10-tooling.md) | `TOOL-` | Trace generator, build pipeline, tests | `gen.py`, `build*.sh`, `src/core` tests |
| [11-feature-requests](11-feature-requests.md) | `REQ-` | The one server-side surface: the request form, its store, and the review panel | `src/server/app.py`, `src/web/request.ts` |

Reading order for newcomers: 01 → 02 → 03 → 04 → 05, then the rest as needed.
