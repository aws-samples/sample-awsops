import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as dns from 'dns';

// VPC内 default resolver does not know example.com — fall back to public DNS.
dns.setServers(['8.8.8.8', '1.1.1.1']);

// v2: served at the root path (no /awsops basePath — see CLAUDE.md "v2 ↔ v1 key differences").
// awsops.atomai.click is the live v2 domain as of the 2026-07 cutover (verified via /api/health
// returning service:"awsops-web" on this exact host) — root CLAUDE.md's "awsops-v2.atomai.click"
// live-env example predates that cutover and is otherwise-sanitized placeholder text, not this host.
const BASE_URL = process.env.AWSOPS_CAPTURE_URL || 'https://awsops.atomai.click';
const LOGIN_EMAIL = process.env.AWSOPS_LOGIN_EMAIL || 'admin@awsops.local';
const LOGIN_PASSWORD = process.env.AWSOPS_LOGIN_PASSWORD || '!234Qwer';
const OUTPUT_DIR = path.join(__dirname, '..', 'static', 'screenshots');

// DPR resolution map: viewport stays 1920x1080, only pixel density changes
const DPR_MAP: Record<string, { dpr: number; suffix: string }> = {
  fhd:  { dpr: 1,   suffix: '' },        // 1920x1080
  qhd:  { dpr: 1.5, suffix: '@1.5x' },   // 2880x1620
  '4k': { dpr: 2,   suffix: '@2x' },      // 3840x2160
};

interface PageCapture {
  category: string;
  name: string;
  path: string;
  waitSelector?: string;
}

// v2 sidebar-guide screenshots only (docs-site/sidebars.ts "guideSidebar"). Interactive/detail
// shots (drilldowns, dialogs, chat answers, theme toggle, mobile viewport) aren't goto-able —
// those are captured by hand via the Playwright MCP and are NOT listed here.
const pages: PageCapture[] = [
  { category: 'getting-started', name: 'login', path: '/login' },
  { category: 'overview', name: 'dashboard', path: '/' },
  { category: 'overview', name: 'assistant', path: '/assistant' },
  // Distinct filename from overview/agentcore.png — that file is still used by the (sidebar-
  // orphaned) why-awsops.md with an unrelated "AgentCore dashboard" caption; this one captures
  // the in-chat routing badge for overview/agentcore.md's "라우팅 표시" section.
  { category: 'overview', name: 'agentcore-routing', path: '/assistant' },
  { category: 'operations', name: 'ai-diagnosis', path: '/ai-diagnosis' },
  { category: 'operations', name: 'custom-agents', path: '/customization' },
  { category: 'operations', name: 'jobs', path: '/jobs' },
  { category: 'resources', name: 'inventory', path: '/inventory/ec2' },
  { category: 'resources', name: 'eks', path: '/eks' },
  { category: 'resources', name: 'topology', path: '/topology' },
  { category: 'cost', name: 'cost-explorer', path: '/cost' },
  { category: 'cost', name: 'bedrock', path: '/bedrock' },
  // /datasources now redirects into the Integrations hub (Task 29 fold-in).
  { category: 'observability', name: 'datasources', path: '/integrations?tab=datasources' },
];

function parseOnlyArg(): string[] | null {
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  if (!onlyArg) return null;
  return onlyArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
}

function parseDprArg(): string[] {
  const dprArg = process.argv.find(a => a.startsWith('--dpr='));
  const value = dprArg ? dprArg.split('=')[1] : 'all';

  if (value === 'all') {
    return Object.keys(DPR_MAP);
  }

  // Support comma-separated: --dpr=1,2 or single: --dpr=1.5
  const requested = value.split(',');
  const keys: string[] = [];
  for (const r of requested) {
    const dprNum = parseFloat(r.trim());
    const match = Object.entries(DPR_MAP).find(([, v]) => v.dpr === dprNum);
    if (match) {
      keys.push(match[0]);
    } else {
      console.warn(`Unknown DPR value: ${r} (valid: 1, 1.5, 2)`);
    }
  }
  return keys.length > 0 ? keys : Object.keys(DPR_MAP);
}

async function login(page: Page): Promise<void> {
  // localhost / EC2 direct serves the app without Cognito (auth is enforced at CloudFront).
  if (BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1')) {
    console.log('Local URL detected — skipping Cognito login.');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    return;
  }
  console.log('Navigating to login page...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for page to fully load including Cognito redirect
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // If redirected to Cognito hosted UI
  if (currentUrl.includes('amazoncognito.com') || currentUrl.includes('auth.')) {
    console.log('Cognito hosted UI detected, filling credentials...');

    // Wait for the form element to exist in DOM (not necessarily visible)
    await page.waitForSelector('#signInFormUsername', { state: 'attached', timeout: 30000 });

    // Debug: capture login page and check element state
    await page.screenshot({ path: path.join(OUTPUT_DIR, '_cognito-login.png'), fullPage: true });
    const formInfo = await page.evaluate(() => {
      const el = document.getElementById('signInFormUsername') as HTMLInputElement;
      if (!el) return 'Element not found';
      const style = window.getComputedStyle(el);
      return JSON.stringify({
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        offsetWidth: el.offsetWidth,
        offsetHeight: el.offsetHeight,
        type: el.type,
        parentDisplay: el.parentElement ? window.getComputedStyle(el.parentElement).display : 'none',
      });
    });
    console.log(`Form element state: ${formInfo}`);

    // Use JavaScript to directly set values and submit (bypasses CSS visibility)
    await page.evaluate(({ email, password }) => {
      const usernameEl = document.getElementById('signInFormUsername') as HTMLInputElement;
      const passwordEl = document.getElementById('signInFormPassword') as HTMLInputElement;

      if (usernameEl) {
        usernameEl.value = email;
        usernameEl.dispatchEvent(new Event('input', { bubbles: true }));
        usernameEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordEl) {
        passwordEl.value = password;
        passwordEl.dispatchEvent(new Event('input', { bubbles: true }));
        passwordEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    // Click submit via JS as well
    await page.evaluate(() => {
      const submitBtn = document.querySelector('input[name="signInSubmitButton"]') as HTMLInputElement;
      if (submitBtn) {
        submitBtn.click();
      } else {
        // Fallback: submit the form directly
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.submit();
      }
    });

    // Wait for redirect back to app (dark-fallback path only — v2 defaults to /login, ADR-042).
    // Match against BASE_URL's own origin, not just "amazoncognito.com" — a custom Cognito
    // domain (CLAUDE.md's `a-ops-v2-auth-*`) wouldn't contain that substring, which would make
    // this predicate true immediately on the auth page itself instead of after the redirect.
    await page.waitForURL((u) => String(u).startsWith(BASE_URL), { timeout: 60000 });
    console.log('Login successful, redirected to app.');
  } else if (currentUrl.includes('/login') || (await page.locator('input[type="password"]').count()) > 0) {
    // v2's self-hosted /login form (ADR-042) — email + password + a locale-dependent submit
    // button ("로그인 →" / "Sign in →"), no placeholder text and no basePath on redirect.
    console.log('Custom login page detected, filling credentials...');
    await page.locator('input[type="email"], input[type="text"]').first().fill(LOGIN_EMAIL);
    await page.locator('input[type="password"]').first().fill(LOGIN_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 60000 });
    console.log('Custom login successful, redirected to app.');
  } else {
    console.log('Already logged in or no Cognito redirect.');
  }

  await page.waitForTimeout(5000);
}

async function captureScreenshot(
  page: Page,
  capture: PageCapture,
  suffix: string,
): Promise<void> {
  const dir = path.join(OUTPUT_DIR, capture.category);
  fs.mkdirSync(dir, { recursive: true });

  // Viewport screenshot (the only variant used in docs — no page references a "-full" twin)
  await page.screenshot({
    path: path.join(dir, `${capture.name}${suffix}.png`),
    fullPage: false,
  });
}

async function captureAllDprs(
  browser: Browser,
  dprKeys: string[],
  cookies: { name: string; value: string; domain: string; path: string }[],
  filter: string[] | null,
): Promise<void> {
  const targets = filter
    ? pages.filter(p => filter.includes(p.name) || filter.includes(`${p.category}/${p.name}`))
    : pages;
  console.log(`Pages to capture: ${targets.length}${filter ? ` (filtered from ${pages.length})` : ''}`);

  for (const key of dprKeys) {
    const { dpr, suffix } = DPR_MAP[key];
    const label = `${key.toUpperCase()} (DPR ${dpr}${suffix || ''})`;
    console.log(`\n=== Capturing at ${label} ===`);

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: dpr,
      ignoreHTTPSErrors: true,
    });

    // Restore session cookies so we don't need to login again per DPR
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();

    for (const capture of targets) {
      const url = `${BASE_URL}${capture.path}`;
      console.log(`  ${capture.category}/${capture.name}${suffix} (${url})`);

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        if (capture.waitSelector) {
          await page.waitForSelector(capture.waitSelector, { timeout: 10000 }).catch(() => {});
        }

        await captureScreenshot(page, capture, suffix);
        console.log(`    Done`);
      } catch (err) {
        console.error(`    Error: ${err}`);
      }
    }

    await context.close();
  }
}

async function main(): Promise<void> {
  const dprKeys = parseDprArg();
  const onlyFilter = parseOnlyArg();
  console.log('Starting screenshot capture...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`DPR targets: ${dprKeys.map(k => `${k} (${DPR_MAP[k].dpr}x)`).join(', ')}`);
  if (onlyFilter) console.log(`Filter: --only=${onlyFilter.join(',')}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });

  // Login once with DPR 1, then reuse cookies for other DPRs
  const loginContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });
  const loginPage = await loginContext.newPage();

  try {
    await login(loginPage);
    const cookies = await loginContext.cookies();
    await loginContext.close();

    await captureAllDprs(browser, dprKeys, cookies, onlyFilter);

    console.log(`\nAll screenshots captured to ${OUTPUT_DIR}`);
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await browser.close();
  }
}

main();
