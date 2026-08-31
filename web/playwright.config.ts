import { defineConfig } from '@playwright/test';

// Mirrors docs-site/playwright.config.ts's minimal style. Ad-hoc verification only (not wired into
// CI) — see web/e2e/network-security-graph.spec.ts for what it checks and why. No webServer block
// here: the spec starts/stops `next dev` itself so it can also skip cleanly when a browser can't launch.
const PORT = 3177; // fixed, unusual port to avoid colliding with other sessions' dev servers on this shared box

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
  },
  timeout: 60000,
  reporter: [['list']],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
