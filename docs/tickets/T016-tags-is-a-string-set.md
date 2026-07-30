---
id: T016
title: The tag filter field is a string set named `tags`
status: done
updated: 2026-07-29
---

# T016: The Tag Filter Field Is a String Set Named `tags`

## Outcome

The filter language exposes allocation memberships as one set-typed field,
`tags`. `tags == {"a", "aa"}` is exact set equality, `tags contains "a"` is
membership, and `tags == {}` is untagged. The scalar field `tag` — whose `==`
secretly meant "any membership satisfies this" — does not exist, and no value
in the evaluator is a hidden multi-string.

## Context

`src/core/src/filter_eval.rs` types `tag` as `optional string`
([E010](../explorations/E010-filter-expression-language.md) field table) but
evaluates it to an internal `Value::Strings` list, and then overloads `equal`,
`order`, and the three string methods so any one member satisfying the operand
makes the predicate true. So `tag == "a"` reads as equality and means
inclusion, `tag < "b"` means "some membership sorts before b", and there is no
way to ask for an allocation's whole membership set. Overlapping memberships
([T015](T015-overlapping-tags.md)) made that overload load-bearing rather than
incidental.

The user's decision, 2026-07-29: the field is plural and set-typed, `==` is
exact set equality (order-insensitive), and `contains` is the membership test.
Untagged is `tags == {}` — `tags` is a required field whose value is the empty
set, not an optional one that goes missing.

`contains` becomes a binary operator, like `overlaps`. It keeps its own
lexical keyword so completion can recognize the operand position, and the
parser accepts a keyword as a member name after `.` so `stack.contains("x")`
and `site.contains("x")` keep parsing.

Old persisted sources say `tag == "x"` and stop checking. The heap session's
`filter.languageVersion` gate exists for exactly this: bumping it to 2 means a
version-1 filter is not restored rather than restored broken. Saved filters in
`.heapa` marks carry no version — they are source text and will report a
diagnostic when set, which is the existing behavior for a source that no
longer checks.

## Done when

- [x] `field_type` types `tags` as a required set of strings, and `tag` reports
      `unknown field ` + backtick-tag: `filter_eval::check` on `tag == "a"` fails.
- [x] `tags == "a"` fails the check; the message names the type mismatch.
- [x] `tags == {"a", "aa"}` is true only for an allocation whose memberships
      are exactly a and aa, in either order, and false for one also tagged `b`.
- [x] `tags contains "a"` is true when a is one of the memberships; `contains`
      with a non-set left operand or a mistyped right operand fails the check.
- [x] `tags == {}` matches every untagged creator and nothing else; `tags != {}`
      is its complement.
- [x] `tags is missing` fails the check — `tags` is not optional.
- [x] `Value::Strings` no longer exists, and `equal`, `order` and the string
      methods have no multi-value overload.
- [x] Completion: `tags` is offered as a field; after `tags` the operators are
      `==`, `!=`, `contains` and not `is`; after `tags contains ` and inside
      `tags == {` the current tag labels are offered, escaped.
- [x] The tag legend chip writes `tags contains "name"` and the untagged chip
      writes `tags == {}`; both toggle and both light up when applied.
- [x] `buildHeapSession` writes `filter.languageVersion: 2`, and a session
      whose filter section is version 1 restores no filter.
- [x] [ANL-009](../../spec/07-analysis.md#anl-009-filtering-by-tag) states the
      set semantics; ANL-002 no longer carries the membership-aware `tag == "a"`
      rule. (The new requirement is ANL-009, not ANL-008 — that id is taken by
      the session blob's shape.)
- [x] `cargo test` passes on both crates: 42 core, 24 filter-dsl.
- [x] `node --test 'src/web/**/*.test.ts'`, `npx tsc -p tsconfig.test.json`, and
      `./build.sh web` pass. Run and confirmed by the person working here on
      2026-07-29; see Result.

## Non-goals

- `named()`, custom `field.*` columns, or any other unfinished E010 surface.
- Set operations beyond `==`, `!=`, `contains` — no subset operator, no set
  literal on the left, no other set-typed field.
- Rewriting `tag == "x"` sources already saved in a `.heapa` file or a session
  blob. They report a diagnostic; nothing migrates them.
- `contains` as a second spelling for the string methods. It requires a set.

## Work log

- `contains` is a lexer keyword (`TokenKind::Contains`) rather than a
  contextual identifier, so `completion.rs` recognizes the operand position by
  token kind like every other operator. The cost is one wart: `postfix` accepts
  the keyword as a member name after `.`, which is what keeps
  `stack.contains("x")` parsing.
- `operand_context` now shares one `operand_site` helper, because a set literal
  can follow `==`/`!=` as well as `in`; before, everything but `in` required
  nothing after the operator.
- `tags is missing` type-checked as bool and evaluated constant-false, which is
  a worse answer than a diagnostic. `is missing` now requires an optional
  operand — a language-wide tightening, in scope because `tags` is the field
  that made the constant case reachable from the UI. `size is missing` is now a
  diagnostic too; completion already only offered `is` for optional fields.
- Set equality is subset-both-ways over `equal`, so a repeated member in a
  literal cannot change the answer. Memberships are unique by construction.

## Result

Every done-when item holds. `tags` is the only tag surface the filter language
has: exact set equality, `contains` for one member, `tags == {}` for untagged,
and diagnostics for `tag == "a"`, `tags == "a"` and `tags is missing`.

The Rust half was verified in the session that wrote it — `cargo test`, 42 core
and 24 filter-dsl, including new coverage for each semantic above and for
`stack.contains("x")` surviving the new keyword.

**The web checks were run by the person working here, not by the agent.** That
session's shell could not execute `node` or `npx` at all: its command
classifier was unavailable for anything outside a read-only fast path, so
`cargo`, `git` and `rg` worked throughout and `node --test` never did. The three
commands — `node --test 'src/web/**/*.test.ts'`, `npx tsc -p
tsconfig.test.json`, `./build.sh web` — were reported passing on 2026-07-29 and
the ticket closed on that report. The agent did not see their output.

As always under [D001](../decisions/D001-web-changes-are-hand-smoke-tested.md),
clicking the legend chips in a browser and watching the map dim is not
automated by anything.
