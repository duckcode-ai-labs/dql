import { askQuestion, waitForAnswer } from './support/ask';
import { clip, expect, openAndRecord } from './support/clip-test';

/** Ask: a question a certified block answers, its Certified label, and how it was answered. */
clip('ask-certified', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Ask', exact: true }));
  await askQuestion(page, director, 'How has revenue changed by month?');
  await waitForAnswer(page, director);

  const label = page.getByText('Certified answer', { exact: true }).first();
  await expect(label).toBeVisible();
  await director.point(label);
  await director.beat(1200);
  director.poster();
  await director.point(page.getByText('monthly_revenue', { exact: true }).first());
  await director.beat(1000);

  await director.click(page.getByRole('button', { name: 'Visualization', exact: true }).first(), { after: 1600 });
  await director.click(page.getByRole('button', { name: 'How it was answered' }).last(), { after: 400 });
  await expect(page.getByText('How it answered', { exact: true }).first()).toBeVisible();
  await director.beat(2600);
});
