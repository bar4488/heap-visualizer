# 2. Read the address map

Each rectangle is an allocation live at the current playhead. Vertical position
is address, not allocation order.

Open [Layout](#show:layout-panel), then set row width to
[0x400](#set:row-bytes=0x400). The allocations spread across more rows because
you changed the address-space bucket size, not the data.

For address `A`, base `B`, and row width `W`, the projection is:

```
row    = floor((A - B) / W)
column = (A - B) mod W
```

Set row width back to [0x1000](#set:row-bytes=0x1000).

Long empty runs collapse to labeled gaps. **all rows** keeps every row touched
anywhere in the trace laid out, which prevents the map reflowing as you seek.

Now open [Appearance](#show:appearance-panel) and switch to
[site color](#set:color-mode=1). Repeated colors reveal allocations created by
the same call site. Site and thread colors are categorical; size and age modes
are logarithmic. Explicit allocation colors and tag stripes remain visible in
every mode.

Leave site coloring on. It will make the next steps easier to read.
