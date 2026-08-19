import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  // Each project uses one stateful E2E API and production-preview server.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev:e2e -w @lettermate/api',
      url: 'http://127.0.0.1:3011/api/v1/health',
      env: { PORT: '3011' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run preview:e2e -w @lettermate/web',
      url: 'http://127.0.0.1:4173',
      env: { VITE_API_PROXY: 'http://127.0.0.1:3011' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'compact-mobile', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 700 } } },
  ],
});
