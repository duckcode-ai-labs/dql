import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@zlens/core';
import {
  buildAnalyticalExecutionGraph,
  executeAnalyticalExecutionGraph,
} from './analytical-execution-graph.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';

const ids = {
  metric: 'commerce::metric::net_revenue',
  measure: 'commerce::measure::net_revenue',
  customerEntity: 'commerce::entity::customer',
  customer: 'commerce::dimension::customer_name',
  date: 'commerce::dimension::report_date',
};

function comparisonFrame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Current and last-year revenue for the top two customers.',
    questionType: 'ranking',
    metricConceptIds: [ids.metric],
    entityGrainIds: [ids.customerEntity],
    dimensions: [
      { dimensionId: ids.customer, role: 'group_by' },
      { dimensionId: ids.customer, role: 'rank_entity' },
      { dimensionId: ids.date, role: 'time_axis' },
    ],
    memberBindings: [],
    timeContext: {
      timeDimensionId: ids.date,
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [
        { id: 'current', kind: 'current', start: '2026-07-01T05:00:00.000Z', end: '2026-07-22T05:00:00.000Z' },
        {
          id: 'previous_year',
          kind: 'previous_year',
          start: '2025-07-01T05:00:00.000Z',
          end: '2025-07-22T05:00:00.000Z',
          alignToPeriodId: 'current',
        },
      ],
    },
    comparison: {
      basePeriodId: 'current',
      comparisonPeriodIds: ['previous_year'],
      alignment: 'elapsed_period',
      outputs: ['value', 'absolute_delta', 'percent_delta'],
      zeroDenominatorPolicy: 'null',
    },
    ranking: {
      entityDimensionId: ids.customer,
      byMetricId: ids.metric,
      byPeriodId: 'current',
      direction: 'desc',
      limit: 2,
      tiePolicy: 'stable_secondary_key',
    },
    requestedOutputs: [
      { id: 'customer_name', kind: 'dimension' },
      { id: 'current_revenue', kind: 'metric_value', metricId: ids.metric, periodId: 'current' },
      { id: 'previous_revenue', kind: 'metric_value', metricId: ids.metric, periodId: 'previous_year' },
      { id: 'revenue_delta', kind: 'delta', metricId: ids.metric },
      { id: 'revenue_percent_delta', kind: 'percent_delta', metricId: ids.metric },
      { id: 'rank', kind: 'rank' },
    ],
    ambiguity: [],
  };
}

function capability(route: 'certified' | 'semantic' | 'governed_sql' = 'semantic'): MetricCapabilityContract {
  return {
    metricId: ids.metric,
    semanticModelId: 'commerce::semantic_model::orders',
    measureIds: [ids.measure],
    primaryEntityId: 'commerce::entity::order',
    defaultResultGrainId: 'commerce::grain::scalar',
    resultGrainIds: ['commerce::grain::scalar', ids.customerEntity],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [
      {
        dimensionId: ids.customer,
        entityId: ids.customerEntity,
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        relationshipPathIds: ['commerce::relationship::order_to_customer'],
      },
    ],
    timeDimensions: [
      {
        dimensionId: ids.date,
        role: 'report_as_of',
        supportedGrains: ['day', 'month', 'quarter', 'year'],
        defaultFor: ['scalar', 'trend', 'comparison'],
      },
    ],
    freshness: { defaultCompletenessPolicy: 'latest_complete' },
    operations: ['filter', 'group', 'trend', 'compare', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta', 'rank'],
    ...(route === 'certified'
      ? { declaredOutputIds: comparisonFrame().requestedOutputs.map((output) => output.id) }
      : {}),
    executionCapabilities: [{ route, adapterId: route === 'certified' ? 'block:revenue_comparison' : route === 'semantic' ? 'metricflow-cli' : 'relational-v1' }],
    sourceFingerprint: `${route}-capability-v1`,
  };
}

function plan(frame = comparisonFrame(), route: 'certified' | 'semantic' | 'governed_sql' = 'semantic'): ResolvedAnalyticalPlan {
  return {
    schemaVersion: 2,
    mode: 'authoritative',
    planId: 'rap:comparison-plan',
    fingerprint: 'comparison-plan-fingerprint',
    revision: 0,
    snapshotId: 'snapshot-1',
    question: frame.interpretedQuestion,
    interpretedQuestion: frame.interpretedQuestion,
    questionType: 'ranking',
    confidence: 'high',
    selectedConceptIds: [ids.metric],
    executionId: ids.metric,
    recommendedRoute: route === 'governed_sql' ? 'governed_sql' : route,
    capability: route === 'certified' ? 'certified_execution' : route === 'semantic' ? 'semantic_execution' : 'governed_relational',
    query: { measures: [], dimensions: [], filters: [] },
    entityGrain: ids.customerEntity,
    sourceRelationIds: [],
    relationshipPathIds: ['commerce::relationship::order_to_customer'],
    compatibilityProof: [],
    outputContract: {
      measures: [ids.metric],
      dimensions: [ids.customer],
      fields: frame.requestedOutputs.map((output) => output.id),
      periodIds: frame.timeContext?.periods.map((period) => period.id),
    },
    evidenceIds: [ids.metric],
    rejectedCandidates: [],
    missingInformation: [],
    analyticalFrame: frame,
  };
}

describe('analytical execution graph (AGT-018 / AGT-019)', () => {
  it('projects the governed time axis for a trend instead of treating it only as a filter', () => {
    const frame = comparisonFrame();
    frame.interpretedQuestion = 'Daily revenue trend.';
    frame.questionType = 'trend';
    frame.entityGrainIds = ['commerce::grain::scalar'];
    frame.dimensions = [{ dimensionId: ids.date, role: 'time_axis' }];
    frame.timeContext!.periods = [{
      id: 'current',
      kind: 'absolute',
      start: '2026-07-01T05:00:00.000Z',
      end: '2026-07-22T05:00:00.000Z',
    }];
    frame.comparison = undefined;
    frame.ranking = undefined;
    frame.requestedOutputs = [
      { id: 'report_date', kind: 'dimension' },
      { id: 'revenue', kind: 'metric_value', metricId: ids.metric, periodId: 'current' },
    ];
    const built = buildAnalyticalExecutionGraph({
      plan: plan(frame),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;
    expect(built.graph.nodes[0]).toMatchObject({
      groupByDimensionIds: [ids.date],
      outputAliases: {
        dimensions: [{ dimensionId: ids.date, outputId: 'report_date' }],
        metric: { outputId: 'revenue' },
      },
    });
  });

  it('compiles period aggregation before alignment, exact arithmetic, ranking, and validation', () => {
    const result = buildAnalyticalExecutionGraph({
      plan: plan(),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.graph.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
      'source_invocation:source:current',
      'source_invocation:source:previous_year',
      'align_periods:align:periods',
      'calculate_comparison:calculate:comparison',
      'rank:rank:result',
      'project_validate:validate:result_contract',
    ]);
    expect(result.graph.nodes[0]).toMatchObject({
      strategy: 'period_aggregate',
      groupByDimensionIds: [ids.customer],
      period: {
        id: 'current',
        timeDimensionId: ids.date,
        startInclusive: '2026-07-01T05:00:00.000Z',
        endExclusive: '2026-07-22T05:00:00.000Z',
      },
      outputAliases: { metric: { outputId: 'current_revenue' } },
    });
    expect(Object.isFrozen(result.graph)).toBe(true);
    expect(result.graph.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('aligns by entity, computes from unrounded decimals, ranks after aggregation, and binds all sub-receipts', () => {
    const built = buildAnalyticalExecutionGraph({
      plan: plan(),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    const result = executeAnalyticalExecutionGraph({
      graph: built.graph,
      sourceResults: {
        'source:current': {
          columns: ['customer_name', 'current_revenue'],
          rows: [
            { customer_name: 'Zoom', current_revenue: '100.10' },
            { customer_name: 'Beta', current_revenue: '50.00' },
            { customer_name: 'Acme', current_revenue: '50.00' },
          ],
          receiptFingerprint: 'receipt-current',
        },
        'source:previous_year': {
          columns: ['customer_name', 'previous_revenue'],
          rows: [
            { customer_name: 'Acme', previous_revenue: '0' },
            { customer_name: 'Zoom', previous_revenue: '80.05' },
            { customer_name: 'Beta', previous_revenue: '40' },
          ],
          receiptFingerprint: 'receipt-prior',
        },
      },
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.rows).toEqual([
      {
        customer_name: 'Zoom',
        current_revenue: '100.10',
        previous_revenue: '80.05',
        revenue_delta: '20.05',
        revenue_percent_delta: '25.046845721424',
        rank: 1,
      },
      {
        customer_name: 'Acme',
        current_revenue: '50.00',
        previous_revenue: '0',
        revenue_delta: '50',
        revenue_percent_delta: null,
        rank: 2,
      },
    ]);
    expect(result.receipt).toMatchObject({
      graphFingerprint: built.graph.fingerprint,
      planFingerprint: plan().fingerprint,
      route: 'semantic',
      trustState: 'governed',
      subReceipts: [
        { nodeId: 'source:current', receiptFingerprint: 'receipt-current' },
        { nodeId: 'source:previous_year', receiptFingerprint: 'receipt-prior' },
      ],
      outputColumns: comparisonFrame().requestedOutputs.map((output) => output.id),
      rowCount: 2,
    });
    expect(result.receipt.resultFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('applies include-ties deterministically after period aggregation', () => {
    const frame = comparisonFrame();
    frame.ranking = { ...frame.ranking!, tiePolicy: 'include_ties' };
    const built = buildAnalyticalExecutionGraph({
      plan: plan(frame),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    const result = executeAnalyticalExecutionGraph({
      graph: built.graph,
      sourceResults: {
        'source:current': {
          columns: ['customer_name', 'current_revenue'],
          rows: [
            { customer_name: 'Zoom', current_revenue: '100' },
            { customer_name: 'Beta', current_revenue: '50' },
            { customer_name: 'Acme', current_revenue: '50' },
          ],
          receiptFingerprint: 'receipt-current',
        },
        'source:previous_year': {
          columns: ['customer_name', 'previous_revenue'],
          rows: [
            { customer_name: 'Zoom', previous_revenue: '80' },
            { customer_name: 'Beta', previous_revenue: '40' },
            { customer_name: 'Acme', previous_revenue: '40' },
          ],
          receiptFingerprint: 'receipt-prior',
        },
      },
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.rows.map((row) => [row.customer_name, row.rank])).toEqual([
      ['Zoom', 1],
      ['Acme', 2],
      ['Beta', 2],
    ]);
  });

  it('fails closed for unresolved periods and source output drift', () => {
    const unbounded = comparisonFrame();
    unbounded.timeContext!.periods[0] = { id: 'current', kind: 'current' };
    expect(buildAnalyticalExecutionGraph({
      plan: plan(unbounded),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    })).toMatchObject({ status: 'blocked', code: 'PERIOD_BOUNDS_REQUIRED' });

    const built = buildAnalyticalExecutionGraph({
      plan: plan(),
      capability: capability(),
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    expect(executeAnalyticalExecutionGraph({
      graph: built.graph,
      sourceResults: {
        'source:current': {
          columns: ['customer_name'],
          rows: [],
          receiptFingerprint: 'receipt-current',
        },
        'source:previous_year': {
          columns: ['customer_name', 'previous_revenue'],
          rows: [],
          receiptFingerprint: 'receipt-prior',
        },
      },
    })).toMatchObject({
      status: 'failed',
      code: 'RESULT_CONTRACT_MISMATCH',
      nodeId: 'source:current',
      missingOutputIds: ['current_revenue'],
    });
  });

  it('reuses a fully compatible certified asset as one complete invocation', () => {
    const result = buildAnalyticalExecutionGraph({
      plan: plan(comparisonFrame(), 'certified'),
      capability: capability('certified'),
      route: 'certified',
      adapterId: 'block:revenue_comparison',
      fitClass: 'exact',
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.graph.nodes).toEqual([
      expect.objectContaining({
        id: 'source:complete_asset',
        kind: 'source_invocation',
        strategy: 'complete_asset',
        outputAliases: {
          dimensions: [{ dimensionId: ids.customer, outputId: 'customer_name' }],
          completeAssetOutputIds: comparisonFrame().requestedOutputs.map((output) => output.id),
        },
      }),
      expect.objectContaining({ id: 'validate:result_contract', kind: 'project_validate' }),
    ]);
  });
});
