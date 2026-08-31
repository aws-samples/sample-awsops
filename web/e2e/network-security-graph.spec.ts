import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Ad-hoc Playwright verification for the SG usage/rules + network-path-check pages (see
// docs/superpowers/specs/2026-08-13-network-path-check-design.md and
// docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md, both of which call for
// desktop+mobile screenshots showing no overlap / readable checklist states).
//
// IMPORTANT — sandbox has no Aurora and no Cognito session, so every `/api/*` call from these pages
// gets a real 401 from verifyUser() (web/lib/auth.ts returns null before touching the DB when there
// is no cookie) rather than a DB error. That means:
//   - shell/nav/page bodies render fully — this we verify with a real browser end to end.
//   - the PolicyGraph canvas (`[data-testid="policy-graph"]`) only mounts once a row/run is selected
//     from fetched data, which never arrives here (401 before any rows exist to click). Confirmed by
//     reading the page source in `web/app/network/security-groups/usage/page.tsx`,
//     `web/app/network/security-groups/rules/page.tsx`, and `web/app/network-paths/page.tsx` — the
//     canvas is inside `{selected && graph && ...}` / `{runDetail && graphResult && ...}`, both of
//     which require API data. So the canvas-nonzero-bbox assertion cannot be exercised with a live
//     browser in this environment; that invariant is instead covered by the existing jsdom suite at
//     web/components/graph/PolicyGraph.test.tsx (renders the real PolicyGraph component against a
//     fixture DTO and asserts the testid mounts + node box dimensions), which we do NOT duplicate here.
const SCREENSHOT_DIR = path.join(__dirname, '.screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const PAGES = [
  { path: '/inventory/security_group', name: 'inventory-security-group' },
  { path: '/network/security-groups/rules', name: 'sg-rules' },
  { path: '/network/security-groups/usage', name: 'sg-usage' },
  { path: '/network-paths', name: 'network-paths' },
];

const DESKTOP = { width: 1920, height: 1080 };
const MOBILE = { width: 375, height: 812 };

async function checkNoHorizontalOverflow(page: Page, viewportWidth: number) {
  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  // Small tolerance for scrollbar/subpixel rounding.
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 4);
}

for (const { path: routePath, name } of PAGES) {
  test(`${name} renders shell + no overflow (desktop)`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const res = await page.goto(routePath, { waitUntil: 'networkidle' });
    expect(res?.ok()).toBeTruthy();
    // The app shell (sidebar nav) must mount regardless of the 401s the page's own data fetches get.
    await expect(page.locator('body')).toBeVisible();
    await checkNoHorizontalOverflow(page, DESKTOP.width);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-desktop.png`), fullPage: true });
  });

  test(`${name} renders shell + no overflow (mobile)`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const res = await page.goto(routePath, { waitUntil: 'networkidle' });
    expect(res?.ok()).toBeTruthy();
    await expect(page.locator('body')).toBeVisible();
    await checkNoHorizontalOverflow(page, MOBILE.width);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-mobile.png`), fullPage: true });
  });
}

// Documents, rather than fakes, the canvas-reachability gap described in the header comment: without
// a session, no row is ever selectable, so `[data-testid="policy-graph"]` never appears. This is a
// real product behavior (fail toward "no graph" rather than a broken partial one) and an honest
// finding for this sandbox, not something to route around with mocked fetches.
test('policy-graph canvas is not reachable without an authenticated session (documented, not faked)', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/network/security-groups/usage', { waitUntil: 'networkidle' });
  const canvas = page.locator('[data-testid="policy-graph"]');
  await expect(canvas).toHaveCount(0);
});
