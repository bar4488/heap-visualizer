# worker-drain-imbalance

## Retention finding

- **Faulty worker:** `6` (`consumer`)
- **Queue condition:** `deferred`
- **Retained:** **36 `message_frame`s**, **87,552 bytes**

### Per-worker retained frames

| Worker | Retained count |
|---:|---:|
| 0 | 0 |
| 1 | 0 |
| 2 | 0 |
| 3 | 0 |
| 4 | 0 |
| 5 | 0 |
| 6 | **36** |
| 7 | 0 |

Each worker allocated 180 message frames / 437,760 bytes; worker 6 freed only 144.

### Precise filter

```text
not alloc.freed
and malloc.site == "message_frame"
and malloc.thread == 6
and malloc.fields.queue == "deferred"
and malloc.fields.workerRole == "consumer"
```

This was validated through `POST /api/v1/filter/check` (`valid: true`) and selects exactly 36 allocations / 87,552 bytes. The `not alloc.freed` predicate excludes the **252 already processed deferred** frames (612,864 bytes).

### API evidence

- `GET /api/v1/overview?top=10`: live-at-end = 36 allocations / 87,552 bytes.
- `POST /api/v1/allocations/summarize`, `malloc.site == "message_frame"`, grouped by `thread`: workers 0–5 and 7 each freed 180; worker 6 freed 144 and retained 36.
- `POST /api/v1/allocations/summarize`, `queue == "deferred"`, grouped by `freed`: 252 freed, 36 live.
- Allocation details at creators `2161` and `2336`: both show `thread: "6"`, `queue: "deferred"`, `workerRole: "consumer"`, and no death event.
