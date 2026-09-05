# corrupted-telemetry

## Integrity audit — do not draw a leak conclusion

**Warnings:** 9 observed / 9 retained / 0 omitted; every kind occurred **once** (`GET /api/v1/warnings?from=0&count=100`):

| Warning kind | Warning sequence | Implication |
|---|---:|---|
| `unknown_version` | 0 (version `2`) | Producer format semantics are not fully known. |
| `malformed_line` | 1 | A record was skipped; it could have been an allocation or free. |
| `decreasing_time` | 2 | Time was clamped; temporal ordering/lifetimes are unreliable. |
| `sequence_mismatch` | 2 (declared `999`) | Producer sequence cannot be trusted for chronology. |
| `unknown_id` | 3 (ID `999999`) | A free cannot be matched to an allocation. |
| `double_free` | 5 (ID `1`) | Free history for ID 1 is malformed. |
| `duplicate_id` | 7 (ID `77`) | Allocation identity is ambiguous. |
| `overlap` | 8 (address `268438688` / `0x10000ca0`) | Live address ranges are not disjoint. |
| `invalid_size` | 9 (ID `79`) | Reported allocation size/geometry is invalid. |

### Allocation identity risks
- **ID 77 is reused:** creators **6** (`4096 B`, session `s-dup-a`) and **7** (`8192 B`, session `s-dup-b`) are both live records with the same ID.
- The free at warning sequence **3** targets nonexistent ID **999999**; it cannot establish any allocation’s death.
- The malformed skipped record and unknown format version may conceal or alter allocation/free identity.
- ID **1** has a recognized free at sequence **4**, but also a double-free warning at **5**; its lifecycle is malformed beyond the first recognized free.

### Geometry risks
- Creator **8** is `0x10000ca0–0x10000ea0` (512 B), which lies inside live creator **6**’s `0x10000c20–0x10001c20` (4096 B): the API explicitly reports the overlap at sequence **8**.
- Creator **9** was flagged invalid-size at sequence **9**; although normalized by the API to `1 B` / `0x10003c40–0x10003c41`, its original size geometry is not trustworthy.
- The skipped malformed record may also hide range changes; thus live-byte/peak geometry should not be treated as physical heap occupancy.

### Safe conclusions
- This capture is integrity-compromised: **all 9 warning categories are present**.
- The API currently marks **5 records** as live at end, totaling **14,849 requested bytes** (`POST /api/v1/allocations/summarize`, filter `not alloc.freed`).
- One recognized record, creator **1** (1024 B), was freed at sequence **4**.
- The recorded live set consists of creators **2, 6, 7, 8, 9** (`POST /api/v1/allocations/query`, unfiltered, `creator-asc`).

### Withhold pending clean recapture
- Any claim that the five live records or **14,849 B** constitute a leak.
- Leak totals, site attribution (including the apparent `session_state` 12,288 B), owner identity, lifetime analysis, allocation chronology, and peak/live physical-memory geometry.
- Any conclusion based on ID 77 as a unique allocation or on creator 8/9’s address/size geometry.

**Additional endpoint evidence:** `GET /api/v1/overview?top=10` reported 6 allocations, 3 frees, 5 live records, and the same 14,849-B end total; `POST /api/v1/stream/context` over sequence `[0,11)` and per-creator allocation detail endpoints established the affected creators and ranges.
