# realloc-lineage

## Findings

- **Request / route:** `req-8841` on `/bulk/export` (`stream_buffer`, thread 3; policy `adaptive`).
- **Complete realloc lineage (creator event → size):**
  1. **1161** `malloc` → **4,096 B**
  2. **1162** `realloc` → **8,192 B**
  3. **1163** `realloc` → **16,384 B**
  4. **1164** `realloc` → **65,536 B**
  5. **1165** `realloc` → **262,144 B**
  6. **1166** `realloc` → **524,288 B**
  7. **1167** `realloc` → **1,048,576 B (1 MiB)**

The relations form one chain: `1161 → 1162 → 1163 → 1164 → 1165 → 1166 → 1167`, not unrelated allocations. **Creator 1167 remains live** at trace end; it is the trace’s sole live allocation and accounts for all **1,048,576 B** live bytes.

## Comparison

The otherwise similar completed `/bulk/export` stream requests comprise **12 completed chains** (**54 freed generations**, **2,994,176 B** total). Representative `req-0011` follows:

`1145 malloc 4,096 B → 1146 realloc 8,192 B → 1147 realloc 32,768 B → 1148 realloc 131,072 B → free 1160 (reason: response-complete)`.

Thus completed streams stop at **128 KiB** and are freed, whereas `req-8841` takes the extended growth path through 16 KiB, 64 KiB, 256 KiB, 512 KiB, and remains live at **1 MiB**.

## API evidence

- `POST /api/v1/allocations/query`, filter:  
  `not alloc.freed and malloc.site == "stream_buffer"` → creator **1167**, size **1048576**.
- `GET /api/v1/allocations/{1161..1167}` → creator fields, sizes, and `reallocatedFrom`/`reallocatedTo` links.
- `POST /api/v1/allocations/summarize`, filter:  
  `malloc.site == "stream_buffer" and malloc.fields.route == "/bulk/export"` → **54 freed / 1 live** generations.
- Completed-cohort filter:  
  `malloc.site == "stream_buffer" and malloc.fields.route == "/bulk/export" and alloc.freed and alloc.size == 131072` → **12** completed terminal buffers.
