// Shell: DOM helpers with no domain knowledge. Nothing here knows what an
// allocation is — these are the primitives every panel and overlay is built
// from, lifted out of main.js unchanged.

export const $ = (id) => document.getElementById(id);

export const dpr = window.devicePixelRatio || 1;

// Every worker state message (i.e. every rendered frame during playback or a
// drag) used to rebuild innerHTML for the overlay, both strips' bookmark
// flags, the address-mark lines and the crop/selection bands. The content is
// usually identical frame to frame, so each of those rebuilds now goes
// through this: assign only when the markup actually changed.
export function setHtml(el, html) {
  if (el._lastHtml === html) return false;
  el._lastHtml = html;
  el.innerHTML = html;
  return true;
}

// One delegated listener per (container, event type): the handler fires for
// the closest element carrying the given data-* attribute, so the
// build*Section functions can rebuild a list's markup without rewiring N
// per-element handlers each time. Handlers get (element, dataset value).
export function delegate(el, type, handlers) {
  el.addEventListener(type, (ev) => {
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
export function toCss(r, minWH = 1) {
  return {
    x: r.x / dpr,
    y: r.y / dpr,
    w: Math.max(minWH, r.w / dpr),
    h: Math.max(minWH, r.h / dpr),
  };
}

export function toCssLen(v) {
  return v / dpr;
}
