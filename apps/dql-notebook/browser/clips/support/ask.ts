import type { Page } from '@playwright/test';
import { expect } from './clip-test';
import type { Director } from './director';

/** Open Ask from the rail (or the App's Ask) and type a question at a readable pace. */
export async function askQuestion(page: Page, director: Director, question: string): Promise<void> {
  const box = page.getByPlaceholder(/Ask anything about your data/).first();
  await expect(box).toBeVisible();
  await director.type(box, question);
  await director.press('Enter', 300);
}

/**
 * Wait for the answer to finish (its "How it was answered" action appears last)
 * with the wait shortened in the clip.
 */
export async function waitForAnswer(page: Page, director: Director, timeout = 240_000): Promise<void> {
  await director.fastForward(async () => {
    await expect(page.getByRole('button', { name: 'How it was answered' }).last()).toBeVisible({ timeout });
  });
  await director.beat(900);
}
