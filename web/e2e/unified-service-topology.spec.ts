import { expect, test } from '@playwright/test';

test('published graph pins its generation during a drilldown and never fetches a host view after a scope change', async ({
  page,
}, testInfo) => {
  test.skip(process.env.TOPOLOGY_ENTITIES_ENABLED !== 'true', 'Requires the explicit server-side topology pilot gate.');
  const id = 'a'.repeat(64),
    snapshotId = '11111111-1111-4111-8111-111111111111';
  const calls: string[] = [];
  await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/topology') {
      calls.push(u.search);
      return route.fulfill({
        json: {
          contractVersion: 1,
          status: 'partial',
          snapshotId,
          builtAt: '2026-11-18T00:00:00Z',
          sources: [
            {
              sourceId: 'trace',
              status: 'ok',
              capturedAt: '2026-11-18T00:00:00Z',
              stale: false,
              capped: false,
              retained: false,
            },
          ],
          gaps: ['nfm:not_collected'],
          omitted: { entities: 0, relations: 0 },
          nextCursor: null,
          entities: [
            {
              id,
              kind: 'service',
              label: 'orders',
              layers: ['trace'],
              errors: 2,
              knownStatus: 8,
              spanCount: 10,
              durationSumMs: 240,
            },
            {
              id: 'db',
              kind: 'db',
              label: 'postgres:orders',
              layers: ['trace'],
              errors: null,
              knownStatus: null,
              spanCount: null,
              durationSumMs: null,
            },
          ],
          relations: [
            {
              id: 'query',
              source: id,
              target: 'db',
              kind: 'queries',
              layer: 'trace',
              confidence: 'observed',
              spanCount: 8,
            },
          ],
        },
      });
    }
    if (u.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    return route.fulfill({ json: { accounts: [], regions: [], threads: [], rows: [], datasources: [] } });
  });
  await page.goto('/topology?lens=service');
  await page.getByRole('button', { name: 'orders · Error spans 2' }).click();
  await expect(page.getByText('Errors among spans with known status')).toContainText('2 / 8');
  expect(calls.some((q) => q.includes('snapshot=' + snapshotId) && q.includes('focus=' + id))).toBe(true);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('service-graph-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Unified service graph' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
  await page.screenshot({ path: testInfo.outputPath('service-graph-mobile.png') });
  const before = calls.length;
  await page.evaluate(() => {
    localStorage.setItem(
      'awsops:scope',
      JSON.stringify({ accounts: ['222222222222'], regions: '__all__', includeGlobal: true }),
    );
    window.dispatchEvent(new CustomEvent('awsops:scopechange'));
  });
  await expect(page.getByRole('status')).toContainText('unavailable for this scope');
  await expect(page.getByRole('button', { name: 'orders · Error spans 2' })).toHaveCount(0);
  expect(calls.length).toBe(before);
});
