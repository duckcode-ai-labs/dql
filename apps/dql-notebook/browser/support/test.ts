import { test as base, expect } from '@playwright/test';

/**
 * `test` with `baseURL` pointing at the server global-setup started.
 * Playwright re-reads the config in every worker, so the URL cannot live there:
 * the setup publishes it in DQL_E2E_BASE_URL, which workers inherit.
 */
export const test = base.extend({
  baseURL: async ({}, use) => {
    const url = process.env.DQL_E2E_BASE_URL;
    if (!url) throw new Error('DQL_E2E_BASE_URL is not set: global setup did not start the server.');
    await use(url);
  },
});

export { expect };
