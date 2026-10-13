// The page as a whole: it loads and paints, the menus and the palette drive
// the layout, and the Logs panel follows the playhead.
import { test, expect, distinctColors, jumpTo, tab } from './helpers.ts';

test('loads the demo: map and strips paint, all three domains present', async ({ app }) => {
  // a canvas the worker never drew is one flat color
  for (const sel of ['#addr-scroll', '#strip-t', '#strip-s']) {
    await expect.poll(() => distinctColors(app, app.locator(sel)), { message: `${sel} paints` }).toBeGreaterThan(8);
  }
  await expect(app.locator('#ev-domains .ev-chip')).toHaveText(['Heap', 'Logs', 'Intervals']);
});

test('menus and palette: View → Logs toggles it; Ctrl+K "reset" resets the layout', async ({ app }) => {
  const logsItem = app.locator('#btn-logs');
  await expect(tab(app, 'Logs')).toHaveCount(1);

  await app.click('#menu-view');
  await expect(logsItem).toHaveAttribute('aria-checked', 'true');
  await logsItem.click();
  await expect(tab(app, 'Logs')).toHaveCount(0);

  await app.click('#menu-view');
  await expect(logsItem).toHaveAttribute('aria-checked', 'false');
  await logsItem.click();
  await expect(tab(app, 'Logs')).toHaveCount(1);

  // closed again, then the palette's Reset layout brings it back
  await app.click('#menu-view');
  await logsItem.click();
  await expect(tab(app, 'Logs')).toHaveCount(0);
  await app.keyboard.press('Control+k');
  await expect(app.locator('#palette')).toBeVisible();
  await app.locator('#palette-input').fill('reset');
  await app.keyboard.press('Enter');
  await expect(app.locator('#palette')).toBeHidden();
  await expect(tab(app, 'Logs')).toHaveCount(1);
});

test('logs follow: the playhead line is marked where the playhead is', async ({ app }) => {
  const cur = app.locator('#logs-rows .log-line.cur');
  for (const seq of [20_000, 60_000]) {
    await jumpTo(app, seq);
    // the marked line is the last log line at or before the playhead
    await expect.poll(async () => {
      const s = await cur.getAttribute('data-seq').catch(() => null);
      return s !== null && +s <= seq && +s > seq - 20_000;
    }, { message: `a log line marked at or before seq ${seq}` }).toBe(true);
    await expect(cur).toHaveCount(1);
    await expect(cur).toBeInViewport();
    const later = await app.locator('#logs-rows .log-line.future').evaluateAll((ls) => ls.map((l) => +(l as HTMLElement).dataset.seq));
    expect(later.every((s) => s > seq)).toBe(true);
  }

  // play moves it forward
  const before = +(await cur.getAttribute('data-seq'));
  await app.click('#btn-play');
  await app.waitForFunction((s) => window.__heap_visualizer.state.seq > s + 2_000, 60_000);
  await app.click('#btn-play');
  await expect.poll(async () => +(await cur.getAttribute('data-seq'))).toBeGreaterThan(before);
});
