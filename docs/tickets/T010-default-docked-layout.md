---
id: T010
title: Panels open into a docked default layout, and drawers collapse
status: done
updated: 2026-07-25
---

# T010: Panels Open Into a Docked Default Layout, and Drawers Collapse

## Outcome

A first visit — no saved session for the trace — opens with the persistent
panels already docked and open in the drawers, and each drawer carries a
control that collapses it to a rail without closing or undocking anything.

## Context

Today every panel starts `hidden` and floats. `.panel` in `style.css` puts them
all at `top: 52px; right: 10px`, so opening Layout, Appearance and Filter
stacks three windows on the same spot over the map, and the drawers only ever
get used by dragging each window to an edge by hand. Docking is fully
implemented ([SHELL-004](../../spec/09-ui-shell.md)) and nothing defaults to it.

Requested by Bar on 2026-07-25, with two constraints from that conversation:
**Play is not worth docking** (it is not really used, so it stays a floating
window), and the drawers need **a way to be hidden without closing the windows
inside them** — which the current shell has no mechanism for, since a drawer's
visibility is derived from whether it holds a visible window.

The default layout is declared where panel ids already live —
`src/web/heap/panels.ts`, per [SHELL-003](../../spec/09-ui-shell.md) — because
which panel belongs at which edge is domain knowledge. The shell keeps not
naming a panel.

## Done when

- [x] `src/web/heap/panels.ts` carries each panel's default dock side and
      default open state, and it is still the only place a panel id is written.
- [x] With `localStorage` empty, the page opens with Layout, Appearance, Filter
      and Marks docked and open in the right drawer, Events docked and open in
      the left, and Play, Warnings and Allocation floating and closed.
- [x] Each drawer has a collapse control in a bar at its top; collapsing hides
      the docked windows without unsetting their `dockSide` or their open
      state, and expanding restores them at the same widths.
- [x] The collapsed state of each drawer round-trips through the session.
- [x] A saved session fully overrides the default layout, including undocking a
      panel the default docks — `applyDrawersState` undocks whatever the saved
      state does not list.
- [x] `node --test 'src/web/**/*.test.ts'` and `cargo test` pass, and
      `npx tsc -p tsconfig.test.json` is clean.

## Non-goals

- A per-trace or user-editable "reset layout" command.
- Docking the Play panel, the Warnings panel, or the Allocation window.
- Any change to how dragging, drop previews, or dividers work.

## Result

Closed on 2026-07-25. The panel table now declares the whole initial workspace,
and `main.ts` reapplies that default before every trace-scoped restore so a
layout from one trace cannot leak into another. The shell adds a narrow
collapsible rail on each populated drawer and persists its state alongside the
existing order and width. Restoring a pinned docked window preserves a saved
collapse, while an actual user drop expands the target drawer.

Verification:

```text
node --test 'src/web/**/*.test.ts'       5 files passed
npx tsc -p tsconfig.test.json            clean
cargo test --manifest-path src/core/Cargo.toml
                                             33 passed
./build.sh web                           passed
curl http://127.0.0.1:8765/main.js       HTTP 200
git diff --check                         clean
rg -n heap src/web/shell                 no matches
```

The tests assert the exact table layout, collapsed-state round-trip, saved
layout replacement, and the distinction between restore and user-drop
expansion. Per D001, no browser was driven; the rail's rendered geometry and
pointer interaction remain the part only a person's ordinary use can inspect.
