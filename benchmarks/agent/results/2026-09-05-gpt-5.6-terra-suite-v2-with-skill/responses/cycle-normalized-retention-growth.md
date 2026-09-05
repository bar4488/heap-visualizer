# cycle-normalized-retention-growth

## Retention result

Cycle field values are `0`–`7`. Live-at-end retained contribution:

| Cycle | Filter result | Retained | Cumulative live |
|---:|---|---:|---:|
| 0 | 4 allocations | 65,536 B | 65,536 B |
| 1 | 4 allocations | 65,536 B | 131,072 B |
| 2 | 4 allocations | 65,536 B | 196,608 B |
| 3 | 4 allocations | 65,536 B | 262,144 B |
| 4 | 4 allocations | 65,536 B | 327,680 B |
| 5 | 17 allocations | 491,520 B | 819,200 B |
| 6 | 4 allocations | 65,536 B | 884,736 B |
| 7 | 4 allocations | 65,536 B | 950,272 B |

**Violation:** cycle **5** (the sixth completed cycle) is the first and only violation. It retains 17 allocations rather than four.

- **Baseline:** 4 × 16 KiB = **65,536 B/cycle**; across eight cycles, **524,288 B**.
- **Excess:** **425,984 B** = 13 × 32 KiB retry-shadow allocations.
- **Endpoint live total:** **950,272 B** = baseline + excess.

**Producer condition:** the excess allocations match:

```text
not alloc.freed and malloc.fields.cycle == 5
and malloc.fields.owner == "payments"
and malloc.fields.upstream == "ledger"
and malloc.fields.status == 503
and malloc.fields.retryPolicy == "unbounded"
```

This returned **13 live `request_state` allocations / 425,984 B**. Representative creator **1421** has `kind: retry-shadow`, `owner: payments`, `upstream: ledger`, `status: 503`, and `retryPolicy: unbounded`.

## Cumulative vs. incremental

The “Cumulative live” column is the retained heap accumulated from all prior cycles. Per-cycle net growth is the retained contribution column: **65,536 B** for every normal cycle and **491,520 B** in cycle 5. Thus cycle 5’s incremental excess is **425,984 B**, not the final 950,272 B.

## Evidence and distractor exclusion

For each row, I used:

```text
POST /api/v1/allocations/summarize
source: not alloc.freed and malloc.fields.cycle == 0   # then 1 … 7
groupBy: site
```

All normal-cycle matches were four live `request_state` allocations totaling 65,536 B; cycle 5 matched 17 totaling 491,520 B.

Large JIT activity is not retained: filter `malloc.site == "jit_scratch"` returned **48 allocations, 100,663,296 B, all freed**; `not alloc.freed and malloc.site == "jit_scratch"` returned **zero**. The overview’s **107,076,096 B** total allocation and **14,292,480 B** peak therefore emphasize transient JIT bursts, whereas the endpoint-retention fault is the `request_state` retry-shadow cohort.
