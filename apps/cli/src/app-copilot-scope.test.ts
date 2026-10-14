import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardFilter } from '@zlens/core';
import { appViewClause, describeFilterValue, scopeAppCopilotRequest } from './app-copilot-scope.js';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-app-copilot-scope-'));
  roots.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const known = { knownDomain: (domain: string) => domain === 'commerce' };

describe('App copilot scope (RFC 0008 step 3b)', () => {
  it('scopes a question to the App domain and states the filters on screen', () => {
    const request = {
      question: 'Why is revenue down?',
      workspaceContext: {
        surface: 'apps', appId: 'commerce-pilot', dashboardId: 'overview',
        appDomain: 'spoofed-by-browser', dashboardFilters: { region: ['EU'] },
      } as Record<string, unknown>,
    };
    const scope = scopeAppCopilotRequest(project(), request, known);
    expect(scope).toMatchObject({
      appId: 'commerce-pilot', domain: 'commerce', pageId: 'overview',
      filters: [{ id: 'region', label: 'Region', value: 'EU' }],
      originalQuestion: 'Why is revenue down?',
    });
    // The domain comes from the App file, not from appDomain in the payload.
    expect(request.workspaceContext.domain).toBe('commerce');
    expect(request.question).toBe("Why is revenue down?\n\nAnswer for this app's current view only: Region is EU.");
    expect(request.workspaceContext.appScope).toEqual(scope);
  });

  it('keeps a domain the reader chose and skips a domain the project does not declare', () => {
    const chosen = { question: 'Revenue?', workspaceContext: { surface: 'apps', appId: 'commerce-pilot', domain: 'finance' } as Record<string, unknown> };
    scopeAppCopilotRequest(project(), chosen, known);
    expect(chosen.workspaceContext.domain).toBe('finance');

    const undeclared = { question: 'Revenue?', workspaceContext: { surface: 'apps', appId: 'commerce-pilot' } as Record<string, unknown> };
    const scope = scopeAppCopilotRequest(project(), undeclared, { knownDomain: () => false });
    expect(scope?.domain).toBeUndefined();
    expect(undeclared.workspaceContext.domain).toBeUndefined();
  });

  it('adds no clause when no filter restricts the view', () => {
    const request = {
      question: 'Revenue by region',
      workspaceContext: { surface: 'apps', appId: 'commerce-pilot', dashboardId: 'overview', dashboardFilters: { region: [] } } as Record<string, unknown>,
    };
    scopeAppCopilotRequest(project(), request, known);
    expect(request.question).toBe('Revenue by region');
  });

  it('leaves other surfaces and unknown Apps untouched', () => {
    const ask = { question: 'Revenue?', workspaceContext: { surface: 'ask', appId: 'commerce-pilot' } as Record<string, unknown> };
    expect(scopeAppCopilotRequest(project(), ask, known)).toBeUndefined();
    expect(ask.workspaceContext).toEqual({ surface: 'ask', appId: 'commerce-pilot' });

    const missing = { question: 'Revenue?', workspaceContext: { surface: 'apps', appId: 'no-such-app' } as Record<string, unknown> };
    expect(scopeAppCopilotRequest(project(), missing, known)).toBeUndefined();
    expect(missing.question).toBe('Revenue?');
  });

  it('describes each kind of filter value in words', () => {
    const filter = (type: DashboardFilter['type']): DashboardFilter => ({ id: 'f', type });
    expect(describeFilterValue(filter('multiselect'), ['US', 'EU'])).toBe('one of US, EU');
    expect(describeFilterValue(filter('daterange'), { from: '2026-07-01', to: '2026-09-30' })).toBe('from 2026-07-01 to 2026-09-30');
    expect(describeFilterValue(filter('relative_date'), 'last_90_days')).toBe('last 90 days');
    expect(describeFilterValue(filter('boolean'), false)).toBe('no');
    expect(describeFilterValue(filter('number_range'), { min: 10, max: 20 })).toBe('from 10 to 20');
    expect(describeFilterValue(filter('select'), '')).toBeUndefined();
    expect(appViewClause({ filters: [] })).toBeUndefined();
  });
});
