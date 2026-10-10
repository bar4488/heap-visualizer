// The Allocation windows (spec SHELL-005): one live window that follows the
// selection, and any number of pinned ones, each showing one allocation until
// it is closed or unpinned. The windows' content is main.ts's; what lives here
// is where they go and how they are titled, which is what has to stay sound
// as windows are pinned, unpinned and regrouped.
//
// The live window is the singleton `detail-panel`; a pinned one is the
// instance `pinned-detail:<creator event>`. Pinning replaces the live window
// with the pinned one in place, and never touches another pinned window.

import type { Place } from '../shell/layout.ts';

export const LIVE = 'detail-panel';
export const PINNED = 'pinned-detail';

/** The slice of the shell's panel API this needs (shell/layout.ts). */
type Layout = {
  open: (type: string, key?: string, opts?: any) => any;
  close: (type: string, key?: string) => void;
  reveal: (type: string, key?: string, opts?: any) => any;
  isOpen: (type: string, key?: string) => boolean;
  placeOf: (type: string, key?: string) => Place | null;
  location: (type: string, key?: string) => { dock: string | null; open: boolean } | null;
  forget: (type: string, key?: string) => void;
};

/** What a window needs of an allocation: its creator event and its id. */
export type AllocRef = { e: number; id: number | string };

const keyOf = (info: AllocRef) => String(info.e);

/** A pinned window's tab: the allocation's name, else `#<id>`. */
export function pinnedTitle(info: AllocRef, name?: string | null): string {
  return name || `#${info.id}`;
}

/**
 * Pin `info`: the live window is replaced in place by a pinned window for
 * it — same group, floating or docked — so pinning never adds a window. The
 * next selection opens the live window again: back in its dock group when it
 * was docked, or as a fresh floating window beside the selection when it was
 * floating (so it does not tab itself onto the window just pinned). An
 * allocation already pinned only has its window brought to the front.
 * Returns the pinned window's element.
 */
export function pinAllocation(layout: Layout, info: AllocRef) {
  const key = keyOf(info);
  if (layout.isOpen(PINNED, key)) return layout.reveal(PINNED, key);
  const loc = layout.location(LIVE);
  const floating = !!loc?.open && loc.dock == null;
  const el = layout.open(PINNED, key, { data: info, beside: { type: LIVE } });
  layout.close(LIVE);
  if (floating) layout.forget(LIVE);
  return el;
}

/**
 * Unpin `info`: its window closes, and the allocation is shown in the live
 * window instead — `show(place)` is the selection of it, with `place` where
 * the live window should open if it is closed (where the pinned one stood),
 * or null when it is open and stays where it is.
 */
export function unpinAllocation(layout: Layout, info: AllocRef, show: (place: Place | null) => void) {
  const key = keyOf(info);
  const place = layout.isOpen(LIVE) ? null : layout.placeOf(PINNED, key);
  layout.close(PINNED, key);
  show(place);
}
