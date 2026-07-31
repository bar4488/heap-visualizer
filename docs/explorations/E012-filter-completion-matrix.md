---
id: E012
title: "A complete interaction matrix for filter DSL completion"
status: settled
updated: 2026-07-25
---

# A complete interaction matrix for filter DSL completion — 2026-07-25

E011 established the right ownership and transport, but its first
implementation classified too few cursor states. It knows that an operator is
valid after `span ` but treats exact `span` as a field prefix; it knows the
type of `size` but throws that information away while completing `size ==`.
The result is technically contextual and operationally awkward.

This exploration maps the completion behavior for every executable v1 grammar
position. It supersedes E011's smaller “What appears where” table; E011's
ownership remains unchanged.

## Evidence from the first implementation

- Exact `span` returns only `span`; `span ` returns `overlaps`.
- Exact `tag` returns only `tag`; `tag == ` returns current tag labels when the
  core catalog has them.
- `size == ` falls back to every expression starter rather than numeric
  expressions.
- Site, thread, and tag values are three field-name exceptions rather than
  consequences of the expected right-hand type.
- Completing a field, operator, or method inserts only that token, so the next
  useful context often requires a manual space, dot, or parenthesis.
- Tag labels are mirrored on create, rename, delete, and marks restore.
  Simple labels reach the core, but labels containing JSON escapes are stored
  in escaped rather than decoded form by `hp_set_tag_labels`.

The first three are model defects, not ranking defects. The last is a catalog
decoding bug.

## Candidate vocabulary

Only executable language is offered:

```text
bool       true false freed
number     id address end size usable seq time thread lifetime abs(...)
string     site stack tag
range      span
namespace  death
members    death.seq death.time
methods    contains(...) starts_with(...) ends_with(...)
```

`named()`, `name`, and custom `field.*` stay absent until their evaluator
support exists.

No arbitrary numeric constants are invented. “Numeric candidates only” means
numeric fields/functions plus observed numeric values where the domain has a
catalog, currently thread ids. Site and tag supply their observed string
values. Boolean positions supply `true` and `false`.

## Cursor matrix

| Cursor state | Expected result |
|---|---|
| empty source, after `(`, `&&`, `||`, or `!` | predicate starters: fields, `true`/`false`, `abs`, `death` |
| partial identifier | prefix-matching starters, replacing the whole identifier |
| exact executable field (`span`, `size`, `tag`) | operators valid for that field's type |
| exact namespace `death` | `.` / death members, not scalar operators |
| after `.` | members or methods valid for the receiver type |
| exact function/method name | accept with `(` and move into its argument |
| inside `abs(` | numeric expressions only |
| inside a string method call | string expressions only |
| after `==` or `!=` | expressions with the left operand's scalar type |
| after `<`, `<=`, `>`, `>=` | numeric or string expressions matching the left type |
| after numeric `+` or `-` | numeric expressions only |
| after `overlaps` | ranges only |
| after `in` | `{` plus compatible range starts where numeric |
| inside `{…}` before a member | constants matching the left operand; observed site/thread/tag values first |
| after a complete set member | `,` and `}` |
| after `..` | numeric expressions only |
| after `is` | `missing`, `not` |
| after `is not` | `missing` |
| after a complete boolean expression | `&&`, `||` |

The right-hand type comes from the same `check_type` used by semantic checking.
The syntax context must therefore carry the operator as well as the left
operand; `Value { subject }` is insufficient.

## Domain-value behavior

Domain values augment, rather than replace, compatible expressions:

```text
site ==     observed sites, then string fields
thread ==   observed thread ids, then numeric fields/functions
tag ==      current tag labels, then string fields

site in {   observed sites
thread in { observed thread ids
tag in {    current tag labels
```

Set members are constants, so fields/functions do not appear inside a set.
Values already present in that set may be omitted from later suggestions.

Tags must update without a trace reload:

- creating a tag makes it immediately completable;
- rename replaces the old candidate;
- delete removes it and preserves compacted ids;
- marks restore installs the restored labels before restoring/applying a
  persisted filter; and
- quotes, backslashes, Unicode, and control escapes round-trip as the exact
  visible label.

When there are no tags, `tag ==` still offers compatible string expressions.
It does not show a disabled “no tags” pseudo-candidate.

## Acceptance and progression

Completion inserts the smallest useful syntactic continuation:

| Kind | Inserted form |
|---|---|
| ordinary field/value | token followed by one space |
| `death` | `death.` |
| function | `abs(` |
| method | `contains(` etc. |
| operator/keyword | token followed by one space |
| observed string | escaped quoted literal followed by one space outside sets |
| observed set member | escaped quoted/numeric literal with no trailing space |
| set punctuation | `, ` or `}` |

These are not multi-placeholder snippets. They are token completions with the
single delimiter required to reach the next grammar state. Acceptance
immediately requests completion again, so the list progresses:

```text
span -> overlaps -> span
tag -> == -> "suspect" -> && / ||
site -> starts_with( -> observed/string expressions
```

Exact tokens typed by hand progress too; accepting the token is not required.

## Ranking

Within the valid type:

1. observed values belonging to the left field;
2. literals;
3. fields and functions;
4. structural punctuation and operators.

Prefix matching remains case-sensitive and non-fuzzy. Stable lexical order
breaks ties. The 50-item cap remains.

## Implementation boundary

The syntax crate should report:

```text
Expression
Operator { expression }
Member { receiver }
Operand { left, operator, form }
CallArgument { callee, index }
SetDelimiter
AfterIs
```

`form` distinguishes an ordinary expression, a set member, and a range end.
The syntax crate owns no heap types. The core maps the context through
`check_type`, merges live domain values, ranks candidates, and supplies useful
single-token insertion text.

## Required tests

- exact `span`, `size`, and `tag` advance without a trailing space;
- every binary operator carries its left operand and operator kind;
- numeric, string, boolean, and range RHS lists contain no incompatible types;
- `abs(` and string-method arguments are typed;
- set values and delimiters progress through multiple members;
- tag create/rename/delete/restore synchronization;
- escaped and Unicode tag labels round-trip through the WASM catalog;
- completion acceptance produces the next intended cursor state; and
- the existing UTF-8/UTF-16 replacement tests remain green.

## Outcome

**Settled: the matrix was implemented as specified.** Contextual completion in
`src/filter-dsl/src/completion.rs` follows the cursor positions, acceptance and
progression, ranking, and escaping described above, and the required tests are
in `src/filter-dsl/tests/completion.rs`. The implementation boundary held: the
DSL crate answers positions, and the core supplies live site/thread/tag values
from its own catalog.

One row did not survive contact, and it is the correction below rather than a
change of mind about the design.

_(Recorded 2026-07-31 by [T025](../tickets/T025-e012-carries-a-controlled-status.md),
which found this file carrying `status: complete` — a value neither documented
query matches. The section is added because a settled exploration is required
to carry one; nothing above it was edited.)_

## Correction — 2026-07-29

Every `tag` row above names a field that no longer exists.
[T016](../tickets/T016-tags-is-a-string-set.md) replaced the scalar `tag` with
the set-typed `tags`, so the completion positions changed shape: after `tags`
the operators are `==`, `!=` and `contains` (not `<`, `in`, or `is`); `tags ==`
offers only `{`; `tags contains` and `tags == {` are where the current tag
labels appear. Everything else in this matrix — the sites, the ranking, the
escaping, the delimiters — still describes the implementation. The rest of this
document is left as the dated record it was.
