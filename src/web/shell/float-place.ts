// Shell: where a floating window goes. Engine-free geometry, in the floating
// area's own coordinates (its top-left is 0,0): the spot a window takes when
// it floats from scratch — beside a point the user just acted on (a clicked
// allocation), or in a corner — without landing on the windows already
// floating there, and inside the area.
//
// Still domain-agnostic: boxes and points only.

export type Size = { width: number; height: number };
export type Box = { left: number; top: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Corner = 'bottom-left' | 'top-right';

/** Clearance from the area's edges, and from the point a window opens beside. */
export const GAP = 12;
/** The strip along a window's top that a window opened over it must leave in sight. */
export const TITLE = 30;
const STEP = 8; // the search grid

/** A window's size inside the area: as asked for, but never larger than the area (less its gaps). */
export function fitSize(size: Size, area: Size): Size {
  return {
    width: Math.max(Math.min(160, area.width), Math.min(size.width, area.width - 2 * GAP)),
    height: Math.max(Math.min(120, area.height), Math.min(size.height, area.height - 2 * GAP)),
  };
}

/** The same box moved (and, only when it cannot fit, shrunk) to lie inside the area. */
export function clampBox(b: Box, area: Size): Box {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  return {
    left: Math.max(0, Math.min(b.left, area.width - width)),
    top: Math.max(0, Math.min(b.top, area.height - height)),
    width,
    height,
  };
}

function overlaps(a: Box, b: Box) {
  return a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * The spot for a new floating window of `size` in `area`.
 *
 * Its preferred spot is beside `anchor` (to the right of it, else the left,
 * below, above) — never on top of it — or, with no anchor, the `corner`. Of
 * the spots inside the area that overlap none of `others`, it takes the one
 * nearest a preferred spot. When every spot overlaps something, it cascades:
 * it takes a spot that leaves every other window's title strip in sight,
 * covering as little of them as it can.
 */
export function placeFloat(o: { area: Size; size: Size; others?: Box[]; anchor?: Point | null; corner?: Corner }): Box {
  const { area } = o;
  const others = o.others || [];
  const { width, height } = fitSize(o.size, area);
  const maxLeft = Math.max(0, area.width - width - GAP);
  const maxTop = Math.max(0, area.height - height - GAP);
  const minLeft = Math.min(GAP, maxLeft);
  const minTop = Math.min(GAP, maxTop);
  const clampL = (l: number) => Math.max(minLeft, Math.min(maxLeft, Math.round(l)));
  const clampT = (t: number) => Math.max(minTop, Math.min(maxTop, Math.round(t)));
  const a = o.anchor;
  const inArea = a && a.x >= 0 && a.y >= 0 && a.x <= area.width && a.y <= area.height;
  const preferred: { left: number; top: number }[] = inArea
    ? [
      { left: a.x + 2 * GAP, top: a.y - height / 3 },
      { left: a.x - 2 * GAP - width, top: a.y - height / 3 },
      { left: a.x - width / 2, top: a.y + 2 * GAP },
      { left: a.x - width / 2, top: a.y - 2 * GAP - height },
    ].map((p) => ({ left: clampL(p.left), top: clampT(p.top) }))
    : [o.corner === 'top-right' ? { left: maxLeft, top: minTop } : { left: minLeft, top: maxTop }];
  // the point itself is in the way too: a window opened beside a selection
  // must not cover it
  const blocked = inArea ? [...others, { left: a.x - GAP, top: a.y - GAP, width: 2 * GAP, height: 2 * GAP }] : others;
  const free = (left: number, top: number) => !blocked.some((b) => overlaps({ left, top, width, height }, b));
  const distance = (left: number, top: number) => Math.min(...preferred.map((p) => Math.hypot(left - p.left, top - p.top)));

  // the preferred spots in order, then the nearest free spot anywhere
  for (const p of preferred) if (free(p.left, p.top)) return { left: p.left, top: p.top, width, height };
  const lefts = [];
  for (let l = minLeft; l < maxLeft; l += STEP) lefts.push(l);
  lefts.push(maxLeft);
  const tops = [];
  for (let t = minTop; t < maxTop; t += STEP) tops.push(t);
  tops.push(maxTop);
  let best: { left: number; top: number } | null = null;
  let bestD = Infinity;
  for (const l of lefts) {
    for (const t of tops) {
      if (!free(l, t)) continue;
      const d = distance(l, t);
      if (d < bestD) { bestD = d; best = { left: l, top: t }; }
    }
  }
  if (best) return { ...best, width, height };

  // No free room: overlap is unavoidable, so cascade — the new window goes on
  // top, so what matters is what it hides. Weighed in that order: the other
  // windows' title strips (where each is grabbed, and what says what it is),
  // the point it opened beside, the rest of the other windows, and the
  // distance from its preferred spot. A sliver off a title is cheaper than
  // covering the selection; a whole title is not.
  const titles = others.map((b) => ({ left: b.left, top: b.top, width: b.width, height: Math.min(TITLE, b.height) }));
  const cost = (left: number, top: number) => {
    const me = { left, top, width, height };
    let c = 0;
    for (const t of titles) c += 10 * overlapArea(me, t) / (t.width * t.height);
    if (blocked.length > others.length && overlaps(me, blocked[blocked.length - 1])) c += 3;
    for (const b of others) c += overlapArea(me, b) / (width * height);
    // (a window-width away weighs about as much as covering another whole window)
    return c + distance(left, top) / width;
  };
  let bestC = Infinity;
  for (const l of lefts) {
    for (const t of tops) {
      const c = cost(l, t);
      if (c < bestC) { bestC = c; best = { left: l, top: t }; }
    }
  }
  return { ...(best || preferred[0]), width, height };
}

function overlapArea(a: Box, b: Box) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
