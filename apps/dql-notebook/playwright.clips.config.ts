import { defineConfig } from '@playwright/test';

/**
 * Feature clips for the docs and README (`pnpm docs:clips` at the repo root).
 *
 * Each `browser/clips/<id>.clip.ts` is a scripted journey against the Jaffle
 * Shop sample served by the BUILT `zlens notebook` CLI, recorded at 1440×900.
 * scripts/docs-clips.mjs runs this config and encodes the recordings into
 * docs/media/clips/. See docs/media/clips/README.md.
 */
export default defineConfig({
  testDir: './browser/clips',
  testMatch: '**/*.clip.ts',
  globalSetup: './browser/clips/clips-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/clips',
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
