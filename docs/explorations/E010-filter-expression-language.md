---
id: E010
title: "A filter DSL for allocations"
status: open
updated: 2026-07-25
---

# A filter DSL for allocations — 2026-07-25

The filter will use one small, allocation-specific DSL. The language choice is
settled for this exploration; this document defines the intended surface and
execution model closely enough to measure and, after a decision and spec
change, implement.

This is still an exploration. It does not approve implementation or change
[ANL-003](../../spec/07-analysis.md#anl-003-filter).

## Non-negotiable direction

The DSL is:

- an expression that maps one allocation to one boolean;
- typed, side-effect-free, and non-Turing-complete;
- parsed and compiled in the Rust/WASM core;
- evaluated over the existing typed columns, never JavaScript allocation
  objects;
- the only filter predicate surface, not an extra predicate combined with the
  current checkbox builder; and
- deliberately small. New syntax needs demonstrated heap-analysis value and a
  bounded execution cost.

There are no statements, variables, assignments, loops, user functions,
lambdas, object construction, imports, reflection, regular expressions, or
host calls. There are no alternate word operators, deprecated spellings, or
compatibility parser modes.

The dim/hide choice remains a presentation mode beside the expression. It is
not part of the DSL.

## Examples

```text
size >= 4KiB
site == "json_node" && thread in {2, 4}
span overlaps 0x7f00_0000..0x7f10_0000
tag in {"suspect", "parser"} && lifetime > 500ms
freed && site.starts_with("xml_")
stack.contains("parse_config")
field.pool == "gfx" && field.refs >= 3
field["allocator-class"] == "small"
address >= named("request root").address - 0x100
address <= named("request root").address
abs(seq - named("request root").seq) <= 10
site is missing
```

The canonical boolean operators are `&&`, `||`, and `!`. In particular, there
are no `and`, `or`, or `not` aliases.

## Grammar

Whitespace is insignificant except inside strings. Comments are not supported:
a persisted filter is one expression, not a program.

```text
source       = or_expr EOF ;
or_expr      = and_expr { "||" and_expr } ;
and_expr     = comparison { "&&" comparison } ;
comparison   = additive [
                 ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) additive
               | "in" ( set | range )
               | "overlaps" range
               | "is" [ "not" ] "missing"
               ] ;
range        = additive ".." additive ;
set          = "{" [ constant { "," constant } [ "," ] ] "}" ;
additive     = unary_expr { ( "+" | "-" ) unary_expr } ;
unary_expr   = "!" unary_expr | postfix ;
postfix      = primary {
                 "." identifier [ "(" [ arguments ] ")" ]
               | "[" string "]"
               } ;
primary      = constant
             | identifier
             | identifier "(" [ arguments ] ")"
             | "(" or_expr ")" ;
arguments    = or_expr { "," or_expr } ;
constant     = integer [ unit ] | string | "true" | "false" ;
identifier   = ( "A"…"Z" | "a"…"z" | "_" )
               { "A"…"Z" | "a"…"z" | "0"…"9" | "_" } ;
```

An integer is decimal or `0x` hexadecimal. Underscores may separate digits but
may not lead, trail, or occur twice. Strings use JSON double-quote escapes.
Keywords are lowercase and identifiers are case-sensitive.

The grammar permits some shapes that checking rejects. For example, set
members must be compile-time constants of one type, `overlaps` requires two
address ranges, and `!` requires a boolean.

Source is limited to 8 KiB, nesting to 32 pairs of parentheses/calls, call
arguments to 16, and a set to 4,096 source members. Exceeding a limit is a
compile error. The parser and checker therefore have bounded stack and memory
requirements even for hostile persisted input.

### Precedence

From tightest to loosest:

1. field access, indexing, and calls;
2. `!`;
3. `+` and `-`;
4. comparisons, `in`, `overlaps`, and missing tests;
5. `&&`;
6. `||`.

Comparison chaining is not allowed. Write `0 <= size && size < 4096`, not
`0 <= size < 4096`.

## Types and literals

The visible types are:

```text
bool
integer
bytes
address
time
string
range<T>
allocation
missing T
```

All numeric values are integral. There are no floats and no implicit
string/number or signed/unsigned conversions.

Units are canonical and case-sensitive:

```text
B  KiB  MiB  GiB
ns us ms s
```

`KiB`, `MiB`, and `GiB` are powers of 1024. Time suffixes are converted to the
trace header's unit at compile time; they are rejected for a `tick` trace.
Bare integers take the required numeric type from their context, so both
`size >= 4096` and `address >= 0x1000` are valid. A literal that overflows its
context is a compile error.

The initial arithmetic table is exact:

```text
integer + integer -> integer
integer - integer -> integer
address + integer -> address
address - integer -> address
address - address -> integer
```

Integer intermediates are signed and wide enough to hold the difference
between any two addresses; lowering may use a cheaper representation when
range analysis proves it safe. Bytes and time values do not support arithmetic
in version 1. Overflow or an address below zero that can be proved while
compiling is an error. Runtime checked arithmetic that fails makes the
enclosing comparison false; it never wraps or traps.

Ranges are half-open: `lo..hi` contains values `lo <= value && value < hi`.
`span` is the allocation's half-open rendered address range
`address..address + max(size, usable)`. Two ranges overlap when each begins
before the other ends.

## Allocation fields

The subject is always the creator allocation:

| Field | Type | Meaning |
|---|---|---|
| `id` | integer | Trace allocation id |
| `address` | address | Base address |
| `end` | address | `address + max(size, usable)` |
| `span` | `range<address>` | `address..end` |
| `size` | bytes | Requested size |
| `usable` | `missing bytes` | Producer-supplied usable size |
| `seq` | integer | Creator event index |
| `time` | time | Creator timestamp |
| `site` | `missing string` | Allocation site |
| `thread` | `missing integer` | Producer thread id |
| `stack` | stack | Creator stack |
| `tag` | `missing string` | Current analysis tag |
| `name` | `missing string` | Current allocation name |
| `freed` | bool | Whether a matching death event exists |
| `lifetime` | `missing time` | Death time minus creator time |
| `death.seq` | `missing integer` | Matching death event index |
| `death.time` | `missing time` | Matching death timestamp |

There are no redundant `birth.*` aliases: `seq` and `time` already mean the
birth event.

An `F` or old half of an `R` inherits its creator's match bit, preserving
[NAV-005](../../spec/06-playback-navigation.md#nav-005-the-events-panel).
Unknown frees have no allocation and do not appear in the filtered list.

The initial language is independent of the playhead. `freed` and `lifetime`
describe the complete trace. A field such as `live_now` is excluded because it
would invalidate the match set on every seek.

## Operations

The initial callable surface is intentionally short:

```text
abs(number) -> number
named(string constant) -> allocation
string.contains(string) -> bool
string.starts_with(string) -> bool
string.ends_with(string) -> bool
stack.contains(string) -> bool
```

`stack.contains(s)` is true when any frame contains `s` as a
case-sensitive substring. All string operations are case-sensitive and
byte-oriented UTF-8 substring operations. No locale rules are involved.

`named("x")` is resolved at compile time and requires exactly one allocation
with that current name. Zero or multiple matches are compile errors. Its
allocation fields are the same fields listed above, including `field.*`.
Renaming an allocation invalidates a compiled filter that uses `named`.

`in` tests equality against a constant set or membership in a half-open range.
Set constants are deduplicated while compiling. Equality requires identical
types; ordering is available only for numeric types and strings.

## Missing values

Missingness is explicit:

```text
site is missing
site is not missing
usable is not missing && usable > size
```

Any comparison, arithmetic operation, method call, `in`, or `overlaps` with a
missing operand evaluates false. This includes `!=`; missing is not an
ordinary value. `is missing` and `is not missing` are the only operations that
inspect it.

This rule replaces the checkbox filter's special treatment of absent site and
thread fields. The DSL does not preserve that legacy behavior.

## Custom trace fields

Caller-defined top-level fields are required in the first version:

```text
field.pool
field.refcount
field["allocator-class"]
death.field.reason
```

Dot access is sugar for an identifier-shaped key; bracket access accepts any
top-level key. The first version filters only scalar `null`, boolean, integer,
and string values. Nested objects and arrays remain displayable in the
Allocation panel but are not addressable by the DSL. This keeps the data model
and evaluator bounded.

During trace parsing, the core collects field names and observed scalar types.
A referenced key with incompatible observed types is a compile error. Null or
absence produces a missing value.

Custom fields remain in the existing interned raw fragments until referenced.
On first compile that references a key, the worker decodes each distinct
fragment once and materializes a typed optional column for that key. Evaluation
never parses JSON.

Creator fields live under `field`; fields on the matching death event live
under `death.field`. The same catalog and decoder drive display and completion
so those surfaces cannot disagree about names or types.

## Compilation and execution

Apply is a configuration operation:

```text
source
  -> tokenize with byte spans
  -> parse
  -> type-check and resolve constants, tags, names, sites, and custom fields
  -> lower to a compact typed plan
  -> scan creator events once
  -> store one match bit per creator event
```

All consumers read that bitset:

- rendering performs one bit test;
- the Events panel maps creator and death events through the same bit;
- filter-scoped range tagging performs one bit test; and
- seeking and playback do no expression work.

The compiler folds constants, resolves string equality to interned ids where
possible, converts constant sets to bitsets or sorted values, orders cheap
short-circuit clauses before expensive string clauses when that preserves
semantics, and emits specialized column operations rather than boxed dynamic
values.

The evaluator has hard hot-path rules:

- no WASM/JavaScript boundary crossing per allocation;
- no allocation, string construction, hashing, virtual dispatch, or JSON
  parsing per allocation;
- no work proportional to stack depth unless the expression uses `stack`;
- no work for a custom field unless the expression references it; and
- no trace scan during rendering, seeking, typing, or completion.

One match bit costs about 125 KiB per million creator events. The compiled plan
and dependency list are cached with the source. A tag/name/custom-field change
rebuilds matches only when the plan declares that dependency.

### Performance gates

Benchmarks run in release WASM in a Chromium worker after one warm-up, and
report median and p95 over at least 20 Applies. Synthetic data must not make
every branch constant.

Before implementation is accepted:

- a built-in numeric predicate over 1 million creators must apply in at most
  25 ms median / 40 ms p95;
- the same predicate over 10 million creators must apply in at most
  250 ms median / 400 ms p95;
- a site/thread/tag predicate must stay within 1.5x of the numeric predicate;
- warm custom scalar predicates must stay within 2x;
- rendering and seeking must show no measurable regression beyond noise; and
- compilation of a 1 KiB source must complete in under 2 ms median, excluding
  the match scan.

Cold materialization of a referenced custom field is measured separately and
must remain linear in distinct interned fragments, not event count times
expression complexity. Stack substring predicates are also reported
separately; they may be slower, but must still allocate nothing per creator.

If these gates are missed, the first response is to simplify or specialize the
plan, not add caching layers to the UI.

## Editor

The Filter panel becomes one expression editor plus the existing dim/hide
mode. There are no Quick filters and no hidden conjunction with old controls.
A compact field picker may insert DSL text, but it does not maintain a second
filter representation.

Typing performs debounced tokenization, parsing, and checking only. Apply
performs the trace scan. The editor shows exactly one state:

```text
Empty
Valid
Invalid: expected expression after && at byte 24
Applied
Edited; applied filter is still active
```

Invalid edits never become “match everything.” The last successfully applied
filter remains active until valid source is applied or the editor is cleared
and Apply is pressed.

Completion is contextual and comes from the compiler's field/type catalog. It
covers built-ins, custom keys, valid members, observed site/thread/tag values,
and allocation names. It does not include snippets, fuzzy documentation
search, or a language server.

## Persistence and compatibility

The session stores the canonical source and a filter-language version in the
heap-state envelope. Compiled plans and match bits are never persisted.

The first implementation bumps the heap session version. Old structured
checkbox filter state is ignored with the rest of an unsupported old heap
section, following [ANL-008](../../spec/07-analysis.md#anl-008-the-session-blobs-shape).
There is no permanent legacy parser, dual evaluator, or old-state-to-AST
adapter.

Once version 1 source is persisted, its syntax and semantics are stable.
Future versions are additive where possible; a semantic break requires a new
language version and a direct diagnostic, never silent reinterpretation.

## Diagnostics

Every lexer, parser, resolver, and type error carries a byte span and one
specific message. Examples:

```text
unknown field `siz`; did you mean `size`?
`contains` is available on string and stack, not bytes
no allocation named "request root"
3 allocations are named "buffer"
field.refcount has mixed types: integer and string
4KiB cannot be compared with time
```

There is no recovery during Apply: one error means no new plan and no scan.
Recovery may be used internally to offer completion after an incomplete
expression, but recovered trees are never executable.

## Remaining work before a decision

The language shape no longer needs an implementation comparison.
[T010](../tickets/T010-standalone-filter-dsl-parser.md) established the
dependency-free parser, public source-spanned AST, syntax diagnostics, and
parser limits. The remaining useful evidence is:

1. turn the field table, missing-value rule, and performance gates above into
   type-checker/evaluator tests;
2. prototype the typed plan for numeric comparisons, boolean composition,
   sets, and ranges;
3. benchmark it over 1 million and 10 million creator rows in release WASM;
4. add intern-id equality for site/thread/tag and benchmark it;
5. prototype lazy custom-field materialization and measure cold and warm
   Apply separately; and
6. record any syntax that must change to hit the gates before version 1 is
   persisted.

No editor or filter-panel implementation should begin until the core prototype
meets the numeric and interned-id gates. The UI must not hide an evaluator that
is too slow.
