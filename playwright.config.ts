import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8899',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `OPENFIND_DATA_DIR=/tmp/openfind-e2e-${Date.now()} OPENFIND_BROWSER_PORT=8898 OPENFIND_DEMO=1 PORT=8899 npm start`,
    url: 'http://127.0.0.1:8899/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
