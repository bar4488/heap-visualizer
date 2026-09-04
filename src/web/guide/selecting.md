# Selection

Click a map allocation, seek to an allocation event, or jump to an address. The
Allocation panel reports its span, requested and usable sizes, birth/death,
site, thread, stack, and producer-defined fields.

From that panel you can focus the map location, seek to birth or death, assign a
name/color/tags, or replace the filter with
`alloc.span.overlaps(range(<address>, <end>))`. Pinning freezes the current
allocation in an independent window for comparison; selecting a pinned
allocation raises it.

Shift-click the map to create an address mark.

## Ranges

Shift-drag either strip, or drag vertically in Events. A range is defined in one
domain and projected onto both strips. Escape clears it.

The range popover can zoom the strip, crop the view, tag allocations born in
the range, or tag allocations freed in it. Crop restricts attention to births
inside the sequence window; it dims rather than hides and remains active until
cleared from the toolbar.

[sites.heapl](index.html?trace=guide/traces/sites.heapl&guide=1) is a small
trace for inspecting selections, producer fields, ranges, and layout changes.
