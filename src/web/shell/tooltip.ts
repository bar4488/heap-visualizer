// Shell: the one tooltip element, and who currently owns it. Callers pass an
// opaque owner token so a hide from one source can't tear down a tooltip that
// another source has since put up. No domain knowledge: the caller supplies
// the markup.

import { $ } from './dom.ts';

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
