import { describe, expect, it } from 'vitest';
import { domainStudioUnavailableState } from './domain-studio-readiness';

function apiError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, details });
}

describe('Domain Studio readiness copy (CFG-003, UI-007, E2E-003)', () => {
  it('does not describe disabled dbt-first modeling as a missing manifest', () => {
    const state = domainStudioUnavailableState(apiError('DBT_FIRST_NOT_ENABLED', 'dbt-first modeling is not enabled.'));

    expect(state.title).toBe('Set up modeling');
    expect(state.status).toContain('Not enabled');
    expect(state.detail).toContain('Settings → Project & dbt');
    // A project without dbt can model its warehouse instead (RFC 0007).
    expect(state.action).toBe('enable_warehouse');
  });

  it('never offers warehouse-only modeling to a project that already reads dbt', () => {
    const state = domainStudioUnavailableState(apiError('DBT_FIRST_NOT_ENABLED', 'dbt-first modeling is not enabled.', { dbtDetected: true }));

    expect(state.title).toBe('Set up modeling');
    expect(state.detail).toContain('Settings → Project & dbt');
    expect(state.action).toBeUndefined();
  });

  it('explains how to create a missing configured dbt manifest', () => {
    const state = domainStudioUnavailableState(apiError(
      'DBT_MANIFEST_NOT_FOUND',
      'The configured dbt manifest was not found.',
      { manifestPath: 'build/manifest.json' },
    ));

    expect(state.title).toBe('dbt manifest is not ready');
    expect(state.detail).toContain('build/manifest.json was not found');
    expect(state.detail).toContain('dbt parse, dbt compile, or dbt build');
    expect(state.status).toContain('Missing (build/manifest.json)');
  });

  it('keeps manifest load failures distinct from missing artifacts', () => {
    const state = domainStudioUnavailableState(apiError('DBT_MANIFEST_COMPILE_FAILED', 'Unexpected token in manifest.json.'));

    expect(state.title).toBe('dbt manifest could not be loaded');
    expect(state.detail).toContain('Unexpected token');
    expect(state.status).toContain('Load failed');
  });
});
