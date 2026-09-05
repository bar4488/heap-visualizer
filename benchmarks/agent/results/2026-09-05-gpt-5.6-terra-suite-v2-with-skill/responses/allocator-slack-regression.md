# allocator-slack-regression

## Allocator-slack report

`small_header` is the **known absolute-slack leader**, despite ranking last in requested bytes.

| Measured site | Allocations | Requested bytes | Usable bytes | Absolute slack | Usable / requested | Known-usable denominator |
|---|---:|---:|---:|---:|---:|---:|
| aligned_vector | 100 | 409,600 | 411,200 | 1,600 | 1.00390625× | 100 allocs / 409,600 requested bytes |
| opaque_cache | 500 | 256,000 | unknown | unknown | unknown | 0 allocs / 0 requested bytes |
| payload_fragment | 800 | 153,600 | 166,400 | 12,800 | 1.08333333× | 800 allocs / 153,600 requested bytes |
| small_header | 2,000 | 66,000 | 256,000 | **190,000** | **3.87878788×** | 2,000 allocs / 66,000 requested bytes |

Known-usable aggregate: **2,900 allocations**, **629,200 requested bytes**, **833,600 usable bytes**, and **204,400 bytes slack** (1.324…× amplification).

`opaque_cache` has no usable-size measurements for any of its 500 allocations. Therefore its usable total, slack, and amplification—and thus a fully global slack ranking—cannot be determined. `small_header` is the leader **among sites with measured usable sizes**.

Requested-byte ranking misdiagnoses this: `aligned_vector` leads requested bytes (409,600), yet adds only 1,600 slack; `small_header` requests only 66,000 bytes but contributes 190,000 measured slack due to 128-byte usable allocations for 33-byte requests.

This is **not a leak**: the overview reports `liveAtEnd.count = 0` and `liveAtEnd.bytes = 0`. Leak analysis therefore finds no survivor, but misses transient allocator rounding/slack accumulated during the workload (and cannot quantify `opaque_cache` without usable measurements).

**API evidence:** `GET /api/v1/overview?top=10` (all four sites, `topSitesOmitted: 0`, zero live-at-end); `POST /api/v1/allocations/query` with filters `malloc.site == "<site>"` for each table row. Each query’s `matched` aggregate supplied allocation count, requested bytes, usable bytes, and `usableKnownAllocations`.
