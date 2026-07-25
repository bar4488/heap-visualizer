---
id: T014
title: Tag every allocation the filter matches
status: todo
updated: 2026-07-25
---

# T014: Tag Every Allocation the Filter Matches

## Outcome

One action in the Filter panel assigns a tag to every allocation the applied
filter currently matches. The result is an ordinary tag — a snapshot, not a
live query.

## Context

The core holds the applied filter's creator match bitset in
`a.cfg.filter.matches` (`src/core/src/lib.rs`, `hp_filter_apply`), and
`hp_tag_seq_range` already scopes range tagging to it. Tagging every match
needs one more export in the same shape, a worker command beside `tag-range`
in `src/web/protocol.ts`, and a button.
[ANL-002](../../spec/07-analysis.md#anl-002-acquiring-tags) owns how tags are
acquired; [E013](../explorations/E013-filter-actions.md) records why a snapshot
and not a live tag.

## Done when

- [ ] A core export tags every creator in the match set and returns the count,
  covered by a `cargo test` that applies a filter and asserts exactly the
  matching creators carry the tag.
- [ ] With no filter applied, the export tags nothing rather than everything.
- [ ] The action names the tag, reusing an existing tag of that name; the tag
  list, legend and counts refresh, and marks become dirty.
- [ ] The status line reports how many allocations were tagged.
- [ ] ANL-002 lists filter-to-tag as a way tags are acquired.

## Non-goals

- A tag whose membership re-evaluates.
- Scoping the snapshot to a selection or crop — range tagging already composes
  with the filter.
- Raising the 255-tag ceiling.
