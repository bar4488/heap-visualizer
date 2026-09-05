# stale-handle-generation-guard

## Verdict: not exploitable / no executed UAF

- **Stale handle:** `poll-18`, pointer `0x1a000000`, saved generation **12**.
- **Victim:** allocation **451** (creator seq **900**), `websocket_peer`, **192 bytes**, lifetime seq **900–902** / time **901–903 ns**; freed for `peer-disconnect`.
- **Reuse occupant:** allocation **452** (creator seq **903**) immediately reused the same **192-byte** range `0x1a000000–0x1a0000c0`; `admin_command`, generation **13**, callback value **`0x7fff42424242`**.
- **Generation check at event 904:** expected **12**, observed **13**. The record states `action=drop dereference=false`.
- **Dereference decision:** no callback or object dereference occurred after the victim free. The suspicious replacement callback value was present in the reused object but was not dispatched; address reuse alone did not create impact.

**Security property held:** the handle’s generation validation prevented stale-handle confusion and callback dispatch to the replacement object. The trace does not establish a post-free dereference or security impact.

**Contrary evidence required to call this an executed UAF:** an event/API record showing an actual dereference or callback invocation through `poll-18` after seq 902—e.g. `dereference=true` and an access/dispatch using the stale generation-12 handle, especially absent/after a failed generation validation.

**API evidence:**  
`GET /api/v1/allocations/900`, `GET /api/v1/allocations/903`; `POST /api/v1/stream/context` centered at **904** with filter `malloc.fields.callback is not None`; allocation query filter `malloc.seq >= 890 and malloc.seq <= 910`.
