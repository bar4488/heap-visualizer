# 5. Filter the trace

Open [Filter](#show:filter-panel), set
[malloc.site == "read_buffer" and not alloc.freed](#set:filter-source=malloc.site == "read_buffer" and not alloc.freed),
then press [Apply](#do:filter-apply).

The expression runs over allocations in the complete trace. `alloc` describes
the allocation, `malloc` its creator record, and `free` its terminating record.
Here it finds buffers from one call site that were never freed.

Use **dim others** to keep context or **hide others** to isolate matches. Editing
checks a draft; Apply makes it active.
