# uaf-callback-hijack

## Verdict: security-relevant UAF (CFI-blocked)

Handle `h-77` retained a stale reference to a freed `extension_state` object and later performed an indirect call through attacker-controlled replacement data. This is not a benign stale callback.

### Victim lifetime and reuse chain (`0x18000000`, 256 bytes)

| Sequence | Time | Creator / event | Generation | Site / result |
|---:|---:|---|---:|---|
| 1201 | 1202 | alloc ID 601 | 41 | `extension_state`; expected callback `0x401280`, object `ext-19`, owner `extension-manager` |
| 1202 | 1203 | custom event | 41 | queued async dispatch: `handle=h-77 ptr=0x18000000 generation=41` |
| 1443 | 1444 | free ID 601 | 41 | freed due to `extension-unload` |
| 1444 | 1454 | alloc ID 722 | 42 | `thumbnail_job`, first qword `0x402100`, source `background`; freed at 1445 |
| 1446 | 1454 | alloc ID 723 | 43 | `metrics_packet`, first qword `0x403300`, source `internal`; freed at 1447 |
| 1448 | 1454 | alloc ID 724 | 44 | live `request_body_chunk`, network-controlled, first qword `0x7fff41414141` |
| 1449 | 1454 | CFI trap | expected 41 / observed 44 | stale indirect call for `h-77` at the same address |

**Trap occupant:** allocation 724, `request_body_chunk`, generation **44**, remains live; it occupies precisely `0x18000000–0x18000100`.

**Attacker control and target:** allocation 724’s creator fields explicitly report `controlled=true`, `source=network`, `request=atk-552`, `route=/extensions/render`, and `firstQword=0x7fff41414141`. The trap explicitly records the attempted callback target as **`0x7fff41414141`**. The original expected callback was `0x401280`.

### Why this is causal, not benign reuse

- The queue record binds `h-77` to pointer `0x18000000` at generation **41**; ID 601 is then freed before dispatch.
- The CFI record directly names the same handle and pointer, with **expected generation 41** and **observed generation 44**.
- Intermediate IDs 722/723 are allocator reuse only: their generations (42/43), sites (`thumbnail_job`/`metrics_packet`), sources, and lifetimes do not appear in the stale-dispatch record. They establish the same-address reuse chain but are not the triggering occupant.
- Timestamp ordering alone is insufficient: sequences **1444–1449 all share time 1454**. Sequence order proves alloc/free/alloc/free/controlled alloc/trap ordering, while the generation mismatch proves identity replacement.

### API evidence used

- `GET /api/v1/allocations/1201?traceId=…` — victim creator/death fields and sequences.
- `GET /api/v1/allocations/{1444,1446,1448}?traceId=…` — exact same-address generations, sites, lifetimes, and controlled network fields.
- `POST /api/v1/stream/context`, filter `alloc.address == 0x18000000`, centers **1201**, **1443**, **1449** — queue binding and exact CFI-trap text.
- `POST /api/v1/allocations/query`, filter `alloc.address == 0x18000000` — exactly **4** allocations / **1024 bytes** in this address cohort.
- `POST /api/v1/allocations/query`, filter `malloc.fields.controlled == true` — exactly **1** controlled allocation, creator **1448**.

**Impact:** a stale handle reaches a network-controlled replacement object and attempts an indirect call to attacker-controlled value `0x7fff41414141`; CFI prevented execution, but the trace demonstrates an exploitable-class UAF/control-flow-hijack attempt.
