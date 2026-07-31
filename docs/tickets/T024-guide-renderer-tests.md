---
id: T024
title: The guide's markdown renderer is covered by the web suite
status: done
updated: 2026-07-31
---

# T024: The Guide's Markdown Renderer Is Covered by the Web Suite

## Context

`T019` shipped `src/web/guide.ts` with two pure string functions —
`render(src)` and `inline(text)` — carrying a real block and inline grammar:
headings with a level clamp, `-`/`*` list runs, fenced code, `---` rules,
paragraphs, and inline code / strong / em / links. `inline` also decides
whether a link becomes an `<a>` or a `.g-act` button, which is the whole
mechanism SHELL-009 constrains.

`docs/context.md` describes the web suite as covering the layer's pure
functions. Nothing in `src/web/test/` imports `guide.ts`; the renderer has no
assertion on it at all. It is the cheapest uncovered surface in the module and
the only new one that is testable without a browser.

Both functions are module-private today, so the ticket includes exporting them.

## Outcome

`node --test 'src/web/**/*.test.ts'` asserts the guide's markdown grammar,
including the action-link boundary and the escaping that makes rendering
authored markdown into `innerHTML` safe.

## Done when

- [x] `src/web/test/guide.test.ts` exists and runs under
      `node --test 'src/web/**/*.test.ts'` with no npm and no browser, using
      `installDom()` and a dynamic import like `session.test.ts` does —
      `guide.ts` reaches `window` through `shell/dom.ts` at import time.
- [x] Block grammar asserted: headings at each level including the clamp at
      `####` and beyond, a list run closed by the next block, a fenced code
      block whose contents are not treated as markdown, an unterminated fence
      still emitted, `---` as a rule, and blank lines dropped.
- [x] Inline grammar asserted: code spans, strong, em (including that `**a**`
      is not read as em), and that an inline construct inside a code span is
      left alone.
- [x] Link handling asserted: `#show:`, `#do:` and `#set:` become
      `button.g-act` carrying the verb in `data-act`; a relative link stays an
      in-tab `<a>`; an absolute link gets `target="_blank"` and
      `rel="noreferrer"`.
- [x] Escaping asserted: `<`, `>`, `&` and `"` in authored prose reach the
      output escaped, so nothing in a guide page can close an attribute or open
      a tag.
- [x] Every guide page under `src/web/guide/` renders without throwing, and
      every `#show:`/`#do:`/`#set:` id in them appears in
      `src/web/index.html` — the check that would have caught the
      `guide/traces/` path bug T019's third pass found by hand.
- [x] `render` and `inline` are exported from `guide.ts`; nothing else in the
      module's surface changes and no behavior changes.
- [x] Both `tsc` configs, the three suites, and `./build.sh web` pass.

## Non-goals

- Testing `highlight`, `act`, `run`, `load`, or the resize grip. Those are
  DOM-and-timing behavior, and D001 says what covers that.
- Growing the renderer. Tables, nested lists, ordered lists and reference links
  are unsupported on purpose (`guide.ts:24`); the tests pin what exists, and a
  page that wants more is a separate ticket.
- Any change to guide content or to `SHELL-009`.

## Result

`src/web/test/guide.test.ts` adds 15 tests. `render` and `inline` are exported
from `guide.ts` with a comment saying why; no other change to the module.

Twelve tests pin the grammar — heading levels and the `h4` clamp, list runs and
what closes them, fenced code including an unterminated fence, rules and blank
lines, code spans, strong, `**a**` not being read as em, the three action verbs
becoming `button.g-act`, a fourth verb *not* becoming one, relative versus
absolute links, and escaping of `<`, `>`, `&` and `"`.

Three run over the shipped pages: every page renders, every
`#show:`/`#do:`/`#set:` id resolves to an `id="…"` in `index.html`, and every
`?trace=guide/traces/…` link resolves to a file on disk. That last one is the
mechanical form of the bug T019's third pass found by hand, where every
scenario link pointed at `guide/<file>` instead of `guide/traces/<file>`.

**The tests were mutation-checked rather than trusted for passing first try.**
Disabling the action-link branch so `#show:` renders as an anchor fails 1;
removing the `esc()` call from `render` fails 2. Both were restored and the
suite returns to 15 passing.

`node --test 'src/web/**/*.test.ts'` reports 75 passing. Both `tsc` configs
exit 0, both `cargo test` suites pass, and `./build.sh web` emits `dist/guide/`
with all five sections and all five traces.

Not covered, and not attempted: `highlight`, `act`, `run`, `load` and the
resize grip — DOM and timing, which is D001's territory.
