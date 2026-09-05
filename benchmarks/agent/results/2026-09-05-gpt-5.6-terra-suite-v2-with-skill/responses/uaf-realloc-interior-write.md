# uaf-realloc-interior-write

## Privilege-boundary trap — confirmed use-after-realloc

- **Bug class:** use-after-realloc with harmful address reuse; **not** an out-of-bounds write on the current packet.
- Original `session_packet` (creator **1001**, id 501) was `0x19000000–0x19000200` (**512 B**), created at seq/time **1001/1002**. It died at realloc event **1003/1004** and has `reallocatedTo: 1003`.
- Realloc allocation (creator **1003**, id 502) has `reallocatedFrom: 1001`, moved to `0x10056fe0–0x10057fe0` (**4096 B**). The retained pointer was `0x19000080 = 0x19000000 + 128`; the new packet’s corresponding offset would be `0x10057060`, not the stale address.
- At write event **1005** (time **1024**), `0x19000080` belonged to the new `authorization_record` (creator **1004**, id 503), at `0x19000000–0x19000200`. Its `roleOffset` is **128**, so the stale pointer targets its `role` field exactly.
- Same-time ordering is decisive: authorization record allocation is seq **1004**, time **1024**; stale write is seq **1005**, time **1024**. Sequence order makes the authorization object the owner before the write.
- Semantic overwrite: `role` changed from **guest** to **admin** for principal `guest`, request `login-991`; event 1005 reports `result=privilege-escalation`. This is a remotely reachable authorization/privilege-escalation impact, not harmless reuse.
- Later frees cannot prevent it: the authorization record is freed at **1006/1025** (`request-aborted`) and the moved session packet at **1007/1026** (`session-close`), both after the corrupting write.

**API evidence:** `POST /api/v1/stream/context` centered at 1005 (filter `alloc.size >= 0`); allocation details `GET /api/v1/allocations/1001`, `/1003`, `/1004`; allocation queries using validated filter `malloc.fields.session == "sess-204"` and `malloc.fields.request == "login-991"`.
