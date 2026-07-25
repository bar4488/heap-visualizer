---
id: D003
title: One finding or one refactor slice per commit, smoke-tested before the next
updated: 2026-07-25
---

# D003: One Finding or One Refactor Slice per Commit

## Decision

A commit carries one finding's fix, or one refactor slice, and nothing else. The
smoke checklist ([D001](D001-web-changes-are-hand-smoke-tested.md)) runs before
the next slice starts. If a slice turns out to need more than a lift-and-shift,
it stops and splits rather than reaching for a redesign mid-move.

## Why

Two recorded instances:

- The 2026-07-24 review's F10 — splitting `main.js` — was correctly judged too
  risky as a single six-module pass and deferred; the whole review is
  [E005](../explorations/E005-web-structure.md). Re-cut as one slice per commit,
  it landed. Sixteen fixes from that review went in one commit each
  (`git log 41f4e37..a18c1ce`), and each was individually revertable.
- The web layer has no automated coverage of rendering or pointer interaction.
  When a regression appears, the only cheap localization is the commit boundary.
  A commit mixing two changes destroys that, and hand-verification is too
  expensive to re-run per hunk.

## What would reverse it

Automated coverage good enough to localize a regression without bisecting — the
same condition that would reverse D001.
