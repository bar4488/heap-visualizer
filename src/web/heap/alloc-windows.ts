// The Allocation windows (spec SHELL-005): one live window that follows the
// selection, and any number of pinned ones, each showing one allocation until
// it is closed or unpinned. The windows' content is main.ts's; what lives here
// is where they go and how they are titled, which is what has to stay sound
// as windows are pinned, unpinned and regrouped.
//
// The live window is the singleton `detail-panel`; a pinned one is the
// instance `pinned-detail:<creator event>`. Pinning never touches another
// pinned window, and never closes or moves the live one.

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
};

/** What a window needs of an allocation: its creator event and its id. */
export type AllocRef = { e: number; id: number | string };

const keyOf = (info: AllocRef) => String(info.e);

/** A pinned window's tab: the allocation's name, else `#<id>`. */
export function pinnedTitle(info: AllocRef, name?: string | null): string {
  return name || `#${info.id}`;
}

/**
 * Pin `info`: a pinned window for it opens as a tab in the live window's
 * group (floating or docked), in front; the live window stays there as the
 * other tab and shows the next selection. An allocation already pinned only
 * has its window brought to the front. Returns the pinned window's element.
 */
export function pinAllocation(layout: Layout, info: AllocRef) {
  const key = keyOf(info);
  if (layout.isOpen(PINNED, key)) return layout.reveal(PINNED, key);
  return layout.open(PINNED, key, { data: info, beside: { type: LIVE } });
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
