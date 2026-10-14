// Allocation windows and the dock (spec SHELL-004, SHELL-005): pin, unpin,
// grouping floating windows, splitting an edge, and the layout across a reload.
import type { Page } from '@playwright/test';
import {
  test, expect, drag, floatingWindows, pointIn, selectAlloc, tab, waitLoaded,
} from './helpers.ts';

/** Select an allocation and pin it; returns it. Its tab then reads `#<id>`. */
async function pinNew(page: Page, skip: number[] = []) {
  const a = await selectAlloc(page, skip);
  await expect(tab(page, 'Allocation')).toHaveCount(1);
  await page.click('#d-pin');
  await expect(tab(page, `#${a.id}`)).toHaveCount(1);
  await expect(tab(page, 'Allocation')).toHaveCount(0);
  return a;
}

/** The floating windows holding allocation windows (`#…` tabs), as sorted title lists. */
async function allocWindows(page: Page) {
  return (await floatingWindows(page))
    .map((w) => w.filter((t) => t.startsWith('#')).sort())
    .filter((w) => w.length)
    .sort((x, y) => x.join().localeCompare(y.join()));
}

/** The expected `allocWindows`: each list one floating window. */
const windows = (...ws: string[][]) => ws.map((w) => [...w].sort()).sort((x, y) => x.join().localeCompare(y.join()));

/** Drop pinned B's tab onto A's tab strip: one floating window, two tabs. */
async function combine(page: Page, aId: string, bId: string) {
  const from = await pointIn(tab(page, `#${bId}`), 'left');
  const to = await pointIn(tab(page, `#${aId}`), 'left');
  await drag(page, from, to);
  await expect.poll(() => allocWindows(page)).toEqual(windows([`#${aId}`, `#${bId}`]));
}

/** Drop the Logs tab on the lower part of the left edge's group: the edge splits. */
async function splitLeftEdge(page: Page) {
  const left = page.locator('#dock .dv-groupview[data-region="left"]');
  await expect(left).toHaveCount(1);
  const body = await pointIn(left.locator('.dv-content-container'));
  const from = await pointIn(tab(page, 'Logs'), 'left');
  await drag(page, from, { x: body.x, y: body.box.y + body.box.height * 0.9 });
  await expect(left).toHaveCount(2);
  const [top, bottom] = [await left.nth(0).boundingBox(), await left.nth(1).boundingBox()];
  expect(Math.abs(top.x - bottom.x)).toBeLessThan(2); // stacked, not side by side
  expect(bottom.y).toBeGreaterThan(top.y);
  await expect(left.nth(1).locator('.dv-tab', { hasText: 'Logs' })).toHaveCount(1);
}

test('pin replaces the live window; pinning a second leaves the first untouched', async ({ app }) => {
  const a = await pinNew(app);
  const aBox = await tab(app, `#${a.id}`).boundingBox();
  const b = await pinNew(app, [a.e]);
  await expect(app.locator(`.pinned-detail[data-e="${a.e}"]`)).toHaveCount(1);
  await expect(app.locator(`.pinned-detail[data-e="${b.e}"]`)).toHaveCount(1);
  for (const t of [a, b]) await expect(tab(app, `#${t.id}`).locator('.d-pin')).toHaveAttribute('aria-pressed', 'true');
  expect(await tab(app, `#${a.id}`).boundingBox()).toEqual(aBox);
  expect(await allocWindows(app)).toEqual(windows([`#${a.id}`], [`#${b.id}`]));
});

test('unpin closes only that window and shows the allocation in the live window', async ({ app }) => {
  const a = await pinNew(app);
  const b = await pinNew(app, [a.e]);
  await tab(app, `#${b.id}`).locator('.d-pin').click();
  await expect(tab(app, `#${b.id}`)).toHaveCount(0);
  await expect(tab(app, `#${a.id}`)).toHaveCount(1);
  await expect(tab(app, 'Allocation')).toHaveCount(1);
  await app.waitForFunction((e) => window.__heap_visualizer.selected === e
    && window.__heap_visualizer.detailInfo?.e === e, b.e);
});

test('separate windows: combine two pinned tabs, then Move to new window splits them', async ({ app }) => {
  const a = await pinNew(app);
  const b = await pinNew(app, [a.e]);
  await combine(app, a.id, b.id);
  await tab(app, `#${a.id}`).click({ button: 'right' });
  await app.locator('.dv-context-menu-item', { hasText: 'Move to new window' }).click();
  await expect.poll(() => allocWindows(app)).toEqual(windows([`#${a.id}`], [`#${b.id}`]));
});

test('splittable edge: a tab dropped on the lower half of the left edge splits it top/bottom', async ({ app }) => {
  await splitLeftEdge(app);
});

test('reload restores the pinned windows and the layout', async ({ app }) => {
  const a = await pinNew(app);
  const b = await pinNew(app, [a.e]);
  await combine(app, a.id, b.id);
  await splitLeftEdge(app);

  await app.reload();
  await waitLoaded(app);
  // pinned windows come back after a worker round trip, into their saved slot
  await expect.poll(() => allocWindows(app)).toEqual(windows([`#${a.id}`, `#${b.id}`]));
  const left = app.locator('#dock .dv-groupview[data-region="left"]');
  await expect(left).toHaveCount(2);
  await expect(left.nth(1).locator('.dv-tab', { hasText: 'Logs' })).toHaveCount(1);
  await expect(tab(app, 'Allocation')).toHaveCount(0);
});
