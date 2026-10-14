---
id: D013
title: Built-in domains get op letters; user kinds ride on E
created: 2026-10-09
---

# D013: Hybrid Record Types

## Decision

The trace format extends in two ways, each with its own job:

1. **Built-in domains get their own `op` letter.** A domain the core
   implements (heap, logs, intervals) and that is high-volume or needs its own
   validation gets a single-letter record type, as `L` did for logs. The core
   dispatches on the letter and validates the record by rules specific to that
   letter.
2. **User-defined kinds use `E` with a `kind` field.** A producer adds its own
   evidence (GC phases, cache misses, frame markers) without a core release by
   writing `{"op":"E","kind":"gc",…}`. The header may declare a kind with a
   schema: `"kinds": {"gc": {"shape": "interval", "track": "thr", "title":
   "phase", "fields": {…}}}`. An **undeclared** kind is a point landmark whose
   fields are catalogued per kind. An `E` **without** `kind` stays exactly the
   plain landmark of TRACE-010.

Letters assigned or reserved by this decision:

| Letter | Record | Domain |
|--------|--------|--------|
| `H` | header | — (not on the spine) |
| `M` `F` `R` | malloc, free, realloc | heap (first domain) |
| `E` | landmark, or user kind via `kind` | user kinds |
| `L` | log line | logs (second domain) |
| `B` `X` | interval begin, end (calls, spans) | intervals (next domain) |
| `C` | context switch on a CPU | intervals (scheduler slices) |
| `T` | process/thread metadata | — (not on the spine) |
| `S` | reserved for sampled profiles | not yet specified |

The rules for adding a letter:

- It must belong to a domain implemented in the core, with its own store
  ([DOM-002](../../spec/13-domains-and-logs.md#dom-002-domains-own-their-payloads)).
  A record shape that only one producer emits is a kind, not a letter.
- Letters are permanent and never reassigned. Old readers skip unknown
  letters (TRACE-002), which is what makes a new letter safe to add.
- Uppercase letters only. Lowercase letters are left free for a later
  revision.

The proposed wire format that applies this decision is
[E023](../explorations/E023-trace-format-v2.md).

## Why

**Dispatch and validation.** The parser reads `op` first and selects the
domain's reader from one byte. Built-in records carry required fields and
rules (`L` needs a string `msg`; `X` must pair with an open `B`; `C` needs a
`cpu`). A letter makes those rules a property of the record type. A string
`kind` would put them behind a string comparison and a table lookup on every
line, and make them depend on a value producers can misspell.

**Volume.** Function enter/exit is the highest-volume evidence the product
plans to carry, at tens of millions of records per trace. `{"op":"B",…}` is
the shortest form, and each extra byte per record adds to load time and file
size at that volume.

**Extensibility without a release.** Producers will always have evidence the
core has no domain for. `E.kind` with an optional header schema lets them type
it, title it, place it on a track, and give it interval shape. The core needs
no changes, and an old reader still sees a landmark.

**`L` already exists.** Logs shipped as a letter. Re-expressing them as
`E.kind:"log"` would make two encodings for one domain, or break traces that
are already written.

## Rejected

**Everything via `E.kind`** (E022's sketch). The main argument for it is
backward compatibility: a v1 reader shows every new record as a landmark
instead of dropping it. That only holds for low-volume evidence, though. A v1
viewer showing ten million call records as landmarks is no more useful than
one that drops them. The approach also costs every record a kind string and a
lookup, puts built-in validation behind string values, and makes the shipped
`L` a special case.

**Letters only.** Every new kind of evidence would need a core release and a
permanent letter. The letter space is small (26 uppercase letters, nine already
used or reserved here), and one producer's GC phases do not justify spending
one of them. Producers would fall back to plain `E` landmarks with untyped
fields. Those landmarks can't be titled, typed, laid out on a track, or shaped
as intervals.
