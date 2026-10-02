import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-artifacts/results.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'api', testMatch: 'api/**/*.spec.ts' },
    ...[360, 430].map((width) => ({
      name: `chromium-${width}`,
      testMatch: 'e2e/**/*.spec.ts',
      use: {
        browserName: 'chromium' as const,
        viewport: { width, height: 900 },
        isMobile: true,
        hasTouch: true,
      },
    })),
  ],
  webServer: {
    command: 'node scripts/test-server.mjs',
    // Only our launcher's verified IPC + HTTP readiness marker starts tests.
    wait: { stdout: /WHENWEMEET_TEST_SERVER_READY/ },
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
