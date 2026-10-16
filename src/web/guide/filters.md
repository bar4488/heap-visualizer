# Find allocations

- Open [Filter](#show:filter-panel).
- Use [malloc.site == "request_buf" and not alloc.freed](#set:filter-source=malloc.site == "request_buf" and not alloc.freed).
- Press [Apply](#do:filter-apply).
- Choose **dim others** for context or **hide others** for only the matches.

This finds allocations created by `request_buf` that were never freed.

When the trace has calls and spans, filter by what was running:
["parse_body" in malloc.calls](#set:filter-source="parse_body" in malloc.calls)
finds allocations made while `parse_body` was on the allocating thread's
stack, and `"request" in malloc.spans` those made inside a `request` span.
`free.calls` and `free.spans` ask the same about the free. Without intervals
these are empty, so nothing matches.

From an Allocation window, **use as filter reference** inserts a stable
`allocation(id).` reference. Continue it with `alloc`, `malloc`, or `free`; for
example, `alloc.address >= allocation(100).alloc.end` finds allocations whose
base address follows allocation 100's range.
