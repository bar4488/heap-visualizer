---
id: D001
title: Web changes are verified by a human smoke checklist, not browser automation
updated: 2026-07-25
---

# D001: Web Changes Are Verified by a Human Smoke Checklist

## Decision

Rendering, pointer interaction, and the real worker round trip are verified by a
person running [docs/smoke-checklist.md](../smoke-checklist.md) against the demo
trace. An agent does not drive a browser to check them, and does not report a
web change as verified on the strength of unit tests alone.

What an agent can verify by itself: `cargo test`, `node --test
'web/**/*.test.js'`, and `./build.sh`. Everything else it hands back with the
checklist steps that need running.

## Why

The parts of this app that break are the parts automation covers worst: pixels
on a canvas, drag gestures across three coordinate systems, and drawer geometry.
A browser-automation harness for those is a large standing cost that would have
caught approximately none of the 17 findings in
[E002](../explorations/E002-review-2026-07-24.md), and would produce a false
green on the ones it did not cover.

Bar smoke-tests the app in the course of using it. Writing the sequence down
turned that into something repeatable — a regression shows up in a consistent
place — at the cost of one file.

## What would reverse it

A second domain in the shell (see [T004](../tickets/T004-shell-host.md)) makes
the checklist grow per domain, and the manual cost then scales with something
that is meant to scale. That is when to price a real harness.
