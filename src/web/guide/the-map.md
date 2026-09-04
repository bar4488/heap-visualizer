# 2. Read the map

The map shows allocations live at the playhead. Rows move through address space;
rectangles span their allocated bytes.

Open [Layout](#show:layout-panel) and set row width to
[0x400](#set:row-bytes=0x400). The allocations spread across more rows because
each row now covers fewer bytes. Set it back to
[0x1000](#set:row-bytes=0x1000).

Empty address ranges collapse into labeled gaps. Nothing has been omitted from
the trace—only empty space from the map.
