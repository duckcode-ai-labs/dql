import { describe, expect, it } from 'vitest';
import { projectDbtCard, projectReadsDbt } from './project-dbt-status';

describe('Project & dbt status', () => {
  it('counts a project that reads dbt artifacts as using dbt, even without a dbt key in the config', () => {
    // The NBA workspace: no `dbt` key, target/manifest.json linked and read.
    expect(projectReadsDbt({ configured: false, manifestFound: true }, null)).toBe(true);
    expect(projectReadsDbt({ configured: false, manifestFound: false }, { configured: false, artifacts: { manifest: { exists: true } } })).toBe(true);
    expect(projectReadsDbt({ configured: true }, null)).toBe(true);
    expect(projectReadsDbt({ configured: false, manifestFound: false }, null)).toBe(false);
  });

  it('never shows "Missing" beside a "Ready" message', () => {
    const ready = { status: 'completed', message: 'Ready. Indexed 89 governed objects for fast search.' };
    expect(projectDbtCard(true, ready)).toEqual({ state: 'configured', detail: ready.message });
    expect(projectDbtCard(false, ready)).toEqual({ state: 'missing', detail: 'Choose a local dbt project or Git repository.' });
    expect(projectDbtCard(false, { status: 'running', message: 'Indexing' })).toEqual({ state: 'preparing', detail: 'Indexing' });
    expect(projectDbtCard(true, { status: 'failed', message: 'dbt manifest is invalid' })).toEqual({ state: 'failed', detail: 'dbt manifest is invalid' });
  });
});
