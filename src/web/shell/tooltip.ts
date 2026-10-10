// Shell: the one tooltip element, and who currently owns it. Callers pass an
// opaque owner token so a hide from one source can't tear down a tooltip that
// another source has since put up. No domain knowledge: the caller supplies
// the markup.

import { $ } from './dom.ts';
import { esc } from '../fmt.ts';

const tooltip = $('tooltip');
let tooltipOwner = null;
let mouse = { x: 0, y: 0 };
document.addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });

export function showTooltip(owner, html) {
  tooltipOwner = owner;
  tooltip.innerHTML = html;
  tooltip.hidden = false;
}

export function hideTooltip(owner) {
  if (tooltipOwner === owner) {
    tooltip.hidden = true;
    tooltipOwner = null;
  }
}

export function positionTooltipNearMouse() {
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  let x = mouse.x + pad;
  let y = mouse.y + pad;
  if (x + r.width > innerWidth - 8) x = mouse.x - r.width - pad;
  if (y + r.height > innerHeight - 8) y = mouse.y - r.height - pad;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}

/** How long the pointer rests on an element before its `data-tip` shows. */
export const TIP_DELAY_MS = 350;

/**
 * The app's tooltip for every `[data-tip]` element inside `container`, in
 * place of a native `title`: shown as plain text after the pointer rests on
 * it for `delay` ms, following the pointer, hidden on leaving, pressing or
 * scrolling. The innermost `[data-tip]` under the pointer wins.
 */
export function hoverTips(container: HTMLElement, owner: string, delay = TIP_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cur: HTMLElement | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    cur = null;
    hideTooltip(owner);
  };
  container.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el === cur) return;
    clear();
    if (!el || !container.contains(el)) return;
    cur = el;
    timer = setTimeout(() => {
      timer = null;
      if (!cur || !cur.isConnected) return;
      showTooltip(owner, esc(cur.dataset.tip ?? ''));
      positionTooltipNearMouse();
    }, delay);
  });
  container.addEventListener('pointermove', () => {
    if (cur && !timer && tooltipOwner === owner) positionTooltipNearMouse();
  });
  container.addEventListener('pointerleave', clear);
  container.addEventListener('pointerdown', clear);
  container.addEventListener('scroll', clear);
}
