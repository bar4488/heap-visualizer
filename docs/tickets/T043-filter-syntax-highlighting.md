---
id: T043
title: The filter editor highlights syntax as you type
status: done
updated: 2026-08-09
---

# T043: The Filter Editor Highlights Syntax As You Type

## Outcome

The filter editor colors fields, operators, literals, and calls on every
keystroke, from the same Rust lexer that checks the expression. No second
grammar exists in TypeScript.

## Done when

- [x] `src/filter-dsl/` builds to a standalone wasm module the main thread
      loads, exposing tokenization with byte spans and no other surface.
      `build.sh` emits it and `./build.sh web` does not need cargo for the
      web-only path, or says why it now does. **`./build.sh web` is unchanged**
      — both modules are built by the full run only.
- [x] Highlighting is synchronous per keystroke — no worker round trip, no
      debounce, no frame in which typed text is unstyled.
- [x] The editor is still a `textarea` with an overlay behind it: selection,
      undo, IME, and paste keep working, and overlay and textarea agree on font
      metrics at every zoom level the app supports.
- [x] An unlexable draft still renders, still checks, and still applies exactly
      as it does today. Highlighting never gates Apply.
- [x] The token-to-class mapping is covered by a web test against known
      sources, so a token kind added in Rust and unhandled in the overlay is
      visible without a browser.
- [x] Escaping is asserted: a source containing `<`, `&`, or a quote renders as
      text, not markup.
- [x] ANL-003 says the editor highlights, and what that does and does not
      affect.
- [x] All four checks in [context](../context.md#test) pass.

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

## Result

`src/filter-dsl/` gains a `cdylib` target and two modules: `highlight.rs`
classifies source into coloured runs, and `wasm.rs` is the C ABI the main
thread calls. `build.sh` emits it as `dist/filter_lexer.wasm` — **62 KB**,
because the crate still has no dependencies. The editor is a `<textarea>` with
transparent text over a `<pre>` that draws the coloured copy.

**Highlighting never fails.** `lex_lossy` shares the whole token definition
with the parser's `lex` and turns an unlexable byte into one `Invalid` token
instead of an error, so a half-typed draft still colours. The runs tile the
source exactly — asserted in the Rust tests and again in the web tests, because
a dropped byte would slide every colour after it off the text underneath.

**Byte offsets, not string indices.** The lexer speaks UTF-8 and JavaScript
strings are UTF-16, so `highlightHtml` slices the encoded bytes and decodes
back. A site name with an accent in it is ordinary, and getting this wrong
would have misplaced every colour after the first one — it has its own test.

The removed spellings (`&&`, `||`, `!`, `..`) colour as mistakes, which is the
answer the parser gives and the reader now gets before pressing Apply.

**Verified against the real module, not only the mapping.** A node script
loaded `dist/filter_lexer.wasm`, ran five sources through the exported ABI, and
checked every run tiled its input: ASCII, multibyte, an invalid spelling, and
an incomplete `alloc.`.

**What no suite covers is the overlay's alignment** — that the coloured text
sits exactly under the textarea's own at every zoom and wrap point. The CSS
gives both boxes the same font, padding, border, wrapping and tab size, and the
overlay follows the textarea's scroll, but this is the kind of risk only an eye
retires ([D001](../decisions/D001-web-changes-are-hand-smoke-tested.md)). If
the module fails to load, `.unhighlighted` puts the text back in the textarea,
so the failure mode is plain rather than invisible.
