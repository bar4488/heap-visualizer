# Working on Heap Visualizer

The active workflow is in [AGENTS.md](../AGENTS.md). It is intentionally short.

## Start here

- [context.md](context.md) — build, run, test, and deployment commands.
- [spec/](../spec/README.md) — authoritative product behavior.
- [../TODO.md](../TODO.md) — short list of worthwhile follow-up work.

## Repository map

| Path | Purpose |
|---|---|
| `src/core/` | Rust/WASM trace, analysis, filter, and rendering engine. |
| `src/filter-dsl/` | Rust filter parser and lexer. |
| `src/web/` | TypeScript browser UI and worker. |
| `src/local-server/` | Loopback trace and analysis API. |
| `src/server/` | Hosted feature-request service. |
| `dist/` | Generated web output; do not edit directly. |
| `spec/` | Product requirements. |
| `docs/decisions/` | Architectural rationale worth retaining. |
| `docs/explorations/` | Historical research and proposals. |

## Practical rules

1. Preserve unrelated work in the tree.
2. Keep domain semantics in their existing owner. In particular, analysis and
   filter behavior belong in Rust rather than being reimplemented in TypeScript
   or the server.
3. Update the spec with intentional behavior changes.
4. Run relevant automated checks and state any remaining manual verification.
5. Do not push without an explicit request.

Requirement identifiers such as `TRACE-010`, `ANL-003`, and `ARCH-008` are
stable references and should be used when linking code or documentation to a
specific product rule.
