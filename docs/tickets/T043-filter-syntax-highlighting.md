---
id: T043
title: The filter editor highlights syntax as you type
status: todo
updated: 2026-08-07
---

# T043: The Filter Editor Highlights Syntax As You Type

## Outcome

The filter editor colors fields, operators, literals, and calls on every
keystroke, from the same Rust lexer that checks the expression. No second
grammar exists in TypeScript.

## Done when

- [ ] `src/filter-dsl/` builds to a standalone wasm module the main thread
      loads, exposing tokenization with byte spans and no other surface.
      `build.sh` emits it and `./build.sh web` does not need cargo for the
      web-only path, or says why it now does.
- [ ] Highlighting is synchronous per keystroke — no worker round trip, no
      debounce, no frame in which typed text is unstyled.
- [ ] The editor is still a `textarea` with an overlay behind it: selection,
      undo, IME, and paste keep working, and overlay and textarea agree on font
      metrics at every zoom level the app supports.
- [ ] An unlexable draft still renders, still checks, and still applies exactly
      as it does today. Highlighting never gates Apply.
- [ ] The token-to-class mapping is covered by a web test against known
      sources, so a token kind added in Rust and unhandled in the overlay is
      visible without a browser.
- [ ] Escaping is asserted: a source containing `<`, `&`, or a quote renders as
      text, not markup.
- [ ] ANL-003 says the editor highlights, and what that does and does not
      affect.
- [ ] All four checks in [context](../context.md#test) pass.

## Context

[E019 §Syntax highlighting](../explorations/E019-a-python-shaped-filter-language.md#syntax-highlighting)
records the three options and why the second wasm module won on 2026-08-07: it
is the only one with a single owner for the grammar and no lag.

Runs after [T042](T042-the-filter-language-is-python-shaped.md) so the token
kinds being colored are the final ones.

Rendering is the part no suite covers
([D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)) — overlay
alignment is exactly the kind of risk only an eye retires. Name it in the
commit.

## Non-goals

- Bracket matching, inline diagnostics in the gutter, hover types, a
  minimap, or anything else from a language server. E010's editor scope holds.
- Replacing the `textarea` with `contenteditable`.
- Highlighting anywhere but the filter editor.
