import { clip, expect, openAndRecord } from './support/clip-test';

/** Lineage: trace a certified block from dbt sources through to the App that shows it. */
clip('lineage', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Lineage', exact: true }));
  await expect(page.getByText('Trace lineage')).toBeVisible();
  await director.beat(500);
  await director.click(page.getByRole('button', { name: 'monthly_revenue', exact: true }));

  const node = (text: string) => page.locator('.react-flow__node', { hasText: text }).first();
  await expect(node('Jaffle Growth Review')).toBeVisible();
  await director.beat(1600);
  director.poster();

  // Upstream: the dbt model the block reads.
  await director.click(node('orders'), { after: 1500 });
  // Downstream: the App page that shows the block.
  await director.click(node('Jaffle Growth Review'), { after: 1800 });
  await director.point(page.getByText(/End-to-end lineage of monthly_revenue/));
  await director.beat(1500);
});
