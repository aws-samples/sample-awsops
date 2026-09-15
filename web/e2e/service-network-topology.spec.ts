import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { projectGraphDetails } from '../lib/graph-state';

// Browser fixtures validate UI/correlation behavior without changing app auth or using live AWS data.
const END = new Date().toISOString();
const START = new Date(Date.parse(END) - 15 * 60_000).toISOString();
const STALE_CAPTURE = new Date(Date.parse(END) - 24 * 60 * 60_000).toISOString();
const run = (row_count: number) => ({ status: 'succeeded', finished_at: END, last_success_at: END, row_count });
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
const partialCollection = {
  status: 'partial', stale: true, readStatus: 'ok', readTruncated: false,
  attempted_at: END, captured_at: STALE_CAPTURE,
  ...projectGraphDetails({ retainedPrevious: true, nodeDrops: 0, edgeDrops: 0,
    sources: Array.from({ length: 48 }, (_, i) => ({
      sourceId: `clickhouse:fixture-${i}`, status: i ? 'partial' : 'future-status',
      reasons: ['cap_reached'], itemCount: i ? 1000 : null,
    })),
  }),
};

const services = {
  class: 'trace', account: 'self', captured_at: END,
  collection: { status: 'ok', stale: false, readStatus: 'ok', retainedPrevious: false,
    nodeDrops: 0, edgeDrops: 0, orphanSpans: 0, invalidSpans: 0, unresolvedMessaging: 0,
    sources: [{ sourceId: 'fixture-trace', status: 'ok', reasons: [],
      windowStartMs: Date.parse(START), windowEndMs: Date.parse(END) }] },
  nodes: [
    { id: 'svc:frontend', kind: 'service', label: 'frontend', meta: { spanCount: 50, accountId: '000000000000', region: 'us-east-1' } },
    { id: 'svc:orders', kind: 'service', label: 'orders', meta: { spanCount: 40, accountId: '000000000000', region: 'us-east-1' } },
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
  completeServices?: boolean; partialEks?: boolean; partial?: boolean; unavailable?: boolean; podsUnavailable?: 'empty' | 'failed'; foreignEcs?: boolean;
  crowded?: boolean; grouped?: boolean; groupedCount?: number;
} = {}) {
  const calls: string[] = [];
  const groupCount = opts.groupedCount ?? (opts.grouped ? 2 : 0);
  const groupPods = Array.from({ length: groupCount }, (_, i) => ({
    name: groupCount === 2 ? `frontend-${i ? 'b' : 'a'}` : `frontend-${i + 1}`,
    namespace: 'shop', podIP: `10.0.${i + 1}.10`, workload: 'frontend', status: 'Running',
  }));
  const data: typeof inventory = opts.foreignEcs ? {
    ...inventory,
    ecs_task: [{ resource_id: 'foreign-task', region: 'us-east-1', data: {
      cluster_arn: 'cluster/foreign', task_group: 'service:foreign-ecs', last_status: 'RUNNING',
      attachments: [{ Details: [
        { Name: 'privateIPv4Address', Value: '10.0.1.10' }, { Name: 'subnetId', Value: 'subnet-foreign' },
      ] }],
    } }],
    subnet: [{ resource_id: 'subnet-foreign', region: 'us-east-1', data: { vpc_id: 'vpc-peer' } }],
  } : groupCount ? { ...inventory, target_group: [{
    ...inventory.target_group[0], data: { ...inventory.target_group[0].data,
      target_health_descriptions: groupPods.map(pod => ({
        Target: { Id: pod.podIP, Port: 8080 }, TargetHealth: { State: 'healthy' },
      })),
    },
  }] } : opts.crowded ? { ...inventory, alb: [...inventory.alb, ...Array.from({ length: 400 }, (_, i) => ({
    resource_id: `crowded-alb-${i}`, region: 'us-east-1',
    data: { arn: `${LB}-${i}`, dns_name: `crowded-${i}.example.test`, vpc_id: 'vpc-demo' },
  }))] } : inventory;
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
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 500);
      const account = url.searchParams.get('accounts');
      return json({ rows: rows.slice(offset, offset + limit).map(row => ({
        ...row, account_id: account && account !== '__all__' ? account : 'self',
        data: { ...row.data, account_id: account && /^\d{12}$/.test(account) ? account : '000000000000' },
        captured_at: '2026-09-11T12:00:00Z',
      })), run: run((data[type] ?? []).length), consistency: 'statement-snapshot' });
    }
    if (url.pathname === '/api/eks') return json({ region: 'us-east-1', truncated: false, clusters: opts.foreignEcs ? [] : [{ name: 'demo', access: 'connected', region: 'us-east-1', vpcId: 'vpc-demo' },
      ...(opts.partialEks ? [{ name: 'blocked', access: 'no-entry', region: 'us-east-1', vpcId: 'vpc-other' }] : [])] });
    if (url.pathname === '/api/eks/demo/incluster') {
      if (groupCount) return json({ rows: url.searchParams.get('kind') === 'pods' ? groupPods : [{
        name: 'frontend', namespace: 'shop', ips: groupPods.map(p => p.podIP),
        targets: groupPods.map(p => ({ ip: p.podIP, pod: p.name })),
      }] });
      if (url.searchParams.get('kind') === 'pods' && opts.podsUnavailable) {
        return json({ rows: [] }, opts.podsUnavailable === 'failed' ? 502 : 200);
      }
      return json({ rows: ['frontend', 'orders'].map((name, index) => url.searchParams.get('kind') === 'pods'
        ? { name: `${name}-a`, namespace: 'shop', podIP: `10.0.${index + 1}.10`, workload: name, status: 'Running' }
        : { name, namespace: 'shop', ips: [`10.0.${index + 1}.10`], targets: [{ ip: `10.0.${index + 1}.10`, pod: `${name}-a` }] }) });
    }
    if (url.pathname === '/api/graph') { const data = groupCount ? { ...services, nodes: services.nodes.map(node =>
      node.id === 'workload:frontend' ? { ...node, meta: { ...node.meta, pods: groupPods.map(p => p.name) } } : node) } : services;
      return json({ ...data, captured_at: opts.completeServices ? END : STALE_CAPTURE,
        collection: opts.completeServices ? services.collection : partialCollection });
    }
    if (url.pathname === '/api/nfm') return json({
      monitors: opts.unavailable ? [] : [{ name: 'nfm-eks-demo', status: 'ACTIVE', cluster: 'demo' }],
      scopeCount: opts.unavailable ? 0 : 1, metrics: METRICS, categories: CATEGORIES,
    });
    if (url.pathname === '/api/nfm/query') {
      const category = url.searchParams.get('category')!;
      const metric = url.searchParams.get('metric')!;
      if (opts.partial && category === 'INTER_REGION') return json({ message: 'fixture-query-credential' }, 502);
      const local = { ip: groupPods.at(-1)?.podIP ?? '10.0.1.10', podName: groupPods.at(-1)?.name ?? 'frontend-a', podNamespace: 'shop', serviceName: 'frontend',
        region: 'us-east-1', vpcId: 'vpc-demo', az: 'us-east-1a' };
      const unit = metric === 'DATA_TRANSFERRED' ? 'Bytes' : metric === 'ROUND_TRIP_TIME' ? 'Milliseconds' : 'Count';
      const value = metric === 'DATA_TRANSFERRED' ? category === 'INTER_AZ' ? 16777216 : 8388608 : metric === 'ROUND_TRIP_TIME' ? 12.5 : 4;
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
        rows, unit, tookMs: 10, capped: false, startTime: opts.partial && category === 'INTER_VPC' ? undefined : START, endTime: END, queriedAt: END,
      });
    }
    if (url.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname === '/api/accounts') return json({ accounts: [{ accountId: '000000000000', alias: 'Fixture', isHost: true }] });
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

async function settledViewport(page: Page) {
  if (!await page.locator('.react-flow__viewport').count()) return;
  await page.waitForTimeout(500);
  let previous = '', stable = 0;
  await expect.poll(async () => {
    const sample = await page.locator('.react-flow').evaluate(flow => JSON.stringify({
      transform: flow.querySelector('.react-flow__viewport')?.getAttribute('style'),
      nodes: [...flow.querySelectorAll('.react-flow__node')].map(node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return [x, y, width, height];
      }),
    }));
    stable = sample === previous ? stable + 1 : 0;
    previous = sample;
    return stable;
  }, { intervals: [100, 150, 150], timeout: 5000 }).toBeGreaterThanOrEqual(2);
}

async function boundedCollection(page: Page) {
  const source = page.getByRole('region', { name: '서비스 소스' });
  const details = source.locator('details');
  await expect(details.locator('summary')).toContainText('48');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  const rows = details.locator('li');
  await expect(rows).toHaveCount(48);
  const geometry = await source.getByRole('alert').evaluate(panel => {
    const scroller = panel.querySelector('[data-source-details]')!;
    return { panelHeight: panel.getBoundingClientRect().height, detailHeight: scroller.getBoundingClientRect().height,
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  });
  expect(geometry.panelHeight).toBeLessThanOrEqual(page.viewportSize()!.height * 0.36 + 2);
  expect(geometry.detailHeight).toBeLessThanOrEqual(page.viewportSize()!.height * 0.18 + 2);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  await expect(rows.last()).toContainText('cap_reached');
  await noOverflow(page);
  return geometry;
}

test('desktop: combine traffic evidence, inspect a flow and change the applied metric', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1050 });
  const fixtureState = { completeServices: false };
  const calls = await fixtures(page, fixtureState);
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
  const panel = await boundedCollection(page);
  await writeFile(testInfo.outputPath('desktop-collection-geometry.json'), JSON.stringify(panel, null, 2));
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-collection-details.png'), fullPage: true });
  await page.getByRole('region', { name: '서비스 소스' }).locator('summary').click();
  // A fresh successful envelope, not a test-only completeness boolean, unlocks workload evidence.
  fixtureState.completeServices = true;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('region', { name: '서비스 소스' })).toContainText('최근 수집 성공');
  await expect(page.getByRole('region', { name: '서비스 소스' })).not.toContainText('이전 그래프를 표시합니다.');
  expect(calls.filter((u) => u.startsWith('/api/nfm/query'))).toHaveLength(0);
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('성공한 분류 7');
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  await expect(page.locator('[data-e2e-kind="construct"]')).toHaveCount(2);
  await noOverflow(page);
  await page.locator('.react-flow').scrollIntoViewIfNeeded();
  await settledViewport(page);
  const geometry = await page.locator('.react-flow').evaluate(flow => {
    const canvas = flow.getBoundingClientRect();
    const nodes = [...flow.querySelectorAll<HTMLElement>('.react-flow__node')];
    const primary = nodes.find(node => node.querySelector('[title]')?.getAttribute('title') === 'shop/frontend-a ↔ shop/orders-a')!;
    const parts = JSON.parse(primary.dataset.id!.slice('network:'.length));
    const group = nodes.filter(node => {
      // The complete fixture corroborates both configured targets and trace workloads.
      if (node.querySelector('[data-e2e-kind="target"], [data-e2e-kind="workload"]')) return true;
      if (!node.dataset.id?.startsWith('network:')) return false;
      const id = JSON.parse(node.dataset.id.slice('network:'.length));
      return ['connection', 'endpoint'].includes(id[1]) && id[2] === parts[2] && id[3] === parts[3];
    }).map(node => node.getBoundingClientRect());
    return {
      count: group.length,
      canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
      group: group.map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })),
      visible: group.every(rect => rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1
        && rect.top >= canvas.top - 1 && rect.bottom <= canvas.bottom + 1),
      visibleInViewport: group.every(rect => rect.left >= 0 && rect.right <= innerWidth
        && rect.top >= 0 && rect.bottom <= innerHeight),
      offsetX: (Math.min(...group.map(r => r.left)) + Math.max(...group.map(r => r.right)) - canvas.left - canvas.right) / 2,
      offsetY: (Math.min(...group.map(r => r.top)) + Math.max(...group.map(r => r.bottom)) - canvas.top - canvas.bottom) / 2,
    };
  });
  await writeFile(testInfo.outputPath('desktop-viewport-geometry.json'), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: testInfo.outputPath('desktop-overview.png'), fullPage: true });
  expect(geometry.count).toBe(7);
  expect(geometry.visible).toBe(true);
  expect(geometry.visibleInViewport).toBe(true);
  expect(Math.abs(geometry.offsetX)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.offsetY)).toBeLessThanOrEqual(2);

  await page.getByRole('combobox', { name: '목적지 분류', exact: true }).selectOption('AMAZON_S3');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(1);
  await page.locator('.react-flow__node').filter({ has: page.locator('[data-e2e-kind="connection"]') }).click();
  const detail = page.getByRole('region', { name: '선택한 노드 상세' });
  await expect(detail).toContainText('192.0.2.10');
  await expect(detail).toContainText('NatGateway:nat-demo');
  await expect(detail).toContainText('8 MB');
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-flow-detail.png'), fullPage: true });

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

test('mobile: graph and controls remain readable when one destination category fails', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page, { partial: true });
  await page.goto('/topology?view=e2e');
  const panel = await boundedCollection(page);
  await writeFile(testInfo.outputPath('mobile-collection-geometry.json'), JSON.stringify(panel, null, 2));
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-collection-details.png'), fullPage: true });
  await page.getByRole('region', { name: '서비스 소스' }).locator('summary').click();
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('부분 성공');
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('성공한 분류 6');
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('관측 구간이 미확인인 분류가 있어 부분 결과로 표시합니다.');
  await expect(page.getByRole('region', { name: '적용된 네트워크 조회' })).toContainText('INTER_REGION · 조회 실패');
  await expect(page.locator('body')).not.toContainText('fixture-query-credential');
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  await noOverflow(page);
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-partial.png'), fullPage: true });
  await page.locator('.react-flow').scrollIntoViewIfNeeded();
  await expect(page.locator('.react-flow')).toBeVisible();
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-graph.png'), fullPage: true });
});

test('member account: never fetch host observations into a selected member topology', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('awsops:scope', JSON.stringify({
    accounts: ['000000000001'], regions: '__all__', includeGlobal: true,
  })));
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.getByText(/서비스·NFM 통합 관측은 호스트 계정/)).toBeVisible();
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toHaveCount(0);
  expect(calls.filter((u) => u === '/api/nfm' || u.startsWith('/api/nfm/query') || u.startsWith('/api/graph'))).toEqual([]);
});

test('unavailable monitoring preserves the configured front-door graph', async ({ page }, testInfo) => {
  await fixtures(page, { unavailable: true });
  await page.goto('/topology?view=e2e');
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toBeDisabled();
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(1);
  await expect(page.locator('[data-e2e-kind="alb"]')).toHaveCount(1);
});

test('late host inventory cannot overwrite a newly selected member account', async ({ page }, testInfo) => {
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
    await route.fulfill({ json: { rows: rows.map(row => ({ ...row, account_id: member ? '000000000001' : 'self' })), run: run(rows.length) } });
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

test('same-page navigation and browser history keep the opt-in view consistent with the URL', async ({ page }, testInfo) => {
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await page.locator('a[href="/topology"]').first().click();
  await expect(page).toHaveURL(/\/topology$/);
  await expect(page.getByRole('heading', { name: 'Topology', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '네트워크 조회', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '서비스 + 네트워크 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Topology', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '서비스 + 네트워크', exact: true })).toBeVisible();
  expect(calls.filter((url) => url.startsWith('/api/nfm/query'))).toEqual([]);
});

for (const podsUnavailable of ['empty', 'failed'] as const) {
  test(`Endpoints-only membership cannot establish a remote workload when pods are ${podsUnavailable}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1050 });
    await fixtures(page, { podsUnavailable });
    await page.goto('/topology?view=e2e');
    await expect(page.getByRole('region', { name: '서비스 소스' })).toContainText('노드 5');
    if (podsUnavailable === 'failed') {
      await expect(page.getByRole('alert', { name: 'EKS 식별 상태' })).toContainText('cluster_unreadable');
      await settledViewport(page);
      await page.screenshot({ path: testInfo.outputPath('eks-unavailable.png'), fullPage: true });
    }
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

test('a same-IP ECS task from another subnet/VPC cannot name the configured target', async ({ page }, testInfo) => {
  await fixtures(page, { foreignEcs: true });
  await page.goto('/topology?view=e2e');
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(2);
  await expect(page.locator('[data-e2e-kind="target"]').filter({ hasText: 'foreign-ecs' })).toHaveCount(0);
  await expect(page.locator('[data-e2e-kind="target"]').filter({ hasText: '10.0.1.10' })).toHaveCount(1);
});

test('region/global scope changes reach inventory requests and remove excluded global resources', async ({ page }, testInfo) => {
  const calls = await fixtures(page);
  await page.goto('/topology?view=e2e&cluster=eks%3Ademo');
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(1);
  await expect(page).toHaveURL(/cluster=/);
  await page.evaluate(() => {
    localStorage.setItem('awsops:scope', JSON.stringify({
      accounts: ['self'], regions: ['us-east-1'], includeGlobal: false,
    }));
    window.dispatchEvent(new CustomEvent('awsops:scopechange'));
  });
  await expect(page.locator('[data-e2e-kind="cloudfront"]')).toHaveCount(0);
  await expect(page).not.toHaveURL(/cluster=/);
  await expect(page.locator('[data-e2e-kind="alb"]')).toHaveCount(1);
  expect(calls.some((value) => {
    const url = new URL(value, 'http://localhost');
    return url.pathname === '/api/inventory/alb'
      && url.searchParams.get('regions') === 'us-east-1' && url.searchParams.get('includeGlobal') === '0';
  })).toBe(true);
});

test('construct focus keeps its connection endpoints without transit into other flows', async ({ page }) => {
  await fixtures(page);
  await page.goto('/topology?view=e2e');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  await page.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }).fill('NatGateway:nat-demo');
  await page.getByRole('button', { name: '선택: NatGateway:nat-demo', exact: true }).click();
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(1);
  await expect(page.locator('[data-e2e-kind="endpoint"]')).toHaveCount(2);
  await expect(page.getByTestId('e2e-network-edge-count')).toHaveText('2');
});

test('same-scope inventory refresh retains configuration with notice but never across accounts', async ({ page }, testInfo) => {
  await fixtures(page);
  await page.goto('/topology?view=e2e');
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(2);
  await page.route('**/api/inventory/**', route =>
    route.fulfill({ status: 503, json: { status: 'error', message: 'fixture unavailable' } }));
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByText('조회 실패로 이전 결과를 표시합니다.')).toBeVisible();
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(2);
  await settledViewport(page);
  await page.screenshot({ path: testInfo.outputPath('retained-configuration.png'), fullPage: true });
  await page.evaluate(() => {
    localStorage.setItem('awsops:scope', JSON.stringify({
      accounts: ['000000000001'], regions: '__all__', includeGlobal: true,
    }));
    window.dispatchEvent(new CustomEvent('awsops:scopechange'));
  });
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(0);
  await expect(page.getByText('조회 실패로 이전 결과를 표시합니다.')).toHaveCount(0);
});

for (const [lang, title, query, quality, onboarding] of [
  ['ko', '서비스 + 네트워크', '네트워크 조회', '부분 수집', '연결되지 않은 EKS 클러스터 범위의 IP 소유권은 미확인입니다.'],
  ['en', 'Service + Network', 'Query network', 'Partial collection', 'IP ownership is unverified in scopes of EKS clusters that are not connected.'],
  ['zh', '服务 + 网络', '查询网络', '部分采集', '未连接的 EKS 集群范围内，IP 归属仍未确认。'],
  ['ja', 'サービス + ネットワーク', 'ネットワークを照会', '部分収集', '未接続の EKS クラスター範囲では IP の所有関係は未確認です。'],
]) {
  test(`localized routed observations and collection quality: ${lang}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: lang === 'ja' ? 390 : 1440, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('awsops-lang', value), lang);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const calls = await fixtures(page, { partialEks: true });
    await page.goto('/topology?view=e2e');
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText(quality, { exact: false }).first()).toBeVisible();
    const gap = page.getByRole('alert').filter({ hasText: 'cluster_not_connected' });
    await expect(gap).toBeVisible();
    await expect(gap).toContainText(onboarding);
    await expect(gap).not.toContainText('cluster_unreadable');
    await expect(page.locator('[data-e2e-kind="target"]').filter({ hasText: 'shop/frontend' })).toHaveCount(1);
    expect(calls.filter(url => url.startsWith('/api/nfm/query'))).toEqual([]);
    await page.getByRole('button', { name: query, exact: true }).click();
    await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
    await noOverflow(page);
    await settledViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`locale-${lang}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const view of ['flow', 'e2e']) {
  test(`inventory failure is explicit rather than an empty environment: ${view}`, async ({ page }, testInfo) => {
    await fixtures(page);
    await page.route('**/api/inventory/**', route =>
      route.fulfill({ status: 503, json: { status: 'error', message: 'fixture unavailable' } }));
    await page.goto(`/topology?view=${view}`);
    await expect(page.getByText(/route53: invalid inventory response/).first()).toBeVisible();
    await expect(page.getByText(/그래프로 그릴 리소스가 없습니다/)).toHaveCount(0);
    await noOverflow(page);
    await settledViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`inventory-failure-${view}.png`), fullPage: true });
    await page.unroute('**/api/inventory/**');
    const gap = view === 'flow' ? 'ecs_task' : 'subnet';
    await page.route(`**/api/inventory/${gap}?*`, route => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
      return route.fulfill(gap === 'ecs_task' ? { status: 503, json: { status: 'error' } }
        : { json: { rows: Array.from({ length: 500 }, (_, i) => ({
          account_id: 'self', resource_id: `subnet-${offset + i}`, region: 'us-east-1', data: { vpc_id: 'vpc-demo' },
        })), run: run(10000), consistency: 'statement-snapshot' } });
    });
    await page.reload();
    await expect(page.getByText('인벤토리 조회 실패 또는 행 수 제한으로 IP 소유권을 확인할 수 없습니다.')).toBeVisible();
    await (view === 'flow' ? page.getByPlaceholder('리소스 이름 검색…')
      : page.getByRole('searchbox', { name: '서비스 또는 리소스 검색' })).fill('ambiguous:');
    await page.getByRole('button', { name: /10\.0\.1\.10/ }).click();
    await expect(page.getByText(`${gap}_inventory_incomplete`, { exact: true })).toBeVisible();
    await page.getByText(`${gap}_inventory_incomplete`, { exact: true }).scrollIntoViewIfNeeded();
    await settledViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`ownership-gap-${view}.png`), fullPage: true });
  });
}


test('grouped targets show member evidence and qualify their capture time', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1050 });
  await fixtures(page, { completeServices: true, grouped: true });
  await page.goto('/topology?view=e2e');
  await expect(page.locator('[data-e2e-kind="target"]')).toHaveCount(1);
  await page.getByRole('searchbox').fill('shop/frontend ×2');
  await page.getByRole('button', { name: '선택: shop/frontend ×2', exact: true }).click();
  const detail = page.getByRole('region', { name: '선택한 노드 상세' });
  await expect(detail).toContainText('여러 타깃을 묶은 구성 기록입니다.');
  await expect(detail.getByText('frontend-a', { exact: true })).toHaveCount(0);
  await expect(detail).toContainText('10.0.1.10 · shop/frontend-a');
  await expect(detail).toContainText('10.0.2.10 · shop/frontend-b');
  await expect(detail).toContainText('대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.');
  await page.screenshot({ path: testInfo.outputPath('desktop-grouped-target.png'), fullPage: true });
});

test('large configuration cannot starve observations and search reaches nodes beyond the display cap', async ({ page }, testInfo) => {
  await fixtures(page, { completeServices: true, crowded: true });
  await page.goto('/topology?view=e2e');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
  expect(await page.locator('.react-flow__node').count()).toBeLessThanOrEqual(350);
  await page.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }).fill('crowded-alb-399');
  await page.getByRole('button', { name: '선택: crowded-399.example.test', exact: true }).click();
  await expect(page.getByRole('region', { name: '선택한 노드 상세' })).toContainText('crowded-399.example.test');
  await page.getByRole('checkbox', { name: '구성 관계', exact: true }).uncheck();
  await expect(page.getByRole('region', { name: '선택한 노드 상세' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }).fill('');
  await expect(page.locator('[data-e2e-kind="connection"]')).toHaveCount(3);
});

test('the 25th grouped member can correlate without expanding the capped display list', async ({ page }, testInfo) => {
  await fixtures(page, { completeServices: true, groupedCount: 25 });
  await page.goto('/topology?view=e2e');
  await page.getByRole('combobox', { name: '목적지 분류', exact: true }).selectOption('AMAZON_S3');
  await page.getByRole('button', { name: '네트워크 조회', exact: true }).click();
  await expect(page.getByText('구성에서 확인된 Pod 식별자', { exact: true })).toHaveCount(1);
  await page.getByRole('searchbox').fill('frontend-25');
  await page.getByRole('button', { name: '선택: shop/frontend-25', exact: true }).click();
  await expect(page.getByRole('region', { name: '선택한 노드 상세' })).toContainText('demo / shop / frontend-25');
});
