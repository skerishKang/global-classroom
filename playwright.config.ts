import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5180';
const shouldStartServer = !process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: shouldStartServer
    ? {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120 * 1000,
      }
    : undefined,
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    // Ordinary E2E uses page.route/fetch mocks. A registered application SW
    // can intercept before Playwright routing, so keep it isolated to the
    // dedicated service-worker spec below.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
