# Ranges

Shift-drag on either strip, or drag vertically in the Events panel. Escape
clears the selection, and nothing saves it.

- A range is made in one domain and mirrored into the other, drawn on both
  strips and in the Events gutter. The same 200 events are a sliver in time and
  a wide band in events.
- The popover offers **Zoom** (strip view only), **Crop**, **Tag allocs**,
  **Tag freed**.
- **Tag allocs** takes the allocations created in the range. **Tag freed** takes
  the creators of the `F` and `R` events in it, which is how you tag what died
  during a dip.
- **Crop** restricts attention to allocations created in the seq window. It
  always dims and never hides, whatever the filter's mode, so a crop cannot
  empty the map. It stays until you clear it from the toolbar ✂ pill.

# Allocations

Click a rectangle, step onto an event, or jump to an address. The allocation
panel opens with id, address range, requested size, `usable` if the producer
sent it, site, thread, birth `seq`/`t`, death `seq`/`t` or `never (leak?)`, and
stack.

Below that come any fields the producer added that this format does not define,
verbatim. The two `pool` records at the end of
[sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1) show this.

Actions on the panel:

- **⌖ focus** — flash exactly where it is on the map.
- **go to birth**, **go to death** — move the playhead to just after either
  event.
- **match range** — replace the filter with `alloc.span.overlaps(range(<addr>, <end>))` and
  apply it.
- **name** — free text; shows in the map label, tooltip, and search.
- **tags** — comma-separated memberships, applied with **set**.
- **color** — highlight color, visible in every color mode.

Shift-click anywhere on the map adds an address mark at the address under the
cursor.

## Pinning

📌 freezes the current panel as an independent window and lets the next
selection open a fresh one. Pin as many as you want to compare them side by
side; unpinning returns that content to the live panel. Selecting an
already-pinned allocation raises its window.
