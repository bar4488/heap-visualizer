---
id: E011
title: "Contextual completion for the filter DSL"
status: open
updated: 2026-07-25
---

# Contextual completion for the filter DSL — 2026-07-25

The Filter panel should complete the language it actually accepts: fields,
operators, members, functions, and trace/analysis values valid at the cursor.
It should do that without replacing the native textarea, adding an editor
dependency, or teaching TypeScript a second copy of the DSL.

This exploration describes the implementation seam and the interaction. It
does not approve implementation or change
[ANL-003](../../spec/07-analysis.md#anl-003-filter).

## What already exists

Most of the transport was anticipated by [E010](E010-filter-expression-language.md):

```text
filter-check { source, cursor }
  -> validity, diagnostic, and optional completions
```

The main thread already:

- keeps draft and applied source separate;
- converts the textarea's UTF-16 cursor to a UTF-8 byte offset;
- debounces `filter-check`;
- rejects stale replies by request generation; and
- shows the returned diagnostic without interpreting it.

The protocol already sends `cursor`, and its reply has an optional
`completions?: string[]`. That is only a placeholder. The worker currently
discards the cursor and calls `hp_filter_check(len)`. The core parses the
complete source and returns validity or one syntax diagnostic; it does not
type-check and returns no completion data.

There is also a surface mismatch that matters here. The evaluator currently
implements the built-in allocation fields, `death.seq`, `death.time`, `abs`,
and the three string methods. It directly rejects `named()` and custom
`field.*`; allocation names are not mirrored into the core. Completion must
not advertise those unfinished E010 surfaces as though they work.

## Direction

Completion meaning belongs beside checking in Rust. The web owns presentation,
focus, keyboard interaction, and text replacement. The worker only translates
the typed query to the core and returns its JSON reply.

```text
textarea source + UTF-8 cursor
              |
              v
      filter-check query
              |
              v
 syntax context + semantic catalog in Rust
              |
              v
 diagnostic + replacement span + ranked candidates
              |
              v
  small listbox attached to the textarea
```

The browser must not keep arrays of fields, methods, or operators. Those lists
would drift from the parser and evaluator, and JavaScript would eventually
offer source that Apply rejects. The same Rust catalog must drive semantic
checking and completion.

## Completion contract

Strings alone are insufficient: the UI needs to know what source to replace,
what to insert, and enough kind information to render a useful compact row.
The reply should become:

```ts
type FilterCompletion = {
  label: string;
  insertText: string;
  kind: 'field' | 'function' | 'member' | 'operator' | 'value';
  detail?: string;
};

type FilterCompletions = {
  start: number;       // UTF-8 byte offset, inclusive
  end: number;         // UTF-8 byte offset, exclusive
  items: FilterCompletion[];
  hasMore?: boolean;
};
```

`filter-check-result` retains `valid`, `available`, and `diagnostic`, and adds
`completions?: FilterCompletions`. One query therefore keeps the diagnostic
and completion views consistent.

The core returns byte spans because every parser span is already a UTF-8 byte
span. The main thread converts the returned replacement span to textarea
UTF-16 offsets before calling `setRangeText`. That conversion needs one tested
helper; indexing a JavaScript string directly with Rust byte offsets is wrong
as soon as the source contains a non-ASCII string value.

`label` is display text. `insertText` is exact DSL source. For an observed site
named `parser "fast"`, for example, the label can show the unquoted value while
`insertText` is the correctly JSON-escaped `"parser \"fast\""`. This is token
completion, not a snippet system: completion does not add argument templates,
closing expressions, or cursor placeholders.

Candidate count must be bounded. The core filters by the case-sensitive typed
prefix, returns at most 50 items, and sets `hasMore` when typing another
character would narrow a larger catalog. This prevents a trace with thousands
of sites or custom keys from becoming a large worker reply and DOM update.

## Finding the context

Ordinary `parse(source)` cannot provide completion by itself because the most
useful drafts are intentionally incomplete:

```text
size >
site.
tag in {"sus
size > 4KiB &&
```

The syntax crate should gain a cursor-aware entry point separate from
executable parsing. Its lexer identifies the token or string containing the
cursor and the whole replacement span. The parser then reads the prefix up to
a private cursor marker and reports the grammar state at that marker. Text
after the marker is irrelevant to discovering candidates and must not require
general error recovery.

This is not a second forgiving grammar. The completion entry point may stop at
the cursor and describe what could occur there; only the existing strict
`parse` result can be checked or applied. A recovered or prefix tree never
reaches evaluation.

The syntax result should describe categories, not heap symbols:

```text
expression
comparison operator
boolean operator
member of <receiver expression>
argument of <callee> at position N
constant in a set
string contents
```

The core's semantic layer resolves the surrounding expression type and maps
those categories to concrete candidates. This keeps `heap-visualizer-filter-dsl`
dependency-free and unaware of allocations, tags, sites, or trace columns.

Completion in the middle of an identifier replaces the entire identifier,
not only the text before the cursor. Completion inside a quoted string replaces
the whole string token with a newly escaped string literal. Punctuation,
whitespace, and text outside the returned span are untouched.

## What appears where

The initial implementation should cover only executable language:

| Cursor context | Candidates |
|---|---|
| expression start, after `&&`, `||`, `(`, or `!` | built-in fields, `true`, `false`, `abs` |
| after a complete value | operators valid for its type |
| after `death.` | `seq`, `time` |
| after a string value or field plus `.` | `contains`, `starts_with`, `ends_with` |
| after `stack.` | `contains` |
| string value compared with `site` | observed site names |
| integer value compared with `thread` | observed thread ids |
| string value compared with `tag` | current tag labels |
| after `is` | `missing`, `not` |
| after `is not` | `missing` |

Filtering is case-sensitive prefix matching, matching the language. Static
candidates sort by language role and then lexically. Observed values sort by
their display form; completion should be deterministic rather than reshuffle
while typing.

Members and operators are type-directed. `span` offers `overlaps`; strings
offer equality, ordering, `in`, missingness where applicable, and string
methods; booleans do not offer numeric operators. The exact catalog belongs
in one Rust table shared with semantic checking, not spread through match arms
in the completion function.

`name`, `named()`, allocation members, `field.*`, `death.field.*`, and custom
field values should appear only when their execution and checking support
lands. At that point the already-required analysis-symbol and custom-field
catalogs become completion inputs automatically. Until then, omitting them is
more honest than showing disabled rows.

## UI interaction

Keep the native multiline textarea. A compact listbox is attached directly
below it, above the existing status line; it does not attempt to float at the
pixel position of the caret. Caret geometry in a scrolling textarea requires
a mirrored hidden editor and is not worth making this feature depend on.

The list opens automatically when the focused editor receives non-empty
candidates. `Ctrl+Space` / `Cmd+Space` explicitly requests and opens it,
including at an empty source. It closes on Escape, blur, Apply, or an empty
reply.

While open:

- Up/Down changes the active item.
- Enter or Tab accepts it.
- Escape closes it without changing source.
- `Ctrl+Enter` / `Cmd+Enter` still applies and wins over completion.
- Pointer down on an item accepts it without losing the textarea selection
  first.

Acceptance replaces exactly the returned byte span, places the caret after
the inserted text, focuses the textarea, and immediately schedules a new
check. It never Applies. Choosing `site` may therefore lead to operators next;
choosing `==` may lead to observed site values.

The list uses `role="listbox"` and `role="option"`, with
`aria-controls`, `aria-expanded`, and `aria-activedescendant` on the textarea.
The validity/status line remains separate so moving through candidates does
not replace or repeatedly announce the current diagnostic.

Cursor movement matters even when the text does not change. The main thread
must request completion on textarea `input`, `click`, and selection movement,
plus the explicit shortcut. Today `filterEdited` skips checks for empty source
and when draft equals applied source; those conditions may still suppress
validity work, but they must not suppress a completion request. An applied
expression remains editable and completable.

## Core and worker changes

The narrow ABI change is:

```text
hp_filter_check(source_len, cursor_byte_offset)
```

The worker already has both values, so it passes the cursor instead of dropping
it. The JSON result uses the richer completion contract above. Apply remains
unchanged and never computes completions.

Before candidate generation, the current syntax-only `hp_filter_check` needs a
real non-scanning semantic check. Otherwise completion would have to infer
types using rules that checking itself does not enforce until the first
creator allocation is evaluated. The useful factorization is:

```text
parse -> resolve/type-check -> checked expression
                              |             |
                              |             +-> Apply scan
                              +-> completion context
```

This also fixes an existing behavior: a syntactically valid but semantically
invalid draft currently reports `Valid`, then fails only during Apply. The
checker and Apply should call the same resolver. Completion is the reason to
factor that catalog now, not a reason to introduce a parallel lightweight
type system.

Observed sites and threads already live in the core store. Tag labels are
already mirrored into the core. No worker-to-main round trip or duplicated
`UI.meta` catalog is needed for the initial dynamic values.

## Implementation slices

The change can stay reviewable as four commits:

1. Add cursor-context tests and the syntax-only completion context to
   `src/filter-dsl/`.
2. Factor core resolution/type information out of evaluation; make
   `hp_filter_check` perform the same non-scanning semantic check as Apply and
   return typed candidates.
3. Carry the structured contract through `protocol.ts` and `worker.ts`, and
   add tested UTF-8-byte ↔ UTF-16 replacement helpers.
4. Add the textarea listbox, keyboard/pointer behavior, cursor-triggered
   requests, and styling.

This ordering keeps executable parsing unchanged in the first slice and makes
the UI the last consumer, after the returned contract is stable.

## Verification

The syntax crate needs table tests for:

- empty source and expression/operator/member positions;
- a cursor at the start, end, and middle of an identifier;
- member access and incomplete calls;
- quoted strings with escapes and non-ASCII text;
- malformed text before the cursor;
- valid suffix text after the cursor; and
- source, nesting, argument, and set-member limits.

Core tests should assert both positive candidates and important omissions:
type-invalid operators are absent, trace sites/threads and current tag labels
appear, JSON string insertion is escaped, the 50-item cap is stable, and
unfinished `named`/custom-field surfaces are absent.

Web tests should cover byte-to-UTF-16 span conversion and source replacement as
pure functions. TypeScript checks the request/reply shape. The existing cheap
suites and `./build.sh web` cover the rest statically.

No existing test drives focus, textarea selection, or listbox keys in a real
browser. The final handoff must therefore name the remaining interaction risk:
list placement, selection preservation on pointer acceptance, and the
Enter/Tab/Ctrl+Enter precedence need a person's pass.

## Recommendation

Implement through the existing `filter-check` request, with Rust returning one
typed, bounded completion set and the web rendering a simple attached listbox.
Do not add a language server, editor framework, caret-mirroring overlay, fuzzy
search, snippets, or a JavaScript language catalog.

The prerequisite is small but real: checking and completion need one shared
semantic resolver. Building the popup first would make the visible part quick
and the language boundary wrong.
