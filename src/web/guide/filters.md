# Find allocations

- Open [Filter](#show:filter-panel).
- Use [malloc.site == "request_buf" and not alloc.freed](#set:filter-source=malloc.site == "request_buf" and not alloc.freed).
- Press [Apply](#do:filter-apply).
- Choose **dim others** for context or **hide others** for only the matches.

This finds allocations created by `request_buf` that were never freed.

From an Allocation window, **use as filter reference** inserts a stable
`allocation(id).` reference. Continue it with `alloc`, `malloc`, or `free`; for
example, `alloc.address >= allocation(100).alloc.end` finds allocations whose
base address follows allocation 100's range.
