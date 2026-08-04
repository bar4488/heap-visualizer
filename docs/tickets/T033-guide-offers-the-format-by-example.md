---
id: T033
title: The guide opens by handing you a trace file
status: done
updated: 2026-08-05
---

# T033: The Guide Opens by Handing You a Trace File

## Context

Requested 2026-08-05: the guide should start with a downloadable `.heapl` and
say that handing it to a language model is enough for the model to understand
the format. Producing a trace is the first thing anyone must do to use this
tool at all, and the guide's first section was `The map`, which assumes one is
already open.

## Outcome

The guide's first section is `The format`. It links a small commented sample
that downloads rather than navigating the tab, says the sample is the whole
specification to hand a model, and links the same file as an ordinary
`?trace=` autoload for reading it in the app.

## Done when

- [x] `src/web/guide/the-format.md` is first in `SECTIONS` in `guide.ts`.
- [x] `src/web/guide/traces/format.heapl` exists, carries a `#` comment header
      explaining the fields, and holds `H`, `M`, `F` and `R` records plus
      custom producer fields.
- [x] A guide link whose href is a `.heapl` renders with `download`; a
      `?trace=…` autoload link does not. Asserted in `test/guide.test.ts`.
- [x] [SHELL-009](../../spec/09-ui-shell.md#shell-009-the-guide-surface) says a
      trace may be linked directly to be taken away, and that such a link
      downloads.
- [x] `node --test 'src/web/**/*.test.ts'` and `node_modules/.bin/tsc` pass;
      `./build.sh web` copies both new files into `dist/guide/`.

## Non-goals

- Any prose about the format beyond the sample and its comments.
  `spec/02-trace-format.md` remains the normative document.
