---
id: E019
title: "A Python-shaped filter language over namespaced objects"
status: open
updated: 2026-08-07
---

# A Python-shaped filter language over namespaced objects — 2026-08-07

[E010](E010-filter-expression-language.md) designed the filter language and is
built. This exploration revises its **surface** — how an expression reads and
how its fields are organised — and its **execution model**, which E010
specified and the implementation never delivered.

E010 stays open and is not edited; where the two disagree, this file is the
later thought and neither is binding until the spec changes and the tickets
land.

Requested by the user on 2026-08-07: make it feel exactly like writing a Python
expression, give it syntax highlighting, and replace the flat global field list
with structured objects — with performance named as the first constraint and an
instruction to report any compromise before implementing.

## The finding that reframes the request

The evaluator (`src/core/src/filter_eval.rs:eval`) is a **tree walk over the
AST, run once per event**. Per allocation it compares field names as strings,
boxes each intermediate into a `Value` carrying `i128`, returns a `Result` per
node, `clone()`s a `String` for `site` and `stack`, and heap-allocates a `Vec`
for `tags`.

E010 §Compilation specifies the opposite — "lower to a compact typed plan",
"no allocation, string construction, hashing, virtual dispatch, or JSON parsing
per allocation" — and gates implementation on meeting it. The UI was built
anyway; the lowering never was.

### Measurement

Native release, 1M creator events, one Apply scan, median of 7. The harness is
[E019-bench/filter_cost.rs](E019-bench/filter_cost.rs), adapted from
[E003-bench](E003-bench/render_cost.rs) and reproducible by the same recipe.

| Predicate | median |
|---|---|
| `size >= 4096` | 38.0 ms |
| `size >= 4096 && address >= 0x10000000` | 47.0 ms |
| `site == "json_node"` | 44.3 ms |
| `thread in {2, 4}` | 78.2 ms |
| `site.starts_with("json")` | 55.4 ms |
| `field.pool == "gfx"` | 38.6 ms |
| **the same predicate as a direct column scan** | **0.8 ms** |

Two conclusions. The tree walk runs about **45× above the floor** its own data
layout allows. And E010's gate — 25 ms median over 1M creators, *in release
WASM* — is already missed by 38 ms of **native** time, before the browser's
penalty.

**This is evidence about the evaluator, not about the request.** But it decides
the order of the work: `alloc.size` is one more AST node and one more string
comparison per access *per event* than `size`, so on today's evaluator the
namespacing this exploration proposes is a measurable regression. On a lowered
plan every name is resolved once at compile time and costs nothing at scan
time. Lowering is not a tax on the redesign; it is what makes the redesign
free.

## The object model

Three objects replace the flat field list. The split is the allocation itself
versus the two records that bound its life:

```text
alloc     the allocation: what it is and how long it lived
malloc    the record that created it
free      the record that ended it, or None
```

| Was | Is | Type |
|---|---|---|
| `id` | `alloc.id` | integer |
| `address` | `alloc.address` | address |
| `end` | `alloc.end` | address |
| `span` | `alloc.span` | range |
| `size` | `alloc.size` | bytes |
| `usable` | `alloc.usable` | optional bytes |
| `tags` | `alloc.tags` | set of string |
| `name` | `alloc.name` | optional string |
| `freed` | `alloc.freed` | bool |
| `lifetime` | `alloc.lifetime` | optional time |
| `seq` | `malloc.seq` | integer |
| `time` | `malloc.time` | time |
| `site` | `malloc.site` | optional string |
| `thread` | `malloc.thread` | optional integer |
| `stack` | `malloc.stack` | stack |
| `death.seq` | `free.seq` | optional integer |
| `death.time` | `free.time` | optional time |
| `field.pool` | `malloc.fields.pool` | per catalog |
| `field["allocator-class"]` | `malloc.fields["allocator-class"]` | per catalog |
| `death.field.reason` | `free.fields.reason` | per catalog |

Everything reachable is reached through one of the three. The only remaining
globals are the two functions, `abs()` and `named()`, plus `len()` and
`range()` proposed below.

Three things this buys beyond tidiness. `free.fields.reason` finally reads as
what it is, instead of `death.field.reason` nesting a namespace inside a
namespace. `site` and `thread` move to `malloc`, which is where they are
actually recorded — an `F` record carries neither. And a reader who types
`malloc.` and reads the completion list learns the whole creator surface
without consulting a table.

**`malloc` is sometimes a realloc.** An `R` record is simultaneously the `free`
of the old allocation and the `malloc` of the new one, so the name is not
literally the C function. It is still the right name: it is the record that
created *this* allocation, which is what every field under it describes.
`realloc` as a fourth namespace would be a second spelling of the same fields
and is rejected.

**Bare `size` is removed, not aliased.** "Fewer globals" is the request, E010
already forbids alternate spellings, and one surface is the whole point.
Persisted sources written against the old names stop resolving — see
[Migration](#migration).

## Python shape

The target is that someone who knows Python can write a correct filter without
reading a grammar. Most of E010's surface already qualifies; the rest is
spelling.

### Free and unambiguous

| E010 | Here | Note |
|---|---|---|
| `&&` `\|\|` `!` | `and` `or` `not` | E010 forbade these as aliases; here they are the only spelling |
| `starts_with` `ends_with` | `startswith` `endswith` | Python's names, no underscore |
| `tags contains "x"` | `"x" in alloc.tags` | `contains` is deleted; `in` is Python's membership operator |
| `stack.contains("f")` | `"f" in malloc.stack` | the same operator, now over a stack |
| `s.contains("f")` | `"f" in s` | and over a string |
| — | `0 <= alloc.size < 4096` | chained comparison, Python-valid, E010 rejected it |
| — | `len(alloc.tags)` | Python's spelling for set size |

Chained comparison and the `in` unification are the two that carry real weight:
between them they remove the language's three least Pythonic constructs at no
runtime cost. `in` becomes overloaded across set membership, substring, and
range containment, all resolved by operand type **at check time**, so the
lowered plan is exactly as specialized as three separate operators would be.

### The three genuine conflicts

Python has no range literal, no overlap operator, and no three-valued logic.
Each was put to the user on 2026-08-07 and decided:

**Ranges and overlap — `range()` and a method.**

```text
alloc.address in range(0x1000, 0x1800)
alloc.span.overlaps(range(0x7f000000, 0x7f100000))
malloc.time in range(0, 500ms)
```

Python's `range` is integral and half-open, which is exactly E010's semantics,
so the borrowed name does not lie. `..` and the `overlaps` operator are
deleted. Overlap becomes a method because no Python operator means it.

**Missing values — `is None`, keeping false-propagation.**

```text
malloc.site is None
alloc.usable is not None and alloc.usable > alloc.size
```

`is missing` is deleted. The **semantics do not change**: any comparison,
arithmetic, method call, or `in` with a missing operand still evaluates false,
where Python would raise `TypeError`. This is the one place the language wears
a Python face over behavior Python does not have, chosen deliberately — the
alternative is failing an entire Apply because one allocation in a million has
no recorded site, which would make ordinary predicates unusable on ordinary
traces.

The rule that a missing test on a *required* field is a diagnostic rather than
a constant survives unchanged from ANL-003.

### Not adopted from Python

No statements, comprehensions, lambdas, `if`/`else` expressions, `%`
formatting, slicing, tuples, `None` as a writable value, or truthiness of
non-bools. `not x` requires a bool; an empty set is not false. The language is
still an expression that maps one allocation to one boolean, and E010's
"deliberately small" rule is unchanged — Python shape is about the spelling of
what exists, not a licence to grow.

### What it reads like

```text
alloc.size >= 4KiB
malloc.site == "json_node" and malloc.thread in {2, 4}
alloc.span.overlaps(range(0x7f000000, 0x7f100000))
"suspect" in alloc.tags and alloc.lifetime > 500ms
alloc.tags == {"suspect", "parser"}
alloc.freed and malloc.site.startswith("xml_")
"parse_config" in malloc.stack
malloc.fields.pool == "gfx" and malloc.fields.refs >= 3
free.fields.reason == "shutdown"
0 <= alloc.size < 4096
malloc.site is None
abs(malloc.seq - named("request root").seq) <= 10
len(alloc.tags) > 1
```

## Execution: the lowered plan

The checked AST compiles to a flat, typed instruction sequence over the
existing columns. The properties that matter are E010's, restated as
acceptance rather than intent:

- per event: no allocation, no `String` clone, no hashing, no JSON parsing, no
  string comparison of a field name, no `Result` per node;
- field names, tag labels, site and thread values, and custom keys resolve to
  integer ids or column indexes **once**, at compile time;
- string equality against a constant becomes interned-id equality where the
  column is interned;
- constant sets become sorted arrays or bitsets;
- `not`/`and`/`or` short-circuit, and cheap clauses are ordered before
  expensive string clauses where that preserves semantics;
- no work proportional to stack depth unless the expression reads a stack; and
- no work for a custom field the expression does not name.

The gates are E010's, unchanged, and they are what the ticket verifies. The
floor measured above says they are reachable with room to spare: 0.8 ms native
for a predicate gated at 25 ms WASM.

Missing values are represented in the plan, not as a `Value::Missing` variant
threaded through every operation. The natural lowering is a validity bit
alongside each optional operand, so the false-propagation rule costs one `and`
rather than a branch per node.

## Syntax highlighting

The lexer is Rust, in `src/filter-dsl/`, and runs in the worker. Highlighting
wants tokens synchronously on every keystroke. Three ways were considered and
the user chose the first on 2026-08-07:

1. **A second WASM module on the main thread.** `filter-dsl` is
   dependency-free, so it compiles to a small standalone artifact the editor
   can call synchronously. One owner of the grammar, no lag, no worker round
   trip. Costs a second wasm output and `build.sh` wiring.
2. Token spans added to the debounced `filter-check` reply. No new artifact,
   but highlighting lags typing by the debounce and freshly typed text is
   briefly unstyled.
3. A hand-written TypeScript tokenizer. Synchronous and cheap, and the grammar
   then has two owners in two languages — the failure `PROTOCOL.md` names under
   "one fact, one owner".

The editor stays a `textarea` with a highlighted overlay behind it rather than
becoming `contenteditable`: selection, undo, IME, and mobile input keep
working, and the overlay only has to agree with the textarea on font metrics.
Tokens carry byte spans already, which is what the overlay consumes.

Highlighting is presentation only. It never gates Apply, and an unhighlightable
draft is still a draft.

## Migration

One cutover, one persisted break. E010 §Persistence already established that a
language change bumps the heap-session version and that old filter state is
ignored rather than adapted, and ANL-008 already ignores an unsupported heap
section. That covers the session's applied source.

What it does not cover is the two places a filter source is written by
something other than a person:

- **`.heapa` marks** carry named filter expressions
  ([T013](../tickets/T013-saved-filters.md)). A saved filter written against
  the old surface will not compile after the cutover.
- **The filter actions** — legend chips, match range, filter-to-tag
  ([T011](../tickets/T011-legend-chips-toggle-filter.md),
  [T012](../tickets/T012-match-range-replaces-filter.md),
  `src/web/filter-actions.ts`) — generate source text and pattern-match on it
  to derive active styling. Every generated predicate and every matcher
  changes.

There is no translator. A saved filter that no longer compiles reports its
diagnostic and is not silently rewritten — E010's rule that a semantic break
gets a direct diagnostic, never silent reinterpretation, applies to the surface
break too.

Whether that is good enough for saved marks is the one open question here: a
one-time mechanical rewrite of stored sources is possible and was not
discussed. It is cheap to add later and impossible to undo, so the cutover
ships without it.

## Derived artifacts

- [D008](../decisions/D008-the-filter-evaluator-is-a-lowered-plan.md) — the
  evaluator is a lowered plan, with the measurement above as its rationale.
- [T041](../tickets/T041-lower-the-filter-to-a-typed-plan.md) — lowering, and
  the gates.
- [T042](../tickets/T042-the-filter-language-is-python-shaped.md) — the
  surface cutover: Python spelling and the three namespaces.
- [T043](../tickets/T043-filter-syntax-highlighting.md) — the editor overlay
  and the main-thread lexer.

Nothing here binds until those land. The spec changes with T042.
