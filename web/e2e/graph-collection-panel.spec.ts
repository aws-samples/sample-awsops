import { test, expect } from '@playwright/test';

// Fixture transport only: real pages, CSS, native details and ReactFlow geometry.
// No auth bypass in product code and no live AWS/Aurora calls.
for (const path of ['/topology/infra', '/topology/resource/vpc%3Aone']) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`${path} source details preserve canvas at ${viewport.width}px`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        const sources = Array.from({ length: 48 }, (_, i) => ({
          sourceId: `inventory:source_${i}`, status: i ? 'ok' : 'partial', scope: 'aggregate',
          reasons: i ? [] : ['unknown_attributes'], itemCount: 3,
          capturedAtMs: 1789380000000, lastSuccessAtMs: 1789380300000,
        }));
        return route.fulfill({ json: url.pathname === '/api/graph' ? {
          nodes: [{ id: 'vpc:one', kind: 'vpc', label: 'Example VPC' }],
          edges: [], captured_at: '2026-09-14T12:00:00Z',
          collection: { status: 'partial', stale: true, retainedPrevious: true,
            attempted_at: '2026-09-14T12:05:00Z', captured_at: '2026-09-14T12:00:00Z',
            sources, publishedSources: sources, evidenceKind: 'inventory' },
        } : { accounts: [], rows: [], clusters: [] } });
      });
      await page.goto(path);
      await expect(page).toHaveTitle('AWSops');
      const canvas = page.locator('.react-flow');
      const panel = page.getByRole('alert').filter({ hasText: 'Partial collection' });
      await expect(canvas).toBeVisible();
      await expect(panel).toBeVisible();
      // This assertion reproduces the original zero-height canvas before the details fix.
      expect((await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(240);
      const details = panel.locator('details');
      await expect(details).not.toHaveAttribute('open', '');
      const collapsed = (await panel.boundingBox())!;
      expect(collapsed.height).toBeLessThan(viewport.height * .36);
      await page.screenshot({ path: info.outputPath('collapsed.png') });
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      const expandedCanvas = (await canvas.boundingBox())!;
      const expandedPanel = (await panel.boundingBox())!;
      expect(expandedCanvas.height).toBeGreaterThanOrEqual(240);
      expect(expandedPanel.height).toBeLessThanOrEqual(viewport.height * .36 + 2);
      await expect(details.getByText('Sources used by saved graph')).toHaveCount(1);
      const scroll = panel.locator('[data-source-details]');
      expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
      expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath('expanded.png') });
      await info.attach('geometry', { body: JSON.stringify({ viewport, path, collapsed, expandedPanel, expandedCanvas }), contentType: 'application/json' });
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(details).not.toHaveAttribute('open', '');
      expect((await panel.boundingBox())!.height).toBe(collapsed.height);
      expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      expect(errors).toEqual([]);
    });
  }
}
