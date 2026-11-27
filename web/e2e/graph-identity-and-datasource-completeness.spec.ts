import { test, expect } from '@playwright/test';
import { normalizeResult } from '../lib/datasource-render';

// Real pages and normalizer, synthetic API transports; no product auth bypass or AWS calls.
test('a legacy regional resource link discloses ambiguity and opens the selected canonical graph', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
  const candidates = ['rds:@self:us-east-1:app-db', 'rds:@self:ap-northeast-2:app-db'];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/graph') return route.fulfill({ json: { accounts: [], rows: [], clusters: [] } });
    const requested = url.searchParams.get('from');
    return route.fulfill({ json: {
      nodes: requested === candidates[1] ? [{ id: candidates[1], kind: 'rds', label: 'Seoul application DB' }] : [],
      edges: [], captured_at: null, collection: { status: 'unknown', stale: true, sources: [] },
      selection: requested === candidates[1]
        ? { status: 'resolved', requested_id: requested, resolved_id: candidates[1] }
        : { status: 'ambiguous', requested_id: requested, candidate_ids: candidates },
    } });
  });
  await page.goto('/topology/resource/rds%3Aapp-db');
  await expect(page.getByRole('alert').filter({ hasText: 'Resource selection is ambiguous' })).toBeVisible();
  await page.getByRole('link', { name: candidates[1], exact: true }).click();
  await expect(page.locator('.react-flow')).toContainText('Seoul application DB');
  await expect(page.getByRole('alert').filter({ hasText: 'Resource selection is ambiguous' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a scoped placement VPC opens connectivity with its exact account, region and raw ID', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
  const vpc = 'vpc-0123456789abcdef0', reads: URL[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/graph') return route.fulfill({ json: {
      nodes: [{ id: `vpc:@self:us-east-1:${vpc}`, kind: 'vpc', label: 'Scoped VPC',
        meta: { resourceId: vpc, inventoryAccount: 'self', region: 'us-east-1' } }],
      edges: [], captured_at: null, collection: { status: 'unknown', stale: true, sources: [] },
    } });
    if (url.pathname === '/api/inventory/vpc') return route.fulfill({ json: {
      rows: [{ resource_id: vpc, account_id: 'self', region: 'us-east-1', data: { name: 'Scoped VPC' } }],
    } });
    if (url.pathname === '/api/vpc-connectivity') {
      reads.push(url);
      return route.fulfill({ json: {
        source: { vpcId: vpc, region: 'us-east-1', accountId: '111122223333', ownerId: '111122223333', name: 'Scoped VPC' },
        checkedAt: new Date().toISOString(), peerings: [], transitGateways: [], incompleteSources: [], limitations: [],
      } });
    }
    return route.fulfill({ json: { accounts: [], rows: [], clusters: [] } });
  });
  await page.goto('/topology/infra');
  await page.locator('.react-flow__node').filter({ hasText: 'Scoped VPC' }).click();
  await expect(page).toHaveURL(/vpc=self%2Fus-east-1%2Fvpc-/);
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads.every(url => url.searchParams.get('account') === 'self'
    && url.searchParams.get('region') === 'us-east-1' && url.searchParams.get('vpcId') === vpc)).toBe(true);
});

for (const kind of ['datadog', 'dynatrace']) {
  test(`${kind} Explore renders retained series with partial-result disclosure`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('awsops-lang', 'en'));
    const t = Date.now(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = kind === 'datadog'
      ? { series: [{ metric: 'fixture.metric', scope: 'fixture', pointlist: [[t, 1], [t + 1000, 2]] }] }
      : { result: [{ metricId: 'fixture.metric', data: [{ dimensions: ['fixture'], timestamps: [t, t + 1000], values: [1, 2] }] }] };
    const result = normalizeResult(kind, `${kind}_query`, { ...response, truncated: true, collectionStatus: 'partial' });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/datasources') return route.fulfill({ json: {
        datasources: [{ id: 1, name: `Fixture ${kind}`, kind, configured: true, connectionStatus: 'not_checked' }],
      } });
      if (url.pathname === '/api/datasources/query') return route.fulfill({ json: { result, metadata: { executionTimeMs: 1 } } });
      return route.fulfill({ json: { accounts: [], rows: [], signals: [], cards: [], clusters: [] } });
    });
    await page.goto('/integrations/datasources/1');
    const query = page.locator('textarea');
    await expect(query).toBeEnabled();
    await query.fill(kind === 'datadog' ? 'avg:fixture.metric{*}' : 'fixture.metric');
    await query.press('Control+Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Partial results' })).toBeVisible();
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
