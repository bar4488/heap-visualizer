---
id: D001
title: Web changes are verified by hand, not browser automation
updated: 2026-07-25
---

# D001: Web Changes Are Verified by Hand

## Decision

Rendering, pointer interaction, and the real worker round trip are verified by
a person, against the demo trace. An agent does not drive a browser to check
them, and does not report a web change as verified on the strength of unit
tests alone.

What an agent can verify by itself: `cargo test`, `node --test
'web/**/*.test.js'`, and `./build.sh`. Everything else it hands back as a
plain-language list of what the change touches, for a person to check.

There is no fixed, written script for this. An earlier version of this
decision added one (`docs/smoke-checklist.md`, numbered steps, run before each
refactor slice); it went unused — Bar verifies by using the app, not by running
a script — so it was dropped as a file that cost upkeep without being the thing
that actually happened. See [T006](../tickets/T006-drop-fixed-smoke-checklist.md).

## Why

The parts of this app that break are the parts automation covers worst: pixels
on a canvas, drag gestures across three coordinate systems, and drawer geometry.
A browser-automation harness for those is a large standing cost that would have
caught approximately none of the 17 findings in
[E002](../explorations/E002-review-2026-07-24.md), and would produce a false
green on the ones it did not cover.

## What would reverse it

A second domain in the shell (see [T004](../tickets/T004-shell-host.md)) makes
hand-verification grow per domain, and the manual cost then scales with
something that is meant to scale. That is when to price a real harness — and,
short of that, when a written script earns its cost back.
