import { describe, expect, it } from 'vitest';
import type { BlockRecord, TestResultSummary } from '@zlens/project';
import { Certifier, BUILTIN_RULES, ENTERPRISE_RULES } from './certifier.js';
import type { InvariantResult } from './invariant-evaluator.js';

function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    id: 'block-1',
    name: 'Customer Profile',
    domain: 'Customer',
    type: 'custom',
    version: '0.0.0',
    status: 'draft',
    gitRepo: '',
    gitPath: 'domains/customer/blocks/customer_profile.dql',
    gitCommitSha: '',
    description: 'Reusable customer profile block.',
    owner: 'customer-analytics',
    tags: ['customer'],
    dependencies: [],
    usedInCount: 0,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    pattern: 'entity_profile',
    grain: 'customer_id',
    entities: ['Customer'],
    declaredOutputs: ['customer_id', 'customer_name'],
    sourceSystems: ['crm'],
    reviewCadence: 'monthly',
    ...overrides,
  };
}

const passingTests: TestResultSummary = {
  passed: 1,
  failed: 0,
  skipped: 0,
  duration: 5,
  assertions: [{ name: 'assert row_count > 0', passed: true }],
  runAt: new Date('2026-06-20T00:00:00.000Z'),
};

describe('Certifier enterprise rules', () => {
  it('makes reusable block contract metadata hard requirements in enterprise mode', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block({
      grain: undefined,
      declaredOutputs: [],
      sourceSystems: [],
      reviewCadence: undefined,
      pattern: undefined,
    }), passingTests);

    expect(result.certified).toBe(false);
    expect(result.errors.map((error) => error.rule)).toEqual(
      expect.arrayContaining([
        'Block declares grain',
        'Block declares outputs',
        'Block declares review cadence',
        'Block declares lineage context',
        'Block declares reusable pattern',
      ]),
    );
  });

  it('certifies enterprise-ready blocks when contract metadata and tests pass', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block(), passingTests);

    expect(result.certified).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts declared tests when runtime execution is intentionally skipped', () => {
    const skippedTests: TestResultSummary = {
      passed: 0,
      failed: 0,
      skipped: 1,
      duration: 0,
      assertions: [],
      runAt: new Date('2026-06-20T00:00:00.000Z'),
    };
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block({
      testAssertions: ['assert row_count > 0'],
    }), skippedTests);

    expect(result.certified).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('requires metric_wrapper blocks to bind exactly one semantic metric', () => {
    const passing = new Certifier(ENTERPRISE_RULES).evaluate(block({
      name: 'Revenue Metric Wrapper',
      type: 'semantic',
      pattern: 'metric_wrapper',
      grain: 'order_month',
      entities: [],
      declaredOutputs: ['order_month', 'total_revenue'],
      metricRef: 'total_revenue',
      dimensionsRef: ['order_month'],
      allowedFilters: ['order_month'],
      filterBindings: [{ filter: 'order_month', binding: 'order_month' }],
    }), passingTests);
    expect(passing.certified).toBe(true);

    const failing = new Certifier(ENTERPRISE_RULES).evaluate(block({
      pattern: 'metric_wrapper',
      metricRef: undefined,
      metricsRef: ['total_revenue', 'gross_margin'],
    }), passingTests);
    expect(failing.certified).toBe(false);
    expect(failing.errors.map((error) => error.rule)).toContain('Metric wrapper binds exactly one semantic metric');
  });

  it('enforces pattern-specific contracts for rollups and drilldowns', () => {
    const rollup = new Certifier(ENTERPRISE_RULES).evaluate(block({
      pattern: 'entity_rollup',
      entities: ['Customer'],
      grain: 'customer_id',
      declaredOutputs: ['customer_id'],
    }), passingTests);
    expect(rollup.certified).toBe(false);
    expect(rollup.errors.map((error) => error.rule)).toContain('Entity rollup declares entity grain and measures');

    const drilldown = new Certifier(ENTERPRISE_RULES).evaluate(block({
      pattern: 'drilldown',
      grain: 'detail_row',
      entities: [],
      declaredOutputs: ['customer_id', 'order_id'],
      allowedFilters: [],
      parameterPolicy: [],
      filterBindings: [],
    }), passingTests);
    expect(drilldown.certified).toBe(false);
    expect(drilldown.errors.map((error) => error.rule)).toContain('Drilldown declares reusable filters');
  });

  it('requires bridge blocks to declare both sides and review context', () => {
    const failing = new Certifier(ENTERPRISE_RULES).evaluate(block({
      pattern: 'bridge',
      entities: ['Customer'],
      declaredOutputs: ['customer_id'],
      sourceSystems: ['crm'],
    }), passingTests);

    expect(failing.certified).toBe(false);
    expect(failing.errors.map((error) => error.rule)).toContain('Bridge block declares cross-domain review context');

    const passing = new Certifier(ENTERPRISE_RULES).evaluate(block({
      pattern: 'bridge',
      grain: 'customer_order_bridge_key',
      entities: ['Customer', 'Order'],
      declaredOutputs: ['customer_order_bridge_key', 'customer_id', 'order_id'],
      sourceSystems: ['crm', 'orders'],
      allowedFilters: ['customer_id', 'order_id'],
      filterBindings: [
        { filter: 'customer_id', binding: 'customer_id' },
        { filter: 'order_id', binding: 'order_id' },
      ],
    }), passingTests);

    expect(passing.certified).toBe(true);
  });

  it('enforces declared filter bindings and supported parameter policy values', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(block({
      allowedFilters: ['season_range'],
      filterBindings: [{ filter: 'team', binding: 'team_name' }],
      parameterPolicy: [{ name: 'season_start', policy: 'ad_hoc' }],
    }), passingTests);

    expect(result.certified).toBe(false);
    expect(result.errors.map((error) => error.rule)).toEqual(expect.arrayContaining([
      'Parameter policies are valid',
      'Filter bindings map declared filters',
    ]));
  });
});

function passingInvariant(expr: string): InvariantResult {
  return { expr, passed: true, detail: 'Holds.' };
}

function failingInvariant(expr: string): InvariantResult {
  return { expr, passed: false, detail: 'Violated: out of range.' };
}

function uncheckableInvariant(expr: string): InvariantResult {
  return { expr, passed: true, uncheckable: true, detail: 'Uncheckable invariant.' };
}

describe('Certifier invariants-hold rule', () => {
  it('does not affect blocks without invariants', () => {
    const result = new Certifier(BUILTIN_RULES).evaluate(block(), passingTests);
    expect(result.errors.map((e) => e.rule)).not.toContain('Declared invariants hold');
    expect(result.warnings.map((w) => w.rule)).not.toContain('Declared invariants hold');
  });

  it('warns in base mode when an invariant is violated, but does not block', () => {
    const result = new Certifier(BUILTIN_RULES).evaluate(
      block({ invariants: ['approval_rate_pct <= 100'] }),
      passingTests,
      { invariantResults: [failingInvariant('approval_rate_pct <= 100')] },
    );
    expect(result.warnings.map((w) => w.rule)).toContain('Declared invariants hold');
    expect(result.errors.map((e) => e.rule)).not.toContain('Declared invariants hold');
  });

  it('blocks certification in enterprise mode when an invariant is violated', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(
      block({ invariants: ['approval_rate_pct <= 100'] }),
      passingTests,
      { invariantResults: [failingInvariant('approval_rate_pct <= 100')] },
    );
    expect(result.certified).toBe(false);
    expect(result.errors.map((e) => e.rule)).toContain('Declared invariants hold');
  });

  it('certifies in enterprise mode when invariants pass', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(
      block({ invariants: ['arr >= 0'] }),
      passingTests,
      { invariantResults: [passingInvariant('arr >= 0')] },
    );
    expect(result.certified).toBe(true);
    expect(result.errors.map((e) => e.rule)).not.toContain('Declared invariants hold');
  });

  it('does not fail on uncheckable invariants (they only warn at evaluation time)', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(
      block({ invariants: ['rate is mostly fine'] }),
      passingTests,
      { invariantResults: [uncheckableInvariant('rate is mostly fine')] },
    );
    expect(result.certified).toBe(true);
    expect(result.errors.map((e) => e.rule)).not.toContain('Declared invariants hold');
  });

  it('blocks enterprise certification when invariants are declared but no run results exist', () => {
    const result = new Certifier(ENTERPRISE_RULES).evaluate(
      block({ invariants: ['arr >= 0'] }),
      passingTests,
      // no invariantResults
    );
    expect(result.certified).toBe(false);
    expect(result.errors.map((e) => e.rule)).toContain('Declared invariants hold');
  });
});
