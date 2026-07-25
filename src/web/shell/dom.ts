// Shell: DOM helpers with no domain knowledge. Nothing here knows what an
// allocation is — these are the primitives every panel and overlay is built
// from, lifted out of main.js unchanged.
//
// The element types here are deliberately loose. `$('row-bytes').value` is how
// the whole layer reads inputs, and typing `$` as `HTMLElement` would turn
// every one of those into an error to be silenced with a cast — noise that
// would bury the contract types this pass is actually here to add. Tightening
// this (a generic `$<T extends HTMLElement>`, or ids mapped to element types)
// belongs with the conversion of main.js, in T008.

/** An element read loosely: see the note above. */
export type El = any;

export const $ = (id: string): El => document.getElementById(id);

/** Every element matching a selector, as an array — `[...root.querySelectorAll(x)]` was the shape everywhere. */
export const $$ = (sel: string, root: El = document): El[] => [...root.querySelectorAll(sel)];

/** The first element matching a selector, or null. */
export const $1 = (sel: string, root: El = document): El => root.querySelector(sel);

export const dpr = window.devicePixelRatio || 1;

// Every worker state message (i.e. every rendered frame during playback or a
// drag) used to rebuild innerHTML for the overlay, both strips' bookmark
// flags, the address-mark lines and the crop/selection bands. The content is
// usually identical frame to frame, so each of those rebuilds now goes
// through this: assign only when the markup actually changed.
export function setHtml(el: El, html: string): boolean {
  if (el._lastHtml === html) return false;
  el._lastHtml = html;
  el.innerHTML = html;
  return true;
}

// One delegated listener per (container, event type): the handler fires for
// the closest element carrying the given data-* attribute, so the
// build*Section functions can rebuild a list's markup without rewiring N
// per-element handlers each time. Handlers get (element, dataset value).
export function delegate(el: El, type: string, handlers: Record<string, (el: El, value?: string) => void>) {
  el.addEventListener(type, (ev: any) => {
    for (const [attr, fn] of Object.entries(handlers)) {
      const t = ev.target.closest(`[data-${attr}]`);
      if (t && el.contains(t)) {
        fn(t, t.dataset[attr]);
        return;
      }
    }
  });
}

// Engine geometry is device px, the DOM overlay layer is CSS px. These are
// the conversion boundary — worker rect/point geometry entering the DOM goes
// through them instead of ad-hoc /dpr at each use. (Pointer coordinates go
// the other way as CSS px and are converted worker-side, see toDevice there.)
export type Rect = { x: number; y: number; w: number; h: number };

export function toCss(r: Rect, minWH = 1): Rect {
  return {
    x: r.x / dpr,
    y: r.y / dpr,
    w: Math.max(minWH, r.w / dpr),
    h: Math.max(minWH, r.h / dpr),
  };
}

export function toCssLen(v: number): number {
  return v / dpr;
}
