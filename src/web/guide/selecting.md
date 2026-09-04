# 4. Inspect an allocation

Jump to [0x555555551000](#set:jump-input=0x555555551000), then press
[Go](#do:btn-jump). An address jump leaves the playhead in place, scrolls to the
nearest live row, and selects the allocation there.

The Allocation panel ties the rectangle back to the trace: address span,
requested and usable sizes, creator and death events, site, thread, stack, and
producer-defined fields. **go to birth** and **go to death** move the playhead;
**focus** returns to the rectangle.

Pin the panel if you want to compare this allocation with another. The pinned
window stops following selection; selecting that allocation again raises it.

There are two useful selection gestures:

- Shift-click the map to create a persistent address mark.
- Shift-drag a timeline, or drag vertically in Events, to select a sequence
  range. From its popover you can zoom, crop, or tag allocations born or freed
  in that range.

Crop always dims rather than hides. This keeps the surrounding heap visible
while narrowing the investigation.
