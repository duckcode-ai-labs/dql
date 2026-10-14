import { defineConfig } from '@playwright/test';

/**
 * Real-browser smoke journeys for the notebook UI.
 *
 * The journeys run against the BUILT `zlens notebook` CLI (see
 * browser/global-setup.ts), never the Vite dev server: AGENTS.md says Vite-only
 * proof is not acceptance. The journeys live in `browser/journeys/*.journey.ts`.
 *
 * Browser: Playwright's bundled Chromium by default. Set
 * AUDIT_BROWSER_CHANNEL (for example `chrome`) to use an installed browser.
 */
const channel = process.env.AUDIT_BROWSER_CHANNEL || undefined;

export default defineConfig({
  testDir: './browser/journeys',
  testMatch: '**/*.journey.ts',
  globalSetup: './browser/global-setup.ts',
  // One server, one project copy: journeys share state, so run them in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  outputDir: 'test-results',
  use: {
    ...(channel ? { channel } : {}),
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
