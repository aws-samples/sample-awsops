import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Browser fixtures validate UI/correlation behavior without changing app auth or using live AWS data.
const SHOTS = '/tmp/awsops-service-network-topology';
mkdirSync(SHOTS, { recursive: true });
const END = '2026-09-11T14:00:00.000Z';
const START = '2026-09-11T13:45:00.000Z';
const LB = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/demo/id';
const CATEGORIES = ['INTRA_AZ', 'INTER_AZ', 'INTER_VPC', 'INTER_REGION', 'AMAZON_S3', 'AMAZON_DYNAMODB', 'UNCLASSIFIED'];
const METRICS = ['DATA_TRANSFERRED', 'RETRANSMISSIONS', 'TIMEOUTS', 'ROUND_TRIP_TIME'];

const inventory: Record<string, { resource_id: string; region: string; data: Record<string, unknown> }[]> = {
  route53: [{ resource_id: 'app.example.test', region: 'global', data: {
    name: 'app.example.test.', type: 'A', alias_target: { DNSName: 'demo.cloudfront.net.' },
  } }],
  cloudfront: [{ resource_id: 'distribution-demo', region: 'global', data: {
    domain_name: 'demo.cloudfront.net', aliases: ['app.example.test'],
    origins: [{ DomainName: 'demo.elb.amazonaws.com' }],
  } }],
  alb: [{ resource_id: 'demo', region: 'us-east-1', data: {
    arn: LB, dns_name: 'demo.elb.amazonaws.com', vpc_id: 'vpc-demo', scheme: 'internet-facing',
  } }],
  target_group: ['frontend', 'orders'].map((name, index) => ({
    resource_id: `tg-${name}`, region: 'us-east-1', data: {
      target_group_name: name, target_type: 'ip', vpc_id: 'vpc-demo', load_balancer_arns: [LB],
      target_health_descriptions: [{ Target: { Id: `10.0.${index + 1}.10`, Port: 8080 }, TargetHealth: { State: 'healthy' } }],
    },
  })),
  vpc: [{ resource_id: 'vpc-demo', region: 'us-east-1', data: { tags: { Name: 'application-vpc' } } }],
};
const services = {
  class: 'trace', account: 'self', captured_at: END,
  nodes: [
    { id: 'svc:frontend', kind: 'service', label: 'frontend', meta: { spanCount: 50 } },
    { id: 'svc:orders', kind: 'service', label: 'orders', meta: { spanCount: 40 } },
    { id: 'db:orders', kind: 'db', label: 'postgres:orders', meta: { host: 'orders-db.internal', system: 'postgresql' } },
    ...['frontend', 'orders'].map((name) => ({
      id: `workload:${name}`, kind: 'workload', label: `shop/${name} @demo`,
      meta: { cluster: 'demo', namespace: 'shop', deployment: name, pods: [`${name}-a`] },
    })),
  ],
  edges: [
    { source: 'svc:frontend', target: 'svc:orders', rel: 'calls' },
    { source: 'svc:orders', target: 'db:orders', rel: 'queries' },
    ...['frontend', 'orders'].map((name) => ({ source: `svc:${name}`, target: `workload:${name}`, rel: 'runs_on' })),
  ],
};

async function fixtures(page: Page, opts: {
  partial?: boolean; unavailable?: boolean; podsUnavailable?: 'empty' | 'failed'; foreignEcs?: boolean;
} = {}) {
  const calls: string[] = [];
  const data: typeof inventory = opts.foreignEcs ? {
    ...inventory,
    ecs_task: [{ resource_id: 'foreign-task', region: 'us-east-1', data: {
      cluster_arn: 'cluster/foreign', task_group: 'service:foreign-ecs',
      attachments: [{ Details: [
        { Name: 'privateIPv4Address', Value: '10.0.1.10' }, { Name: 'subnetId', Value: 'subnet-foreign' },
      ] }],
    } }],
    subnet: [{ resource_id: 'subnet-foreign', region: 'us-east-1', data: { vpc_id: 'vpc-peer' } }],
  } : inventory;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    calls.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.startsWith('/api/inventory/')) {
      const type = url.pathname.split('/').pop()!;
      const rows = (data[type] ?? []).filter((row) => {
        if (row.region === 'global') return url.searchParams.get('includeGlobal') !== '0';
        const regions = url.searchParams.get('regions');
        return !regions || regions === '__all__' || regions.split(',').includes(row.region);
      });
      return json({ rows, run: { finished_at: END } });
    }
    if (url.pathname === '/api/eks') return json({ clusters: opts.foreignEcs ? [] : [{ name: 'demo', access: 'connected', region: 'us-east-1', vpcId: 'vpc-demo' }] });
    if (url.pathname === '/api/eks/demo/incluster') {
      if (url.searchParams.get('kind') === 'pods' && opts.podsUnavailable) {
        return json({ rows: [] }, opts.podsUnavailable === 'failed' ? 502 : 200);
      }
      return json({ rows: ['frontend', 'orders'].map((name, index) => url.searchParams.get('kind') === 'pods'
        ? { name: `${name}-a`, namespace: 'shop', podIP: `10.0.${index + 1}.10`, workload: name }
        : { name, namespace: 'shop', ips: [`10.0.${index + 1}.10`], targets: [{ ip: `10.0.${index + 1}.10`, pod: `${name}-a` }] }) });
    }
    if (url.pathname === '/api/graph') return json(services);
    if (url.pathname === '/api/nfm') return json({
      monitors: opts.unavailable ? [] : [{ name: 'nfm-eks-demo', status: 'ACTIVE', cluster: 'demo' }],
      scopeCount: opts.unavailable ? 0 : 1, metrics: METRICS, categories: CATEGORIES,
    });
    if (url.pathname === '/api/nfm/query') {
      const category = url.searchParams.get('category')!;
      const metric = url.searchParams.get('metric')!;
      if (opts.partial && category === 'INTER_REGION') return json({ message: 'fixture query unavailable' }, 502);
      const local = { ip: '10.0.1.10', podName: 'frontend-a', podNamespace: 'shop', serviceName: 'frontend',
        region: 'us-east-1', vpcId: 'vpc-demo', az: 'us-east-1a' };
      const unit = metric === 'DATA_TRANSFERRED' ? 'Bytes' : metric === 'ROUND_TRIP_TIME' ? 'Milliseconds' : 'Count';
      const value = metric === 'DATA_TRANSFERRED' ? 8388608 : metric === 'ROUND_TRIP_TIME' ? 12.5 : 4;
      const common = { local, unit, value, category, targetPort: 8080, traversed: [], traversedIds: [] };
      const rows = category === 'INTER_AZ' ? [{
        ...common, remote: { ip: '10.0.2.10', podName: 'orders-a', podNamespace: 'shop', serviceName: 'orders',
          region: 'us-east-1', vpcId: 'vpc-demo', az: 'us-east-1b' },
      }] : category === 'INTER_VPC' ? [{
        ...common, remote: { ip: '10.2.0.20', region: 'us-east-1', vpcId: 'vpc-peer' },
        traversed: ['TransitGateway'], traversedIds: ['TransitGateway:tgw-demo'],
      }] : category === 'AMAZON_S3' ? [{
        ...common, remote: { ip: '198.51.100.20', region: 'us-east-1' }, targetPort: 443, snatIp: '192.0.2.10',
        traversed: ['NatGateway'], traversedIds: ['NatGateway:nat-demo'],
      }] : [];
      return json({
        monitor: url.searchParams.get('monitor'), metric, category, range: Number(url.searchParams.get('range')),
        rows, unit, tookMs: 10, capped: false, startTime: START, endTime: END, queriedAt: END,
      });
    }
    if (url.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname === '/api/accounts') return json({ accounts: [{ accountId: 'self', alias: 'Fixture', isHost: true }] });
    if (url.pathname === '/api/accounts/regions') return json({ regions: ['us-east-1'] });
    if (url.pathname === '/api/me') return json({ user: { sub: 'fixture-user', email: 'fixture@example.test' }, isAdmin: false });
    if (url.pathname === '/api/datasources') return json({ datasources: [] });
    return json({ rows: [], threads: [], integrations: [] });
  });
  return calls;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 2);
}

test('desktop: combine traffic evidence, inspect a flow and change the applied metric', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1050 });
  const calls = await fixtures(page);
  const errors: string[] = [];
  const consoleIssues: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(message.text());
  });
  await page.goto('/topology?view=e2e');
  await expect(page).toHaveTitle(/AWSops/i);
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toBeEnabled();
  expect(calls.filter((u) => u.startsWith('/api/nfm/query'))).toHaveLength(0);
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('성공한 분류 7');
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  await expect(page.locator('[data-e2e-kind="construct"]')).toHaveCount(2);
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/desktop-overview.png`, fullPage: true });

  await page.getByRole('combobox', { name: '목적지 분류', exact: true }).selectOption('AMAZON_S3');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(1);
  await page.locator('.react-flow__node').filter({ has: page.locator('[data-e2e-kind="connection"]') }).click();
  const detail = page.getByRole('region', { name: '선택한 노드 상세' });
  await expect(detail).toContainText('192.0.2.10');
  await expect(detail).toContainText('NatGateway:nat-demo');
  await expect(detail).toContainText('8 MB');
  await page.screenshot({ path: `${SHOTS}/desktop-flow-detail.png`, fullPage: true });

  await page.getByRole('combobox', { name: '메트릭', exact: true }).selectOption('ROUND_TRIP_TIME');
  await expect(page.getByText('조회 조건이 변경되었습니다. 조회를 눌러 적용하세요.')).toBeVisible();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('전송량');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('RTT');
  await expect(detail).toHaveCount(0);
  await expect(page.locator('[data-e2e-kind="connection"]')).toContainText('12.5 ms');
  await noOverflow(page);
  expect(errors).toEqual([]);
  expect(consoleIssues).toEqual([]);
});

test('mobile: graph and controls remain readable when one destination category fails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page, { partial: true });
  await page.goto('/topology?view=e2e');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('부분 성공');
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('성공한 분류 6');
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/mobile-partial.png`, fullPage: true });
});

test('member account: never fetch host observations into a selected member topology', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('awsops:scope', JSON.stringify({
    accounts: ['000000000001'], regions: '__all__', includeGlobal: true,
  })));
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.getByText(/서비스·NFM 통합 관측은 호스트 계정/)).toBeVisible();
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toHaveCount(0);
  expect(calls.filter((u) => u === '/api/nfm' || u.startsWith('/api/nfm/query') || u.startsWith('/api/graph'))).toEqual([]);
});

test('unavailable monitoring preserves the configured front-door graph', async ({ page }) => {
  await fixtures(page, { unavailable: true });
  await page.goto('/topology?view=e2e');
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toBeDisabled();
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(1);
  await expect(page.locator('[data-e2e-kind="alb"]')).toHaveCount(1);
});

test('late host inventory cannot overwrite a newly selected member account', async ({ page }) => {
  await fixtures(page);
  let releaseHost!: () => void;
  const hostGate = new Promise<void>((resolve) => { releaseHost = resolve; });
  await page.route('**/api/inventory/**', async (route) => {
    const url = new URL(route.request().url());
    const member = url.searchParams.get('accounts') === '000000000001';
    if (!member) await hostGate;
    const type = url.pathname.split('/').pop()!;
    const rows = (inventory[type] ?? []).map((row) => type === 'cloudfront'
      ? { ...row, data: { ...row.data, aliases: [member ? 'member.example.test' : 'host.example.test'] } } : row);
    await route.fulfill({ json: { rows, run: { finished_at: END } } });
  });
  await page.goto('/topology?view=e2e');
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('awsops:scope', JSON.stringify({
      accounts: ['000000000001'], regions: '__all__', includeGlobal: true,
    }));
    window.dispatchEvent(new CustomEvent('awsops:scopechange'));
  });
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toContainText('member.example.test');
  releaseHost();
  await page.waitForTimeout(150);
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toContainText('member.example.test');
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).not.toContainText('host.example.test');
});

test('same-page navigation and browser history keep the opt-in view consistent with the URL', async ({ page }) => {
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await page.locator('a[href="/topology"]').first().click();
  await expect(page).toHaveURL(/\/topology$/);
  await expect(page.getByRole('heading', { name: 'Topology', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '서비스 + 네트워크', exact: true }).click();
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Topology', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  expect(calls.filter((url) => url.startsWith('/api/nfm/query'))).toEqual([]);
});

for (const podsUnavailable of ['empty', 'failed'] as const) {
  test(`Endpoints-only membership cannot establish a remote workload when pods are ${podsUnavailable}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1050 });
    await fixtures(page, { podsUnavailable });
    await page.goto('/topology?view=e2e');
    await expect(page.getByRole('region', { name: '서비스 소스' })).toContainText('노드 5');
    await page.getByRole('combobox', { name: '목적지 분류', exact: true }).selectOption('INTER_AZ');
    await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
    await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(1);
    await page.locator('.react-flow__node').filter({
      has: page.locator('[data-e2e-kind="endpoint"]'), hasText: 'orders-a',
    }).click();
    const detail = page.getByRole('region', { name: '선택한 노드 상세' });
    await expect(detail).not.toContainText('configured-cluster');
    await expect(detail).not.toContainText('shop/orders @demo');
  });
}

test('a same-IP ECS task from another subnet/VPC cannot name the configured target', async ({ page }) => {
  await fixtures(page, { foreignEcs: true });
  await page.goto('/topology?view=e2e');
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(2);
  await expect(page.locator('[data-e2e-kind="target"]').filter({ hasText: 'foreign-ecs' })).toHaveCount(0);
  await expect(page.locator('[data-e2e-kind="target"]').filter({ hasText: '10.0.1.10' })).toHaveCount(1);
});

test('region/global scope changes reach inventory requests and remove excluded global resources', async ({ page }) => {
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(1);
  await page.evaluate(() => {
    localStorage.setItem('awsops:scope', JSON.stringify({
      accounts: ['self'], regions: ['us-east-1'], includeGlobal: false,
    }));
    window.dispatchEvent(new CustomEvent('awsops:scopechange'));
  });
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(0);
  await expect(page.locator('[data-e2e-kind="alb"]')).toHaveCount(1);
  expect(calls.some((value) => {
    const url = new URL(value, 'http://localhost');
    return url.pathname === '/api/inventory/alb'
      && url.searchParams.get('regions') === 'us-east-1' && url.searchParams.get('includeGlobal') === '0';
  })).toBe(true);
});
