import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// UI-only fixtures: no credentials, model invocations, live telemetry or AWS writes.
const REGION = 'ap-northeast-2', HOST = '111122223333', NOW = '2026-11-10T09:00:00Z';
const run = { status: 'succeeded', finished_at: NOW, last_success_at: NOW, row_count: 200 };
const lbArn = (i: number) => `arn:aws:elasticloadbalancing:${REGION}:${HOST}:loadbalancer/app/shop-${i}/id${i}`;
const row = (resource_id: string, data: Record<string, unknown>, region = REGION) =>
  ({ resource_id, data, region, account_id: 'self', captured_at: NOW });
const inventory: Record<string, ReturnType<typeof row>[]> = {
  vpc: Array.from({ length: 3 }, (_, i) => row(`vpc-${i}`, { name: `application-vpc-${i}`, cidr_block: `10.${i}.0.0/16` })),
  internet_gateway: Array.from({ length: 3 }, (_, i) => row(`igw-${i}`, {
    name: `application-igw-${i}`, attachments: [{ VpcId: `vpc-${i}` }],
  })),
  subnet: Array.from({ length: 24 }, (_, i) => row(`subnet-${i}`, {
    name: `application-subnet-${i}`, vpc_id: `vpc-${Math.floor(i / 8)}`, cidr_block: `10.${Math.floor(i / 8)}.${i}.0/24`,
  })),
  ec2: Array.from({ length: 24 }, (_, i) => row(`i-${i.toString(16).padStart(17, '0')}`, {
    name: `application-instance-${i}`, vpc_id: `vpc-${Math.floor(i / 8)}`, subnet_id: `subnet-${i}`,
    instance_type: 'm7g.large', instance_state: 'running',
  })),
  cloudfront: Array.from({ length: 24 }, (_, i) => row(`distribution-${i}`, {
    domain_name: `shop-${i}.cloudfront.net`, aliases: [`shop-${i}.example.test`],
    origins: [{ DomainName: `shop-${i}.elb.amazonaws.com` }],
  }, 'global')),
  alb: Array.from({ length: 24 }, (_, i) => row(`alb-${i}`, {
    name: `shop-alb-${i}`, arn: lbArn(i), dns_name: `shop-${i}.elb.amazonaws.com`,
    vpc_id: `vpc-${Math.floor(i / 8)}`, availability_zones: [{ SubnetId: `subnet-${i}` }],
  })),
  target_group: Array.from({ length: 24 }, (_, i) => row(`tg-${i}`, {
    target_group_name: `shop-targets-${i}`, target_type: 'instance', vpc_id: `vpc-${Math.floor(i / 8)}`,
    load_balancer_arns: [lbArn(i)],
    target_health_descriptions: [{ Target: { Id: `i-${i.toString(16).padStart(17, '0')}`, Port: 8080 }, TargetHealth: { State: 'healthy' } }],
  })),
};
const trace = {
  captured_at: NOW,
  collection: { status: 'partial', orphanSpans: 27, stale: false, readStatus: 'ok',
    attempted_at: NOW, captured_at: NOW, sources: [{ sourceId: 'fixture:trace', status: 'partial' }] },
  nodes: [
    { id: 'checkout', kind: 'service', label: 'checkout', meta: { environment: 'production', cluster: 'demo', namespace: 'shop', sourceId: 'fixture:trace' } },
    { id: 'orders', kind: 'service', label: 'orders', meta: { environment: 'production', cluster: 'demo', namespace: 'shop', sourceId: 'fixture:trace' } },
    { id: 'db', kind: 'db', label: 'postgres:orders', meta: { environment: 'production', host: 'orders-db.internal' } },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `other-${i}`, kind: 'service', label: `other-service-${i}`, meta: { environment: 'production', sourceId: `fixture:${i}` },
    })),
    { id: 'workload', kind: 'workload', label: 'shop/checkout', meta: { environment: 'production', cluster: 'demo' } },
  ],
  edges: [{ source: 'checkout', target: 'orders', rel: 'calls' }, { source: 'orders', target: 'db', rel: 'queries' },
    { source: 'checkout', target: 'workload', rel: 'runs_on' },
    ...Array.from({ length: 30 }, (_, i) => ({ source: `other-${i}`, target: 'db', rel: 'queries' }))],
};
const network = {
  level: 'fleet', capturedAt: NOW, truncated: false,
  omitted: { inactive: 0, conflicting: 0, resourcesCapped: 0 },
  nodes: [
    { id: 'account', kind: 'account', parent: null, label: 'Host', accountId: HOST, region: '' },
    { id: 'region', kind: 'region', parent: 'account', label: REGION, accountId: HOST, region: REGION },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `vpc-${i}`, kind: 'vpc', parent: 'region', label: `network-vpc-${i}`,
      accountId: HOST, region: REGION, vpcKey: `${HOST}/${REGION}/vpc-${i}`, sub: `10.${i}.0.0/16`,
    })),
    { id: 'tgw', kind: 'tgw', parent: 'region', label: 'network-hub', accountId: HOST, region: REGION },
  ],
  edges: [0, 1].map(i => ({ id: `attachment-${i}`, kind: 'tgw', source: 'tgw', target: `vpc-${i}`, recordId: `attachment-${i}`, crossAccount: false })),
};
const answer = '최근 관측된 5분 구간의 값입니다. 마지막 행은 부분 구간입니다.\n\n'
  + '| 시각(UTC) | 요청 수 | 에러율(%) | p99(ms) | 에러율 그래프 |\n| --- | --- | --- | --- | --- |\n'
  + Array.from({ length: 12 }, (_, i) => `| ${String(8 + Math.floor((30 + i * 5) / 60)).padStart(2, '0')}:${String((30 + i * 5) % 60).padStart(2, '0')}${i === 11 ? '*' : ''} | ${5382 + i} | ${(0.223 + i * 0.003).toFixed(3)} | ${(5.68 + i * 0.4).toFixed(2)} | ■■■ |`).join('\n');

async function fixtures(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('awsops-lang', 'ko');
    localStorage.setItem('awsops_chat_thread', 'fixture');
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/graph') return route.fulfill({ json: trace });
    if (url.pathname === '/api/accounts') return route.fulfill({ json: {
      accounts: [{ accountId: HOST, alias: 'Host', isHost: true, enabled: true }],
    } });
    if (url.pathname.startsWith('/api/inventory/')) {
      const type = url.pathname.split('/').at(-1)!;
      return route.fulfill({ json: { rows: inventory[type] ?? [], run, consistency: 'statement-snapshot' } });
    }
    if (url.pathname === '/api/network-topology') return route.fulfill({ json: network });
    if (url.pathname === '/api/chat/threads/fixture') return route.fulfill({ json: {
      thread: { id: 'fixture', title: 'Service metrics', sessionId: 'fixture' },
      messages: [{ role: 'assistant', content: answer, gateway: 'observability' }],
    } });
    return route.fulfill({ json: { rows: [], accounts: [], clusters: [], region: REGION, regions: [], threads: [], signals: [], cards: [] } });
  });
  return errors;
}

async function screenshot(page: Page, name: string, width: number) {
  const target = process.env.AWSOPS_TOPOLOGY_ARTIFACTS;
  if (!target) return;
  await mkdir(target, { recursive: true });
  await page.screenshot({ path: join(target, `${name}-${width}.png`), fullPage: true });
  const canvas = page.locator('.react-flow');
  if (await canvas.count() === 1) {
    await canvas.screenshot({ path: join(target, `${name}-canvas-${width}.png`) });
  }
}

test('request paths refit after resizing an asynchronously loaded canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors = await fixtures(page);
  await page.goto('/topology');
  await page.getByRole('button', { name: /경로 보기 →/ }).first().click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect.poll(async () => {
      const first = await page.locator('.react-flow__node').nth(0).boundingBox();
      const second = await page.locator('.react-flow__node').nth(1).boundingBox();
      return width === 390 ? second!.y - first!.y - first!.height : second!.x - first!.x - first!.width;
    }).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

for (const width of [1440, 768, 390]) {
  test(`readable service map and evidence at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const errors = await fixtures(page);
    await page.goto('/topology/services');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.getByText('부모 또는 링크 미확인 스팬: 27')).toBeVisible();
    await expect(page.locator('.react-flow__node').filter({ hasText: 'other-service-' })).toHaveCount(0);
    await expect(page.locator('.react-flow__node').filter({ hasText: 'shop/checkout' })).toHaveCount(0);
    await expect.poll(async () => (await page.locator('.react-flow__node').first().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(180);
    await screenshot(page, 'services', width);
    await page.getByRole('checkbox', { name: '워크로드 표시' }).check();
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await page.getByRole('button', { name: '전체 그래프', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(34);
    await page.getByRole('textbox', { name: '서비스 검색' }).fill('missing-resource');
    await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
  test(`entry-point and VPC selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const errors = await fixtures(page);
    await page.goto('/topology');
    await expect.poll(async () => (await page.getByRole('heading', { name: 'Topology', exact: true }).boundingBox())?.width ?? 0).toBeGreaterThan(100);
    await expect(page.getByRole('button', { name: /경로 보기 →/ }).first()).toBeVisible();
    await screenshot(page, 'entry-overview', width);
    await page.getByRole('button', { name: /경로 보기 →/ }).first().click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    if (width === 1440) {
      expect((await page.getByRole('heading', { name: 'Topology', exact: true }).locator('xpath=ancestor::header').boundingBox())!.height).toBeLessThan(240);
    }
    if (width === 390) {
      await expect.poll(async () => {
        const first = await page.locator('.react-flow__node').nth(0).boundingBox();
        const second = await page.locator('.react-flow__node').nth(1).boundingBox();
        return second!.y - first!.y - first!.height;
      }).toBeGreaterThan(0);
    }
    await screenshot(page, 'request-path', width);
    await page.goto('/topology/infra?view=map');
    await expect(page.getByRole('button', { name: /application-vpc-0/ })).toBeVisible();
    await screenshot(page, 'vpc-overview', width);
    await page.getByRole('button', { name: /application-vpc-0/ }).click();
    await expect(page.locator('.react-flow__node').filter({ hasText: 'application-igw-0' })).toHaveCount(1);
    await expect(page.locator('.react-flow__node').filter({ hasText: 'application-vpc-1' })).toHaveCount(0);
    // A subnet focus must not expand sibling subnets via its common VPC.
    await page.locator('.react-flow__node').filter({ hasText: 'application-subnet-0' }).click();
    await expect(page.locator('.react-flow__node').filter({ hasText: 'application-subnet-1' })).toHaveCount(0);
    await screenshot(page, 'infra-path', width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
  test(`network search and metric charts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const errors = await fixtures(page);
    await page.goto('/topology/network');
    await expect(page.locator('.react-flow__node').filter({ hasText: 'network-vpc-' })).toHaveCount(12);
    await page.getByRole('checkbox', { name: '연결된 리소스만' }).check();
    await expect(page.locator('.react-flow__node').filter({ hasText: 'network-vpc-' })).toHaveCount(2);
    await screenshot(page, 'network', width);
    await page.getByRole('textbox', { name: '네트워크 리소스 검색' }).fill('missing-resource');
    await expect(page.getByText('선택한 표시 조건에 맞는 리소스가 없습니다.')).toBeVisible();
    await page.goto('/assistant');
    await expect(page.getByTestId('assistant-table-trends')).toBeVisible();
    await expect(page.locator('.recharts-wrapper')).toHaveCount(3);
    await screenshot(page, 'metric-charts', width);
    await page.getByRole('button', { name: '표', exact: true }).click();
    await expect(page.locator('table').getByText('09:25*')).toBeVisible();
    await expect(page.locator('.recharts-wrapper')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
