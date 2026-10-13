// Shared steps for the browser smoke flows: load the demo, get past the
// welcome screen, pick and click allocations on the map, jump, drag tabs.
// Everything waits on a condition in the page; nothing sleeps for a guess.
import { expect, test as base, type Locator, type Page } from '@playwright/test';

declare global {
  interface Window { __heap_visualizer: any }
}

/** Errors the page reported: uncaught exceptions and console errors. */
export type PageErrors = string[];

/**
 * `app`: the demo loaded, welcome dismissed. Every flow also fails on a page
 * error or a console error raised along the way.
 */
export const test = base.extend<{ app: Page; errors: PageErrors }>({
  errors: async ({ page }, use) => {
    const errors: PageErrors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await use(errors);
    expect(errors, 'page and console errors').toEqual([]);
  },
  app: async ({ page, errors }, use) => {
    void errors; // (requested so it is listening before the page loads)
    await loadDemo(page);
    await use(page);
  },
});
export { expect };

/** Open the bundled demo and wait for the trace to be loaded. */
export async function loadDemo(page: Page) {
  await page.goto('/?trace=demo.heapl');
  await waitLoaded(page);
}

/** The trace is loaded, the first state painted, the welcome screen gone. */
export async function waitLoaded(page: Page) {
  await page.waitForFunction(() => window.__heap_visualizer?.loaded && window.__heap_visualizer.state, null, { timeout: 20_000 });
  const welcome = page.locator('#welcome');
  if (await welcome.isVisible()) await page.click('#welcome-close');
  await expect(welcome).toBeHidden();
}

/** Jump the playhead to `seq` from the toolbar's jump box. */
export async function jumpTo(page: Page, seq: number) {
  await page.fill('#jump-input', String(seq));
  await page.press('#jump-input', 'Enter');
  await page.waitForFunction((s) => window.__heap_visualizer.state?.seq === s, seq);
}

/**
 * Viewport points on the address map that hit distinct allocations, found by
 * asking the worker to pick (the same request a click makes) over a grid —
 * so the click that follows is known to land on something. Points under
 * another window are skipped.
 */
export async function allocPoints(page: Page, n: number, skip: number[] = []) {
  return page.evaluate(async ({ n, skip }) => {
    const UI = window.__heap_visualizer;
    const scroll = document.getElementById('addr-scroll').getBoundingClientRect();
    const canvas = document.getElementById('addr').getBoundingClientRect();
    const pick = (x: number, y: number, reqId: number) => new Promise<any>((resolve) => {
      const on = (ev: MessageEvent) => {
        if (ev.data?.type !== 'pick-result' || ev.data.reqId !== reqId) return;
        UI.worker.removeEventListener('message', on);
        resolve(ev.data.info);
      };
      UI.worker.addEventListener('message', on);
      UI.worker.postMessage({ type: 'pick', x: x - canvas.left, y: y - canvas.top, reqId });
    });
    const found: { x: number; y: number; e: number }[] = [];
    const seen = new Set(skip);
    let id = -1_000_000; // far from the app's own reqIds
    for (let iy = 1; iy < 40 && found.length < n; iy++) {
      for (let ix = 1; ix < 16 && found.length < n; ix++) {
        const x = scroll.left + (scroll.width * ix) / 16;
        const y = scroll.top + Math.min(scroll.height - 6, 6 + iy * 12);
        const top = document.elementFromPoint(x, y);
        if (!top || !document.getElementById('addr-scroll').contains(top)) continue;
        const info = await pick(x, y, id--);
        if (info && !seen.has(info.e)) {
          seen.add(info.e);
          found.push({ x, y, e: info.e });
        }
      }
    }
    return found;
  }, { n, skip });
}

/** Click an allocation on the map and wait for it to be the selection. Returns its creator event and id. */
export async function selectAlloc(page: Page, skip: number[] = []) {
  const [p] = await allocPoints(page, 1, skip);
  expect(p, 'an allocation on the map to click').toBeTruthy();
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction((e) => window.__heap_visualizer.selected === e
    && window.__heap_visualizer.detailInfo?.e === e, p.e);
  const id = await page.evaluate(() => window.__heap_visualizer.detailInfo.id);
  return { e: p.e, id: String(id) };
}

/** A dock tab by its exact title. */
export function tab(page: Page, title: string): Locator {
  return page.locator('#dock .dv-tab', {
    has: page.locator('.dv-default-tab-content', { hasText: new RegExp(`^${escapeRe(title)}$`) }),
  });
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tab titles, grouped per floating window, in DOM order. */
export async function floatingWindows(page: Page): Promise<string[][]> {
  return page.evaluate(() => [...document.querySelectorAll('#dock .dv-resize-container')].map((f) => [...f.querySelectorAll('.dv-tab .dv-default-tab-content')].map((t) => t.textContent)));
}

/** Drag with the mouse in steps, so the dock engine sees a real drag and its drop targets. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  }
  // one more over the target: the engine settles its drop zone on dragover
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

/** The middle of a locator's box (or 14px in from its left, for a tab's title). */
export async function pointIn(loc: Locator, at: 'center' | 'left' = 'center') {
  const b = await loc.boundingBox();
  expect(b, 'element on screen').toBeTruthy();
  return { x: at === 'left' ? b.x + 14 : b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

/** How many distinct colors an element paints, read off a screenshot of it. */
export async function distinctColors(page: Page, loc: Locator) {
  const png = (await loc.screenshot()).toString('base64');
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < d.length; i += 4) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return colors.size;
  }, png);
}
