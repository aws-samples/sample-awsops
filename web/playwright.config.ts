import { defineConfig } from '@playwright/test';

// Mirrors docs-site/playwright.config.ts's minimal style. Ad-hoc verification only (not wired into
// CI). The webServer block starts/stops the local app. Sidebar/placement specs mock API reads;
// older network/security specs exercise the real unauthorized responses.
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
