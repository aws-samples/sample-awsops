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


for (const path of ['/topology/infra', '/topology/resource/vpc%3Aone', '/topology/services']) {
  for (const width of [1440, 390]) {
    test(`${path} discloses a failed read and recovers on refresh at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      let healthy = false;
      await page.route('**/api/**', route => {
        if (new URL(route.request().url()).pathname !== '/api/graph') return route.fulfill({ json: { accounts: [], rows: [], clusters: [] } });
        if (!healthy) return route.fulfill({ status: 500, json: { message: 'PRIVATE',
          collection: { status: 'unknown', stale: true, readStatus: 'unavailable', readReason: 'query_failed' } } });
        return route.fulfill({ json: { nodes: [{ id: 'vpc:one', kind: 'vpc', label: 'Example VPC' }], edges: [],
          captured_at: null, collection: { status: 'ok', stale: false, sources: [] } } });
      });
      await page.goto(path);
      await expect(page.getByRole('alert').filter({ hasText: 'Graph read unavailable' })).toBeVisible();
      await expect(page.locator('body')).not.toContainText('PRIVATE');
      await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      healthy = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Latest collection succeeded' })).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: 'Graph read unavailable' })).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}

for (const path of ['/topology/infra', '/topology/resource/vpc%3Aone', '/topology/services']) {
  for (const width of [1440, 390]) {
    test(`${path} automatically recovers a typed busy read at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      let armed = false, recoveryReads = 0;
      await page.route('**/api/**', route => {
        if (new URL(route.request().url()).pathname !== '/api/graph')
          return route.fulfill({ json: { accounts: [], rows: [], clusters: [] } });
        if (armed && ++recoveryReads === 1) return route.fulfill({ status: 503,
          headers: { 'Retry-After': '1' }, json: { message: 'PRIVATE',
            collection: { readStatus: 'unavailable', readReason: 'busy' } } });
        return route.fulfill({ json: { nodes: [{ id: 'vpc:one', kind: 'vpc',
          label: armed ? 'Recovered graph' : 'Initial graph' }], edges: [], captured_at: null,
          collection: { status: 'ok', stale: false, sources: [] } } });
      });
      await page.goto(path);
      await expect(page.locator('.react-flow')).toContainText('Initial graph');
      armed = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.locator('.react-flow')).toContainText('Recovered graph');
      expect(recoveryReads).toBe(2);
      await expect(page.locator('body')).not.toContainText('PRIVATE');
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath('busy-recovery.png') });
    });
  }
}


for (const path of ['/topology/infra', '/topology/resource/vpc%3Aone', '/topology/services']) {
  for (const width of [1440,390]) {
    test(`${path} clears stale graph and offers sign-in after expiry at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
      let expired = false;
      await page.route('**/api/**', route => {
        if (new URL(route.request().url()).pathname !== '/api/graph') return route.fulfill({ json: { accounts: [], rows: [] } });
        if (expired) return route.fulfill({ status: 401, json: { message: 'PRIVATE' } });
        return route.fulfill({ json: { nodes: [{ id: 'vpc:one', kind: 'vpc', label: 'Visible fixture' }], edges: [],
          captured_at: null, collection: { status: 'ok', stale: false, sources: [] } } });
      });
      await page.goto(path);
      await expect(page.locator('.react-flow')).toContainText('Visible fixture');
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
      expired = true;
      await refresh.click();
      const error = page.getByRole('alert').filter({ hasText: 'Session expired' });
      await expect(error).toBeVisible();
      await expect(error.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
      await expect(refresh).toBeDisabled();
      await expect(page.locator('body')).not.toContainText('Visible fixture');
      await expect(page.locator('body')).not.toContainText('PRIVATE');
    });
  }
}
