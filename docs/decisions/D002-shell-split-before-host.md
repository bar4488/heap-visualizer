---
id: D002
title: The shell/domain split comes first; the host is designed against a real second domain
updated: 2026-07-25
---

# D002: The Shell/Domain Split Comes First, the Host Comes Last

## Decision

`web/` is being taken to a domain-independent shell hosting several analysis
domains, heap being the first. The order is fixed: separate shell code from
domain code, declare the seam, type it, and build the host **only** once a
second domain is concrete — named, with a known data source, known views, and
someone ready to build it. The host is built alongside that domain, not before
it.

Two constraints follow and are honored in every stage:

- **The shell never names a domain concept.** No heap type, no `.heapa`
  knowledge, no `'events-panel'` string in `web/shell/`. Checkable:
  `grep -ric heap web/shell/` reports 0 for every file.
- **Persisted domain state is namespaced and versioned** — cheap with one
  writer, a migration nobody wants to write later. This is
  T001.

## Why

An earlier proposal argued for building the host immediately. Its destination
was right; its ordering was not, for four reasons argued in full in
[E007 §2](../explorations/E007-web-architecture-direction.md):

1. Every extension point in a host is a guess about what its consumers need.
   Designed against heap alone, the API encodes heap's accidents and gets paid
   for twice.
2. The split is required either way and is the larger share of the work.
3. The web layer's verification is thin. A host built at the same time as the
   split is an order of magnitude more change on the same base.
4. The host's shape depends on decisions not yet made — chiefly whether several
   documents are open at once, which is a large user-facing feature in its own
   right.

Naming is deliberately *not* constrained. Heap concepts keep heap names; nothing
is renamed to a generic term to look reusable before a second implementation
exists to share the name.

## What would reverse it

A second domain becoming concrete moves T004
from blocked to startable. That is the trigger this decision exists to wait for,
not a reversal of it. An actual reversal would be evidence that the seam drawn
in `web/shell/` is wrong — most likely a panel that cannot be expressed as a
declared record in T002.
