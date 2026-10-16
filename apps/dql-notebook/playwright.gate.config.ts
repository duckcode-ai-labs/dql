import { defineConfig } from '@playwright/test';

/**
 * The browser half of the clean-machine launch gate (scripts/launch-gate.mjs at
 * the repo root). The gate installs the packed release into a fresh clone of a
 * sample, starts its workbench exactly as the README says, and runs one of
 * browser/gate/*.gate.ts against it through ZLENS_GATE_BASE_URL. Each test is
 * one row of the gate's pass/fail table; the screenshots are its evidence.
 *
 * Ask runs against the live `claude-code` provider (the local `claude` login),
 * so answers take minutes, not seconds.
 */
export default defineConfig({
  testDir: './browser/gate',
  testMatch: '**/*.gate.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.ZLENS_GATE_REPORT || 'test-results/gate/report.json' }],
  ],
  outputDir: process.env.ZLENS_GATE_OUTPUT_DIR || 'test-results/gate',
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
