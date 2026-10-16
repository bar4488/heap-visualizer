// The interval selection (spec 14): a call row in Events opens the Interval
// window, and Tracks and Stacks mark the same interval.
import { test, expect, jumpTo, tab } from './helpers.ts';

test('clicking a call row in Events opens the Interval window and marks Tracks/Stacks', async ({ app }) => {
  await jumpTo(app, 70_777);
  // bring Tracks and Stacks to the front of their groups, so both draw
  await tab(app, 'Tracks').click();
  await tab(app, 'Stacks').click();

  const call = app.locator('#events-rows .ev-row', { has: app.locator('.ev-kind', { hasText: /^call ▸$/ }) }).first();
  await expect(call).toBeVisible();
  await call.locator('.ev-main').click();

  const win = app.locator('#interval-window');
  await expect(win).toBeVisible();
  await expect(win.locator('.ph-t')).toHaveText(/^Call · /);
  await expect(app.locator('#dock .dv-tab', { hasText: /^Call · / })).toHaveCount(1);
  const sel = await app.waitForFunction(() => window.__heap_visualizer.intervalSel).then((h) => h.jsonValue());
  expect(sel).toBeTruthy();
  await expect(call).toHaveClass(/picked/);
  await expect(app.locator('#intervals-state-panel .sel').first()).toBeVisible();
});
