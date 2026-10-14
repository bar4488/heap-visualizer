// The filter against the interval domain (ANL-013) and the Events list's
// filtered toggle, which narrows heap rows only (NAV-005).
import { test, expect, jumpTo, tab } from './helpers.ts';

test('an interval-context filter applies, and filtered Events keeps non-heap rows', async ({ app }) => {
  await tab(app, 'Filter').click();
  await app.fill('#filter-source', '"parse_body" in malloc.calls');
  await app.click('#filter-apply');
  await expect(app.locator('#filter-status')).toHaveText('Applied');

  await jumpTo(app, 70_777);
  await app.locator('#ev-filtered').check();
  const rows = app.locator('#events-rows .ev-row');
  await expect(rows.first()).toBeVisible();
  // interval edges are still listed, and so are heap rows the filter keeps
  await expect(app.locator('#events-rows .ev-row.d-intervals').first()).toBeVisible();
  await expect.poll(() => app.locator('#events-rows .ev-row:not(.ev-generic):not(.ev-log):not(.ev-custom)').count()).toBeGreaterThan(0);

  // the Intervals chip off leaves no edge row; the filter still narrows heap
  await app.locator('#ev-domains .ev-chip', { hasText: 'Intervals' }).click();
  await expect(app.locator('#events-rows .ev-row.d-intervals')).toHaveCount(0);
  await app.locator('#ev-domains .ev-chip', { hasText: 'Intervals' }).click();
  await app.locator('#ev-filtered').uncheck();
});
