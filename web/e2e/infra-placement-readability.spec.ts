import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const meta = { inventoryAccount: 'self', region: 'ap-northeast-2' };
const resources = Array.from({ length: 96 }, (_, i) => ({
  id: `resource-${i}`, kind: i % 3 === 0 ? 'rds' : 'ec2', label: `application-resource-${i}`,
  meta: { ...meta, resourceId: `resource-${i}` },
}));
const graph = {
  nodes: [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `vpc-${i}`, kind: 'vpc', label: `application-vpc-${i}`, meta: { ...meta, resourceId: `vpc-${i}` } })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `subnet-${i}`, kind: 'subnet', label: `application-subnet-${i}`, meta })),
    { id: 'sg-shared', kind: 'sg', label: 'shared-security-group', meta },
    ...resources,
  ],
  edges: resources.flatMap((r, i) => [
    { source: r.id, target: `vpc-${Math.floor(i / 32)}`, rel: 'infra:in_vpc' },
    { source: r.id, target: `subnet-${Math.floor(i / 8)}`, rel: 'infra:in_subnet' },
    { source: r.id, target: 'sg-shared', rel: 'infra:uses_sg' },
  ]),
  captured_at: '2026-11-11T00:00:00Z',
  collection: { status: 'partial', stale: false, readStatus: 'ok', sources: [
    { sourceId: 'inventory:ec2', status: 'partial', scope: 'aggregate', reasons: ['cap_reached'] },
  ] },
};

async function fixtures(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('awsops-lang', 'ko'));
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') {
      errors.push(`Unexpected request method: ${route.request().method()}`);
      return route.abort();
    }
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/graph' ? graph : {
      accounts: [], rows: [], clusters: [], regions: [], threads: [], signals: [], cards: [],
    } });
  });
  return errors;
}

async function screenshot(page: Page, name: string) {
  const dir = process.env.AWSOPS_INFRA_ARTIFACTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

async function readableCards(page: Page) {
  await expect.poll(() => page.locator('.react-flow__node').first().evaluate(el =>
    parseFloat(getComputedStyle(el).fontSize) * el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth,
  )).toBeGreaterThanOrEqual(12);
  await expect.poll(async () => {
    const canvas = await page.locator('.react-flow').boundingBox();
    return page.locator('.react-flow__node').evaluateAll((elements, box) => elements.every(el => {
      const r = el.getBoundingClientRect();
      return r.x >= box!.x && r.y >= box!.y && r.right <= box!.x + box!.width && r.bottom <= box!.y + box!.height;
    }), canvas);
  }).toBe(true);
}

test('placement graph shows readable pages and keeps exact saved context and collection warnings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixtures(page);
  await page.goto('/topology/infra');
  await expect(page.getByRole('combobox', { name: '배치 그래프 VPC' })).toHaveValue('vpc-0');
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await expect(page.getByRole('alert').filter({ hasText: '부분 수집' })).toBeVisible();
  await expect(page.getByText('표시 리소스 4 / 32')).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__node').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(210);
  await readableCards(page);
  await screenshot(page, 'infra-placement-desktop');
  await page.getByRole('button', { name: '다음 리소스' }).click();
  await expect(page.locator('[data-id="resource-0"]')).toHaveCount(0);
  await expect(page.locator('[data-id="resource-4"]')).toHaveCount(1);
  await page.getByRole('checkbox', { name: '보안 그룹 연결 표시' }).check();
  await expect(page.locator('[data-id="sg-shared"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  // A shared SG must not pull the other VPCs or their sibling resources into this page.
  await expect(page.locator('[data-id="resource-40"]')).toHaveCount(0);
  await page.getByRole('combobox', { name: '배치 그래프 VPC' }).selectOption('vpc-2');
  await expect(page.locator('[data-id="resource-64"]')).toHaveCount(1);
  await page.getByRole('combobox', { name: '배치 그래프 서브넷' }).selectOption('subnet-10');
  await expect(page.locator('[data-id="resource-80"]')).toHaveCount(1);
  await expect(page.locator('[data-id="resource-64"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [390, 768]) {
  test(`placement search at ${width}px refits at a readable size without horizontal page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const errors = await fixtures(page);
    await page.goto('/topology/infra');
    await expect(page.locator('.react-flow__node')).toHaveCount(width === 390 ? 3 : 6);
    await readableCards(page);
    if (width === 390) {
      const canvas = (await page.locator('.react-flow').boundingBox())!;
      const resource = (await page.locator('[data-id="resource-0"]').boundingBox())!;
      for (const edge of await page.locator('.react-flow__edge-path').all()) {
        const bounds = (await edge.boundingBox())!;
        expect(bounds.width).toBeGreaterThan(8);
        expect(bounds.x).toBeGreaterThanOrEqual(resource.x + resource.width - 1);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.x + canvas.width);
      }
    }
    await screenshot(page, `infra-placement-initial-${width}`);
    if (width === 390) {
      await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await screenshot(page, 'infra-placement-mobile-canvas');
      await page.locator('main').evaluate(el => { el.scrollTop = 0; });
    }
    await page.getByPlaceholder('검색 (id · 이름 · IP · 타입)…').fill('application-resource-15');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await readableCards(page);
    await expect.poll(async () => {
      const r = await page.locator('[data-id="resource-15"]').boundingBox();
      const subnet = await page.locator('[data-id="subnet-1"]').boundingBox();
      return width === 390 ? subnet!.y - r!.y : subnet!.x - r!.x;
    }).toBeGreaterThan(100);
    await expect.poll(() => page.locator('[data-id="resource-15"]').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(210);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, `infra-placement-${width}`);
    // The initial VPC choice must not hide search hits in a different VPC.
    await page.getByPlaceholder('검색 (id · 이름 · IP · 타입)…').fill('application-resource-79');
    await expect(page.getByRole('combobox', { name: '배치 그래프 VPC' })).toHaveValue('');
    await expect(page.locator('[data-id="resource-79"]')).toHaveCount(1);
    await expect(page.locator('[data-id="vpc-2"]')).toHaveCount(1);
    await readableCards(page);
    expect(errors).toEqual([]);
  });
}
