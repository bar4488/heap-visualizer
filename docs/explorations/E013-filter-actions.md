---
id: E013
title: Filter actions — legend chips, match range, saved filters, filter to tag
status: settled
updated: 2026-07-25
---

# E013: Filter Actions

## Summary

Four user-requested actions around the E010 filter expression, all of which
either write the expression or consume its match set:

1. clicking a legend chip (site / thread / tag) toggles that predicate in the
   filter expression;
2. an allocation's **match range** replaces the filter instead of inserting at
   the cursor;
3. a filter expression can be saved under a name and set again later; and
4. the current match set can be turned into a tag in one action.

## Why it matters

[E010](E010-filter-expression-language.md) removed the site/thread checkboxes
and the tag visibility checkboxes on purpose: they were a second filtering
surface with its own state, invisible in the expression and impossible to
compose. That argument is about *state*, not about *affordances*. E010 already
allows the other direction — "existing actions that create filters insert
visible DSL text" — and every action here is that: a click that writes source
the user can read, edit, and apply. None of them adds filter state beside the
expression.

The gap they close is that the expression is currently the only way in. Naming
a site correctly is a typing exercise even though the name is on screen in the
legend, and a working set that took a paragraph to express cannot be kept.

## Decisions

Three product questions were open. All three were decided by the user on
2026-07-25.

**Chips toggle a conjunct.** Clicking a chip whose predicate is not present
appends `&& <predicate>`; clicking one whose predicate *is* present as a
top-level operand removes it, with its connector. Shift-click uses `||`. This
composes with hand-written source, which replacing the whole expression does
not, and it makes the chip a two-way control rather than a one-way insert.

The alternatives were replacing the expression outright (predictable, but
throws away composition — the reason the checkboxes were removed was that they
*could not* compose) and insert-at-cursor only (no toggle-off, no active
state).

**Saved filters live in the marks file.** A named expression is authored
analysis, like a tag or a bookmark: it is worth sharing and worth exporting.
The session blob was the cheaper option — no `.heapa` field, no round-trip
test — but a saved filter that disappears when the analysis is handed to
someone else is the wrong half of [ANL-007](../../spec/07-analysis.md#anl-007-persistence--heapa-files-and-autosave)'s
split. A global preference list was rejected outright: an expression naming
`site == "json_node"` is meaningless against another trace.

**Filter to tag snapshots the current matches.** The action creates (or
reuses) a tag and assigns it to every allocation the *applied* filter matches
right now. Afterwards it is an ordinary tag: editable, deletable, exported in
`taggedEvents`, and unaffected by later edits to the filter.

A live tag whose membership is an expression was rejected as a different
object wearing a tag's name. Tags are anchored to creator events everywhere in
the engine — the store's `tag` column, `hp_tags_dump_json`, the `.heapa`
`taggedEvents` map, the tag color legend — and re-deriving them from an
expression touches all of it. Range-scoping the snapshot to the current
selection was also offered and not taken; the filter is already the working
set, and [ANL-002](../../spec/07-analysis.md#anl-002-acquiring-tags) range
tagging covers filter+range for the cases that want it.

## Constraints

**Chips only exist for three of the six color modes.** `buildLegend` in
`main.ts` paints chips per site (mode 1), per thread (mode 2) and per tag
(mode 5); modes 3 and 4 are continuous ramps with nothing to toggle, and mode
0 hides the legend. The tag legend also carries an *untagged* chip, whose
predicate is `tag is missing`.

**Toggling has to respect precedence.** `&&` binds tighter than `||`, so
appending `&& p` to a source whose top level is `||` would silently change the
existing expression's meaning. The rule is to parenthesize the existing source
in exactly that case — `(a || b) && p` — and otherwise append flat.

**A chip's active state comes from the applied source, not the draft.** The
applied source is what is actually filtering, so it is what the chip's
highlight must report. The toggle itself edits the draft, which is equal to
the applied source in the ordinary case.

**Predicate text must be escapable.** Site names, tag names and allocation
names are arbitrary strings; the generated predicate quotes them with `"` and
`\` escaped, per the lexer's JSON-subset escapes.

**Chip clicks and match range apply immediately.** A visual filter that
requires a trip to the Filter panel and a press of Apply is not a visual
filter. This does not weaken [ANL-003](../../spec/07-analysis.md#anl-003-filter)'s
draft/applied separation — *typing* still never changes visibility. These are
actions, and an action that writes source and applies it is one gesture, not
two.

## Risks

- **An invalid draft plus a chip click.** Applying fails and the previous
  filter stays active, per ANL-003. The chip highlight then disagrees with the
  editor, which is honest — the highlight reports what is filtering — but it is
  the one state worth checking by hand.
- **Tagging a large match set.** `hp_tag_filter_matches` walks the match
  bitset once and writes the `tag` column; it is the same order of work as an
  Apply, which is already gated. No new gate is proposed.
- **255 tags.** Filter-to-tag makes it cheap to create tags, and the ceiling is
  255. Reusing an existing name is the escape hatch, and it is the default
  when the name entered matches one.

## Outcome

All four actions are approved and specified. The chip toggle, the match-range
change, saved filters in marks, and filter-to-tag are behavior changes to
[ANL-002](../../spec/07-analysis.md#anl-002-acquiring-tags),
[ANL-003](../../spec/07-analysis.md#anl-003-filter) and
[ANL-007](../../spec/07-analysis.md#anl-007-persistence--heapa-files-and-autosave),
made by the tickets below. Nothing here binds until those land.

## Derived artifacts

- T011 — legend chips toggle a
  filter conjunct.
- T012 — match range replaces
  the applied filter.
- T013 — named filters saved in the marks
  file.
- T014 — tag every current match.
