import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev:e2e -w @lettermate/api',
      url: 'http://127.0.0.1:3001/api/v1/health',
      env: { PORT: '3001' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w @lettermate/web -- --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      env: { VITE_API_PROXY: 'http://127.0.0.1:3001' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
