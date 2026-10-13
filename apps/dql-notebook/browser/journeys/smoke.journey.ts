import { test, expect } from '../support/test';

/**
 * Smoke journeys against the built `dql notebook` CLI on the jaffle-supply-chain
 * fixture (seeded DuckDB, one added notebook and App). See ../global-setup.ts.
 */

// Ask replays model responses from the committed answerability cassettes. They
// are stale on main (readiness plan O3: every call is "No cassette for
// generate"), so the Ask journey cannot pass until O3 re-records them. Flip to
// true in the same change that lands the re-recorded cassettes.
const ASK_CASSETTES_FRESH = false;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
  // The app shows itself once every Inter file has loaded (src/interface-fonts.ts). Clicking while one is still
  // loading let Chromium wait forever on a font lookup on the 4-core CI runner, so the journeys start from there.
  await expect
    .poll(() => page.evaluate(() => {
      const inter = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Inter');
      return inter.length > 0 && inter.every((face) => face.status === 'loaded');
    }), { message: 'every Inter font file has loaded' })
    .toBe(true);
});

test('opens the app and the runtime reports healthy', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe('ok');
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Blocks', exact: true })).toBeVisible();
});

test('theme choice sets data-theme, persists dql-theme, and survives a reload', async ({ page }) => {
  // The theme button's visible text is the current theme; its title names it.
  await page.getByTitle(/^Theme:/).click();
  await page.getByRole('menuitemradio', { name: /Obsidian/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'obsidian');
  expect(await page.evaluate(() => window.localStorage.getItem('dql-theme'))).toBe('obsidian');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'obsidian');

  await page.getByTitle(/^Theme:/).click();
  await page.getByRole('menuitemradio', { name: /White/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'white');
  expect(await page.evaluate(() => window.localStorage.getItem('dql-theme'))).toBe('white');
});

test('opens a notebook and runs its cell against the seeded warehouse', async ({ page }) => {
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page.getByText('smoke', { exact: false }).first().click();
  await page.getByRole('button', { name: 'Run all' }).click();
  // The cell prints "smoke-true" (count(*) > 0 over dev.dim_customers). That text
  // is not in the cell source, so seeing it means the query ran and returned a row.
  await expect(page.getByText('smoke-true')).toBeVisible();
});

test('Blocks lists the certified blocks', async ({ page }) => {
  await page.getByRole('button', { name: 'Blocks', exact: true }).first().click();
  // Blocks are grouped by domain; the fixture's three blocks sit under "orders".
  await expect(page.getByText(/3 blocks/)).toBeVisible();
  await page.getByRole('button', { name: /^orders\s*\d+$/ }).click();
  await expect(page.getByText('top_customers').first()).toBeVisible();
});

test('Lineage draws a graph', async ({ page }) => {
  await page.getByRole('button', { name: 'Lineage', exact: true }).click();
  // Lineage starts from a picked asset; tracing a block draws its graph.
  await page.getByRole('button', { name: 'top_customers', exact: true }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
});

test('opens an App and shows its dashboard', async ({ page }) => {
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByText('Smoke Orders').first().click();
  await expect(page.getByText('Orders overview').first()).toBeVisible();
});

test('Ask a certified question and see the Certified label', async ({ page }) => {
  test.fixme(!ASK_CASSETTES_FRESH, 'Blocked on readiness plan O3: answerability cassettes are stale.');
  await page.getByRole('button', { name: 'Ask', exact: true }).first().click();
  await page.getByRole('textbox').first().fill('who are the top customers');
  await page.getByRole('button', { name: /^Ask$/ }).last().click();
  await expect(page.getByText('Certified', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
});
