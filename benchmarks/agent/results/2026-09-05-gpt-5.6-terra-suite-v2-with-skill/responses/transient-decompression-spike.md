# transient-decompression-spike

## Incident report

- **Responsible operation:** `snapshot import` / `decompress_chunk`.
- **Window:** operation begins at **seq 1002, time 1003 ns**; decompression allocations occur **seq 1003–1098 at 1103 ns**, reach peak after event **1099**, then free **seq 1100–1195 at 1603 ns**; operation completes **seq 1196, time 1604 ns**.
- **Dominant cohort:** **96** `decompress_chunk` allocations totaling **87,949,312 bytes**.
- **Global peak live memory:** **87,957,504 bytes** at **time 1103 ns** (after **1,099** events). The cohort accounts for all but the resident **8,192-byte** singleton.
- **Retention:** **Transient.** All 96 cohort allocations were freed (each lifetime **500 ns**); none remained at process end. End-of-process live memory was only **1 allocation / 8,192 bytes** (`runtime_singleton`).

**Evidence / API filters**
- `GET /api/v1/overview?top=10`: global peak, end-live total, and `decompress_chunk` aggregate.
- `POST /api/v1/allocations/summarize`, filter `malloc.site == "decompress_chunk"`, group `freed`: **96 freed / 87,949,312 bytes**.
- `POST /api/v1/allocations/query`, same filter, `creator-asc`: births **1003–1098 / 1103 ns** and deaths **1100–1195 / 1603 ns**.
- `POST /api/v1/stream/context`, same filter: landmark events identify “snapshot import begins” and “snapshot import complete.”
- End-live summary with `not alloc.freed`: only `runtime_singleton`, **8,192 bytes**.

A live-at-end ranking misses the incident because it excludes every allocation in the 87.95 MB cohort—they were all freed before shutdown—thereby reporting only the small singleton rather than the transient peak.
