import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '@zlens/core';

const fixtureRoot = resolve(process.cwd(), 'test/fixtures/ask-observability-office');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, relativePath), 'utf8')) as T;
}

describe('Ask observability synthetic office fixture (OBS-012)', () => {
  it('is a valid local dbt-first project with certified, semantic, relational, and exploratory coverage', () => {
    const config = readJson<{
      project: string;
      manifestVersion: number;
      modeling: { mode: string };
      dbt: { manifestPath: string };
      semanticLayer: { provider: string; projectPath: string };
    }>('dql.config.json');
    expect(config).toEqual({
      project: 'ask-observability-office-synthetic',
      manifestVersion: 3,
      modeling: { mode: 'dbt-first' },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
      semanticLayer: { provider: 'dbt', projectPath: '.' },
    });

    const manifest = buildManifest({
      projectRoot: fixtureRoot,
      dqlVersion: 'fixture',
      dbtManifestPath: join(fixtureRoot, 'target/manifest.json'),
    });
    const errors = (manifest.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors).toEqual([]);
    expect(manifest.manifestVersion).toBe(3);
    expect(Object.values(manifest.blocks).map((block) => block.name)).toEqual(expect.arrayContaining([
      'Lost Opportunities by Fiscal Month and Competitor',
      'Top Customers by Revenue',
      'Current BCM Run Rate by Account',
    ]));
    const relationshipIds = Object.values(manifest.modeling?.relationships ?? {}).map((relationship) => relationship.id);
    expect(relationshipIds.some((id) => id.endsWith('::relationship::lost_opportunity_to_account'))).toBe(true);
    expect(relationshipIds.some((id) => id.endsWith('::relationship::account_to_customer'))).toBe(true);
    expect(relationshipIds.some((id) => id.endsWith('::relationship::account_revenue_to_account'))).toBe(true);
    expect(relationshipIds.some((id) => id.endsWith('::relationship::competitor_observation_to_lost_opportunity'))).toBe(true);

    const contract = readJson<{
      fiscalCalendar: { calendarId: string; dateRole: string; fiscalPeriodField: string };
      cascadePaths: { certified: string[]; semantic: string[]; governedRelational: string[]; exploratory: { trustState: string; unsafeJoinMustRemainBlocked: string } };
    }>('test-support/fixture-contract.json');
    expect(contract.fiscalCalendar).toEqual(expect.objectContaining({
      calendarId: 'calendar:synthetic_fiscal',
      dateRole: 'opportunity_close_date',
      fiscalPeriodField: 'fct_lost_opportunities.fiscal_period',
    }));
    expect(contract.cascadePaths.certified).toHaveLength(3);
    expect(contract.cascadePaths.semantic).toEqual(expect.arrayContaining(['revenue', 'bcm_run_rate']));
    expect(contract.cascadePaths.governedRelational).toEqual(expect.arrayContaining(['account_to_customer']));
    expect(contract.cascadePaths.exploratory).toEqual({
      trustState: 'review_required',
      eligibleSingleRelation: 'analytics.revenue_operations.fct_competitor_observations',
      unsafeJoinMustRemainBlocked: 'competitor_observation_to_lost_opportunity',
    });
  });

  it('holds the screenshot-shaped questions as role/routing expectations without gold SQL or result rows', () => {
    const evals = loadYaml(readFileSync(join(fixtureRoot, 'agent-evals/ask-observability-office.agent-evals.yml'), 'utf8')) as {
      cases: Array<{ question: string; expected: { answerable: boolean } }>;
    };
    const contract = readJson<{
      runtimeSafety: Record<string, boolean>;
      questions: Array<{ id: string; question: string; requiredIds: string[]; rankingMeasure?: string; defaultTopN?: number }>;
      ambiguity: { requiresClarification: boolean; meaningOptions: string[] };
      terminalGap: { mustNotInferRelationship: string };
    }>('test-support/fixture-contract.json');

    expect(evals.cases.slice(0, 3).map((entry) => entry.question)).toEqual([
      'Lost opportunities count and lost amount by month for fiscal year FY26 and competitor involved is Datadog',
      'Who are the top BCM customers who have highest revenue?',
      'What is the current BCM run rate across top accounts?',
    ]);
    expect(contract.questions.find((entry) => entry.id === 'top_bcm_customers_by_revenue')).toMatchObject({
      rankingMeasure: 'revenue',
      requiredIds: expect.arrayContaining(['customer_name', 'customer_id']),
      defaultTopN: 10,
    });
    expect(contract.ambiguity).toMatchObject({
      requiresClarification: true,
      meaningOptions: ['account_name', 'customer_name'],
    });
    expect(contract.terminalGap.mustNotInferRelationship).toBe('competitor_observation_to_lost_opportunity');
    expect(contract.runtimeSafety).toEqual({
      requiresNetwork: false,
      requiresProvider: false,
      requiresWarehouseForStartup: false,
      containsGoldSql: false,
      containsGoldResults: false,
      containsOfficeData: false,
    });

    const testOnlySources = [
      readFileSync(join(fixtureRoot, 'agent-evals/ask-observability-office.agent-evals.yml'), 'utf8'),
      readFileSync(join(fixtureRoot, 'test-support/fixture-contract.json'), 'utf8'),
      readFileSync(join(fixtureRoot, 'test-support/research-branch-expectations.json'), 'utf8'),
      readFileSync(join(fixtureRoot, 'test-support/failure-adapters.json'), 'utf8'),
    ].join('\n');
    expect(testOnlySources).not.toMatch(/expectedRows|sqlContains|"rows"\s*:/i);
  });

  it('keeps deterministic failure and Research evidence as test-only typed descriptors', () => {
    const failures = readJson<{
      runtimeConfiguration: boolean;
      adapters: Array<{ id: string; boundary: string; cause?: string; safeErrorCode?: string; stage?: string; maximumRepairs?: number }>;
    }>('test-support/failure-adapters.json');
    const research = readJson<{
      minimumGroundableBranches: number;
      branches: Array<{ id: string; requiresCounterEvidence: boolean }>;
      synthesis: { requiresReceiptOnlyEvidence: boolean; mustNotPromoteCorrelationToCausation: boolean };
    }>('test-support/research-branch-expectations.json');

    expect(failures.runtimeConfiguration).toBe(false);
    expect(failures.adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'provider-authentication', boundary: 'provider', cause: 'authentication' }),
      expect.objectContaining({ id: 'tool-denied', boundary: 'tool', safeErrorCode: 'tool_denied' }),
      expect.objectContaining({ id: 'sql-authorize-denied', boundary: 'sql', stage: 'authorize' }),
      expect.objectContaining({ id: 'sql-repair-once', boundary: 'sql', maximumRepairs: 1 }),
    ]));
    expect(research.minimumGroundableBranches).toBe(3);
    expect(research.branches).toHaveLength(3);
    expect(research.branches.every((branch) => branch.requiresCounterEvidence)).toBe(true);
    expect(research.synthesis).toMatchObject({
      requiresReceiptOnlyEvidence: true,
      mustNotPromoteCorrelationToCausation: true,
    });
  });
});
