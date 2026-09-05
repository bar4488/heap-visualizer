# dual-leak-ranking-and-tagging

## Post-deploy regression

- **Bytes leader:** `compressed_blob` — **9 live allocations, 4,718,592 bytes**.  
  Ownership: build `2026.09.5`, owner `artifact-cache`, ticket `HV-217`.

- **Count leader:** `index_node` — **420 live allocations, 161,280 bytes**.  
  Ownership: build `2026.09.5`, owner `search-index`, ticket `HV-231`.

A byte-only ranking obscures the 420-allocation `index_node` leak; a count-only ranking understates the 4.7 MB retained by `compressed_blob`.

**Old-build exclusion:** build `2026.08.9` `compressed_blob` traffic (owner `artifact-cache`, ticket `HV-190`) was excluded: **7 allocations / 3,670,016 bytes**, all freed (`liveAtEnd: 0`).

## Tag result

Created `post-deploy-regression` and atomically tagged the two current-build cohorts using the combined live/build/site/owner/ticket filter.

- Tagged members: **429**
- Bulk mutation: `matched: 429`, `changed: 429`, `snapshotRequired: true`
- Analysis revision: tag creation **0 → 1**; bulk application **1 → 2**

**API evidence:** `POST /api/v1/allocations/summarize` with the two exact cohort filters and old-build filter; `POST /api/v1/filter/check`; `POST /api/v1/analysis/changes`; `POST /api/v1/analysis/tag-query`; final tag summary via `POST /api/v1/allocations/summarize` with `"post-deploy-regression" in alloc.tags`.
