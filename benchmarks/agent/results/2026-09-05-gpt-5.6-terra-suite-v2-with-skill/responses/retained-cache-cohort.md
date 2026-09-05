# retained-cache-cohort

## Retained cohort

- **Unintended cohort:** `cache_insert` compiled-policy cache entries (not the three `runtime_singleton`s).
- **Retained:** **18 allocations**, **1,253,376 requested bytes**.
- **Earliest creator:** event **3205** (time **3206**): 65,536-byte `cache_insert` on thread 0.

## Distinguishing producer attributes

All 18 match:

```text
malloc.site == "cache_insert"
and malloc.fields.entryKind == "compiled-policy"
and malloc.fields.generation == 17
and malloc.fields.region == "eu-west"
and not alloc.freed
```

They contrast with normal serving traffic, which uses `phase == "serving"` and `class == "hot"`; that filter matched **781 allocations, all freed**.

## Evidence

- `POST /api/v1/allocations/summarize` with `not alloc.freed`, grouped by site: `cache_insert` = 18 / 1,253,376 bytes; `runtime_singleton` = 3 / 12,288 bytes.
- The focused attribute filter above summarized to exactly 18 live `cache_insert` allocations / 1,253,376 bytes.
- `GET /api/v1/allocations/3205`: confirms the earliest entry’s attributes and no death event.
- `POST /api/v1/allocations/query` for `runtime_singleton`: confirms exactly three intended live 4,096-byte allocations.
