/** Whether the project reads dbt: configured in dql.config.json, or its dbt artifacts are found and used. */
export function projectReadsDbt(
  onboardingDbt: { configured?: boolean; manifestFound?: boolean } | undefined,
  blockStudioDbt: { configured?: boolean; artifacts?: { manifest?: { exists?: boolean } } } | null | undefined,
): boolean {
  return onboardingDbt?.configured === true
    || onboardingDbt?.manifestFound === true
    || blockStudioDbt?.artifacts?.manifest?.exists === true;
}

/**
 * The Project & dbt card's state and sentence, from one reading: a card that
 * says "Missing" never shows a "Ready" message beside it.
 */
export function projectDbtCard(
  dbtConfigured: boolean,
  preparation: { status?: string; message?: string } | null | undefined,
): { state: 'missing' | 'configured' | 'preparing' | 'failed'; detail: string } {
  if (preparation?.status === 'failed' || preparation?.status === 'cancelled') {
    return { state: 'failed', detail: preparation.message ?? 'Project preparation did not finish. Open Project & dbt to retry.' };
  }
  if (preparation?.status === 'running' || preparation?.status === 'queued') {
    return { state: 'preparing', detail: preparation.message ?? 'Preparing the project and its search indexes.' };
  }
  if (!dbtConfigured) return { state: 'missing', detail: 'Choose a local dbt project or Git repository.' };
  return { state: 'configured', detail: preparation?.message ?? 'Project configuration, dbt artifacts, and governed search indexes are ready.' };
}
