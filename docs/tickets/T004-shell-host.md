---
id: T004
title: The shell host, designed against a real second domain
status: todo
updated: 2026-07-25
---

# T004: The Shell Host, Designed Against a Real Second Domain

## Outcome

`src/web/shell/` hosts more than one analysis domain: registries for document types,
views, panels and commands; a document model whose domain state the shell does
not interpret; selection and navigation carried without being read; workspace
persistence separate from per-domain state.

## Blocked

Waiting on a second domain that is concrete — named, with a known data source,
a known set of views, and someone ready to build it. Until then every extension
point here is a guess, and an extension point with one implementation is not an
abstraction. See [D002](../decisions/D002-shell-split-before-host.md).

## Context

Stage 4 of [E007](../explorations/E007-web-architecture-direction.md#stage-4--the-host-designed-against-the-second-domain).
Its §5 lists the questions that must have answers before this starts; the
largest is whether several documents are open at once, which touches the
single-engine-instance decision in [ARCH-001](../../spec/08-architecture.md#arch-001-the-wasm-core), session
persistence, and the whole toolbar. That is a user-facing feature and must be
decided as one, not arrive as a side effect of a refactor.

When this is picked up it will not be one ticket. Re-ground it, answer §5's
questions in explorations, and split.

## Done when

- [ ] A second domain runs in the same shell as heap, with no heap identifier in
      `src/web/shell/`.
- [ ] Workspace state persists independently of either domain's state.

## Non-goals

- Building the host before the second domain exists.
- Generalizing the heap worker protocol. A second domain gets its own worker.
