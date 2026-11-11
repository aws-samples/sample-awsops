import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only browser fixtures: exercise real layout without AWS, models or writes.
const reports = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1, tier: 'deep', status: 'succeeded', title: `운영 진단 ${i + 1}`,
  created_at: '2026-11-11T00:00:00Z', can_edit: false,
}));
const markdown = '# AWS 운영 진단\n\n' + Array.from({ length: 6 }, (_, i) =>
  `## Pillar ${i + 1}\n\n` + Array.from({ length: 18 }, (_, j) =>
    `관측 근거 ${j + 1}: 서비스 연결과 사용률을 검토한 진단 내용입니다. 지표의 수집 범위와 기간을 확인합니다.\n\n`).join(''),
).join('\n');

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
    if (path === '/api/diagnosis') return route.fulfill({ json: { reports } });
    if (/^\/api\/diagnosis\/\d+$/.test(path)) {
      const report = reports.find(r => r.id === Number(path.split('/').at(-1)));
      return route.fulfill({ json: { report, markdown } });
    }
    if (path === '/api/diagnosis/intent') return route.fulfill({ json: { intents: [] } });
    if (path === '/api/chat/threads') return route.fulfill({ json: { threads: [
      { id: 'fixture', title: '연결 관계 점검', updatedAt: '2026-11-11T00:00:00Z' },
    ] } });
    return route.fulfill({ json: {
      schedules: [], subscribers: [], enabled: false, rows: [], accounts: [],
      clusters: [], regions: [], threads: [], signals: [], cards: [],
    } });
  });
  return errors;
}

async function drag(page: Page, handle: Locator, delta: number) {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 40, { steps: 8 });
  await page.mouse.up();
}

async function screenshot(page: Page, name: string) {
  const dir = process.env.AWSOPS_SIDEBAR_ARTIFACTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

async function noOuterScroll(page: Page) {
  await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

test('assistant sidebar drag, collapse and reload preserve the conversation draft and preferences', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixtures(page);
  await page.goto('/assistant');
  const handle = page.getByRole('separator', { name: '대화 목록 너비 조절' });
  await expect(handle).toHaveAttribute('aria-valuenow', '256');
  await drag(page, handle, -64);
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  const composer = page.getByRole('combobox');
  await composer.fill('인스턴스와 DB 연결을 확인');
  const search = page.getByRole('textbox', { name: '대화 내용 검색' });
  await expect(page.locator('#assistant-desktop-threads')).not.toContainText('Invalid Date');
  await search.fill('database');
  await page.getByRole('button', { name: '대화 목록 닫기' }).click();
  await expect(page.locator('#assistant-desktop-threads')).toBeHidden();
  await expect(composer).toHaveValue('인스턴스와 DB 연결을 확인');
  await page.getByRole('button', { name: '대화 목록 열기' }).click();
  await expect(search).toHaveValue('database');
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  await screenshot(page, 'assistant-desktop');
  await page.getByRole('button', { name: '대화 목록 닫기' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '대화 목록 열기' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '대화 목록 열기' }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  await noOuterScroll(page);
  expect(errors).toEqual([]);
});

test('diagnosis sidebar and report scroll independently, including overscroll and table of contents', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixtures(page);
  await page.goto('/ai-diagnosis');
  const report = page.getByRole('region', { name: '진단 리포트', exact: true });
  const sidebar = page.getByRole('region', { name: '진단 설정 및 리포트' });
  await expect(report.getByRole('button', { name: 'Pillar 1' }).first()).toBeVisible();
  const reportBox = (await report.boundingBox())!;
  await page.mouse.move(reportBox.x + 100, reportBox.y + 100);
  await page.mouse.wheel(0, 550);
  await expect.poll(() => report.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
  expect(await sidebar.evaluate(el => el.scrollTop)).toBe(0);
  await report.evaluate(el => { el.scrollTop = 0; });
  const sidebarBox = (await sidebar.boundingBox())!;
  await page.mouse.move(sidebarBox.x + 100, sidebarBox.y + 150);
  await page.mouse.wheel(0, 450);
  await expect.poll(() => sidebar.evaluate(el => el.scrollTop)).toBeGreaterThan(200);
  expect(await report.evaluate(el => el.scrollTop)).toBe(0);
  const sidebarTop = await sidebar.evaluate(el => el.scrollTop);
  await page.getByRole('navigation', { name: '리포트 목차' }).getByRole('button', { name: 'Pillar 6' }).click();
  await expect.poll(() => report.evaluate(el => el.scrollTop)).toBeGreaterThan(1000);
  expect(await sidebar.evaluate(el => el.scrollTop)).toBe(sidebarTop);
  await sidebar.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.move(sidebarBox.x + 100, sidebarBox.y + 150);
  await page.mouse.wheel(0, 800);
  await noOuterScroll(page);
  await report.evaluate(el => { el.scrollTop = 0; });
  await sidebar.evaluate(el => { el.scrollTop = 0; });
  await report.evaluate(el => { el.scrollTop = 600; });
  await page.getByRole('button', { name: /운영 진단 2\s/ }).click();
  await expect(report.getByRole('heading', { name: '운영 진단 2', exact: true })).toBeVisible();
  await expect.poll(() => report.evaluate(el => el.scrollTop)).toBe(0);
  await screenshot(page, 'diagnosis-desktop');
  expect(errors).toEqual([]);
});

test('diagnosis collapse retains settings and report while sidebar width persists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixtures(page);
  await page.goto('/ai-diagnosis');
  await expect(page.getByRole('region', { name: '진단 리포트', exact: true }).getByText('Pillar 1', { exact: true }).first()).toBeVisible();
  await page.getByRole('combobox', { name: '진단 티어' }).selectOption('deep');
  const handle = page.getByRole('separator', { name: '진단 사이드바 너비 조절' });
  await drag(page, handle, -64);
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  await page.getByRole('button', { name: '진단 사이드바 닫기' }).click();
  await expect(page.locator('#diagnosis-sidebar')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '리포트 목차' })).toBeVisible();
  await screenshot(page, 'diagnosis-collapsed');
  await page.getByRole('button', { name: '진단 사이드바 열기' }).click();
  await expect(page.getByRole('combobox', { name: '진단 티어' })).toHaveValue('deep');
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  await page.getByRole('button', { name: '진단 사이드바 닫기' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '진단 사이드바 열기' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '진단 사이드바 열기' }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', '192');
  expect(errors).toEqual([]);
});

test('a narrow desktop keeps the report usable at the widest sidebar setting', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const errors = await fixtures(page);
  await page.goto('/ai-diagnosis');
  const handle = page.getByRole('separator', { name: '진단 사이드바 너비 조절' });
  await handle.focus();
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '384');
  await expect(page.getByRole('navigation', { name: '리포트 목차' })).toBeHidden();
  const report = page.getByRole('region', { name: '진단 리포트', exact: true });
  await expect(report.getByRole('button', { name: 'Pillar 1' })).toBeVisible();
  expect((await report.boundingBox())!.width).toBeGreaterThan(300);
  await noOuterScroll(page);
  expect(errors).toEqual([]);
});

for (const width of [390, 768]) {
  test(`mobile and tablet ${width}px keep reports visible and open sidebars as overlays`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await fixtures(page);
    await page.goto('/ai-diagnosis');
    await expect(page.locator('#diagnosis-sidebar')).toBeHidden();
    const report = page.getByRole('region', { name: '진단 리포트', exact: true });
    await expect(report.getByRole('button', { name: 'Pillar 1' })).toBeVisible();
    await page.getByRole('button', { name: '진단 사이드바 열기' }).click();
    const dialog = page.getByRole('dialog', { name: '진단 설정 및 리포트' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('button', { name: '진단 사이드바 닫기' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await expect(page.getByRole('combobox', { name: '진단 티어' })).toBeVisible();
    await page.getByRole('combobox', { name: '진단 티어' }).focus();
    await page.getByRole('combobox', { name: '진단 티어' }).selectOption('deep');
    await screenshot(page, `diagnosis-overlay-${width}`);
    await page.getByRole('button', { name: /운영 진단 2\s/ }).click();
    await expect(page.locator('#diagnosis-sidebar')).toBeHidden();
    await page.getByRole('button', { name: '진단 사이드바 열기' }).click();
    await expect(page.getByRole('combobox', { name: '진단 티어' })).toHaveValue('deep');
    await page.keyboard.press('Escape');
    await expect(page.locator('#diagnosis-sidebar')).toBeHidden();
    await expect(page.getByRole('button', { name: '진단 사이드바 열기' })).toBeFocused();
    const box = (await report.boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + 150);
    await page.mouse.wheel(0, 450);
    await expect.poll(() => report.evaluate(el => el.scrollTop)).toBeGreaterThan(200);
    await noOuterScroll(page);
    await report.evaluate(el => { el.scrollTop = 0; });
    await screenshot(page, `diagnosis-${width}`);
    await page.goto('/assistant');
    await page.getByRole('button', { name: '대화 목록 열기' }).click();
    await expect(page.getByRole('dialog', { name: '대화 목록' })).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('button', { name: '대화 목록 닫기' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '대화 목록 열기' })).toBeFocused();
    await page.getByRole('button', { name: '대화 목록 열기' }).click();
    await expect(page.getByRole('button', { name: '대화 목록 닫기' })).toBeVisible();
    await page.getByRole('button', { name: '대화 목록 닫기' }).click();
    await expect(page.getByRole('combobox')).toBeVisible();
    await noOuterScroll(page);
    expect(errors).toEqual([]);
  });
}
