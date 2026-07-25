---
id: D001
title: Verification is proportionate — an agent runs every cheap check and builds no browser harness
updated: 2026-07-25
---

# D001: Verification Is Proportionate

*(The filename slug predates the 2026-07-25 amendment below and is left alone;
the id is what is permanent.)*

## Decision

Two halves, and the earlier version of this decision only had the second.

**An agent runs every check available to it that is cheap, and reports what it
found.** Cheap means: no browser driver, no new dependency, no standing harness
to maintain, and seconds to run. It does not hand a check back to a person
because the check is about the web layer. If there is a way to establish
something without a browser, that is the agent's job, not Bar's.

**An agent does not drive a browser, and does not build one to drive.** No
Playwright, no headless boot harness, no click-by-click walkthrough performed
by an agent against a real page. That end stays out — it is slow, unrepeatable,
and its result cannot be checked by anyone else.

**A person's look is not a gate on every change.** Bar verifies by using the
app. That happens on his schedule, not as a done-when item that parks a
finished ticket at `doing`. A ticket closes when its own done-when items are
verified; if a change has a risk only a person's eye can retire, the ticket
says so in a sentence and closes anyway, with the risk named in `docs/now.md`
where the next session will see it.

### What is cheap, today

```sh
cargo test --manifest-path src/core/Cargo.toml   # the engine
node --test 'src/web/**/*.test.ts'               # the pure functions, both round-trips
npx tsc -p tsconfig.test.json                    # the protocol and the persisted shapes
./build.sh web                                   # refuses to emit if the types do not check
./serve.py                                       # then curl the entry points for 200
```

And the one this decision was amended over, which is worth naming because it is
not obvious and it is nearly free:

**Diff the emitted `dist/` from before the change against the one from after.**
For any change that is supposed to preserve behavior — a translation, a rename,
a config change — an identical emit is strong evidence that it did, and a diff
that is *not* identical is exactly the list of things to look at. Copy `dist/`
aside, rebuild, `diff -r`.

**HTTP 200 is evidence a file exists, not evidence the page works** — that
boundary, from [E009](../explorations/E009-the-hand-verification-bottleneck.md),
still holds. Say what a check covers, not what it suggests.

## Why

The original decision was right about browsers and wrong about the gap it left.
It said what an agent may not do, listed what an agent can run, and made
everything else a person's — which quietly put *cheap* checks and *expensive*
ones on the same side of the line. The result was finished, committed,
all-green work sitting at `doing` waiting for a person, four tickets at a time
([E009](../explorations/E009-the-hand-verification-bottleneck.md)), and an
agent writing smoke checklists in prose instead of establishing what it could
have established directly.

The cost being avoided is a standing harness, not a `diff`. Those are different
numbers and the decision now separates them.

The part that has not changed: the parts of this app that break are the parts
automation covers worst — pixels on a canvas, drag gestures across three
coordinate systems, drawer geometry. A browser harness for those would have
caught approximately none of the 17 findings in
[E002](../explorations/E002-review-2026-07-24.md), and would produce a false
green on the ones it did not cover.

**This amendment changes who runs the checks that already exist. It does not
reverse [E009](../explorations/E009-the-hand-verification-bottleneck.md)'s
outcome**, which settled that no new tooling gets built — not the module-graph
check, not a boot harness — until something actually breaks. "Cheap" above
means cheap *to run*, using what is already here. Writing forty new lines of
harness is a thing to be asked for, not assumed.

## What would reverse it

If closing tickets without a person's pass produces a regression that reaches
Bar through the app rather than through a test, that is the first recorded
instance, and E009 is where the case for building something restarts — as
evidence next time, not inference.

A second domain in the shell ([T004](../tickets/T004-shell-host.md)) still
makes a person's verification scale with domain count, which is the other
condition worth watching.
