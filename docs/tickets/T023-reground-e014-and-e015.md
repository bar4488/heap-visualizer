---
id: T023
title: E014 and E015 describe what shipped
status: done
updated: 2026-07-31
---

# T023: E014 and E015 Describe What Shipped

## Context

Both explorations are `status: open`, so both are live material an agent may
read as current. E014 is not current.

E014 was written on 2026-07-25 against `T015`'s overlapping memberships, before
`T016` changed the language. It still describes the scalar field:

- `:134` — "the expression evaluator exposes `tag` as an optional string"
- `:184` — "`tag` remains typed as `missing string`"
- `:187` — "`tag == \"a\"` — true if any membership equals `a`"

T016 deleted all three: the field is the set-typed `tags`, `==` is exact set
equality, `contains` is membership, and `Value::Strings` with its equality and
ordering overloads is gone. E014's open question "should ordering operators be
rejected for `tag` now that it is a set-valued field" is therefore answered,
and its cost table row for evaluating `tag` measures a code path that no longer
exists.

E015's own Outcome already says the surface question is settled and the rest is
answerable only from use. That reading is correct and its remaining questions
are real, so it stays open — but it cites the guide prototype by an identifier
that `T020` renumbers, and it was written before the third pass that added the
scenario traces and the scroll-pinning rule.

## Outcome

E014 is settled, with an Outcome that says what T016 answered and what was
declined. E015 is open and every claim in it is true of the code as it is.

## Done when

- [x] E014 carries a dated correction for the three stale claims above rather
      than silent edits, its status is `settled`, and its Outcome says which
      questions T016 answered and that no optimization was selected.
- [x] No question remains in E014's Questions section that T016 already
      answered; each is either struck with its answer or moved to the Outcome.
- [x] E015 stays `open`, its `updated` is current, its ticket citation resolves
      after T020, and its Outcome's "still open" list matches what the shipped
      prototype leaves unanswered.
- [x] The three stale claims are still present in the body, unedited. That is
      the point: `PROTOCOL.md` says a wrong claim in a dated record gets a
      correction appended, not an edit. `rg -n 'tag ==|missing string|optional
      string' docs/explorations/E014-*.md` therefore returns five lines — three
      original, two inside the correction quoting them — and a reader who lands
      on any of the three has the correction below it in the same file.
- [x] `docs/now.md`'s sentences about E014 and E015 agree with the two files.

## Non-goals

- Acting on anything E014 proposes. No benchmark, no optimization, no DSL
  change, no UI ticket. Settling it records that the choice was not made.
- Answering E015's open questions. They are answerable from use, and using it
  is not this ticket.
- Any change to `src/`.

## Result

**E014 is `settled`.** A `## Correction, 2026-07-31` section names the three
claims T016 falsified — the "optional string" typing, the `missing string`
line, and the whole per-membership behavior table — with the current
`filter_eval.rs` lines that replace them, and states that the cost row for
evaluating `tag` measures a code path that no longer exists and has not been
re-measured. The original claims are left standing above it, unedited. The
Outcome records that nothing was selected and says what re-opening would take:
a ticket with a reproduction, not an edit to this file. The one open question
T016 answered is struck through with its answer.

The engine-side analysis — the `O(N * H)` refresh and rebuild passes, the
rendering allocation, counts-are-memberships, one-body-color, the comma-name
ambiguity — was checked to be language-independent and left as written. It
stands unmeasured, and the Outcome says so.

**E015 stays `open`, deliberately.** Its remaining questions are answerable only
from use, which is the state the bespoke-drawer choice was made to reach. Added
a `## Where it stands, 2026-07-31` section re-grounded against the code — five
sections, five traces, the three verbs unchanged, the two constraints that came
out of use (`#show:` opening a closed panel through its real toggle, and no
action moving the reader's place), and that nothing persists. The "still open"
list is now four named questions rather than a sentence.

`docs/now.md`'s paragraphs on both files were rewritten to agree with them.
No file under `src/` was touched.
