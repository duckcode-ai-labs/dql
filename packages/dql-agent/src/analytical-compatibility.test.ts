import { describe, expect, it } from 'vitest';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@zlens/core';
import { normalizeEvidenceAnalyticalCapability, solveAnalyticalCompatibility } from './analytical-compatibility.js';
import { buildDeterministicAnalyticalFrame, projectResolvedAnalyticalFrame } from './analytical-frame.js';
import { buildAnalyticalCapabilityReadiness } from './analytical-readiness.js';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';

const ids = {
  metric: 'commerce::metric::net_revenue',
  measure: 'commerce::measure::net_revenue',
  orderCountMetric: 'commerce::metric::order_count',
  orderCountMeasure: 'commerce::measure::order_count',
  order: 'commerce::entity::order',
  customer: 'commerce::entity::customer',
  customerName: 'commerce::dimension::customer_name',
  reportDate: 'commerce::dimension::report_date',
  relationship: 'commerce::relationship::order_to_customer',
};

const semanticCapability: MetricCapabilityContract = {
  metricId: ids.metric,
  semanticModelId: 'commerce::semantic_model::orders',
  measureIds: [ids.measure],
  primaryEntityId: ids.order,
  defaultResultGrainId: 'commerce::grain::scalar',
  resultGrainIds: ['commerce::grain::scalar', ids.customer],
  aggregation: 'sum',
  additivity: { entities: 'additive', time: 'additive' },
  dimensions: [
    {
      dimensionId: ids.customerName,
      entityId: ids.customer,
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      relationshipPathIds: [ids.relationship],
      // Cross-model semantic readiness requires the exact MetricFlow-native
      // grouping that the compiler will consume. A generic DQL relationship
      // remains useful for relational/exploratory routes but is not semantic
      // compiler proof.
      nativeGroupingReference: 'order__customer__customer_name',
      nativeGroupingPath: ['order', 'customer'],
    },
  ],
  timeDimensions: [
    {
      dimensionId: ids.reportDate,
      role: 'report_as_of',
      supportedGrains: ['day', 'week', 'month', 'quarter', 'year'],
      defaultFor: ['scalar', 'trend', 'comparison'],
    },
  ],
  freshness: {
    observedThroughFieldId: ids.reportDate,
    defaultCompletenessPolicy: 'latest_complete',
  },
  operations: ['filter', 'group', 'trend', 'compare', 'rank'],
  supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta', 'rank'],
  executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
  sourceFingerprint: 'semantic-capability-v1',
};

function revenueTodayFrame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Revenue today.',
    questionType: 'scalar',
    metricConceptIds: [ids.metric],
    entityGrainIds: ['commerce::grain::scalar'],
    dimensions: [{ dimensionId: ids.reportDate, role: 'time_axis' }],
    memberBindings: [],
    timeContext: {
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [{ id: 'current', kind: 'current' }],
    },
    requestedOutputs: [
      {
        id: 'revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'current',
      },
    ],
    ambiguity: [],
  };
}

function zoomRevenueFrame(): AnalyticalQuestionFrameV2 {
  return {
    ...revenueTodayFrame(),
    interpretedQuestion: 'Revenue from Zoom customer.',
    dimensions: [
      { dimensionId: ids.customerName, role: 'filter' },
      { dimensionId: ids.reportDate, role: 'time_axis' },
    ],
    memberBindings: [
      {
        dimensionId: ids.customerName,
        canonicalValues: ['Zoom'],
        source: 'question',
        confidence: 'exact',
      },
    ],
  };
}

function topCustomersComparisonFrame(): AnalyticalQuestionFrameV2 {
  return {
    version: 2,
    interpretedQuestion: 'Current and last-year revenue for the top five customers.',
    questionType: 'ranking',
    metricConceptIds: [ids.metric],
    entityGrainIds: [ids.customer],
    dimensions: [
      { dimensionId: ids.customerName, role: 'group_by' },
      { dimensionId: ids.customerName, role: 'rank_entity' },
      { dimensionId: ids.reportDate, role: 'time_axis' },
    ],
    memberBindings: [],
    timeContext: {
      timeDimensionId: ids.reportDate,
      timeRole: 'report_as_of',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'day',
      completenessPolicy: 'latest_complete',
      periods: [
        {
          id: 'current',
          kind: 'current',
          start: '2026-07-01',
          end: '2026-07-22',
        },
        {
          id: 'previous_year',
          kind: 'previous_year',
          start: '2025-07-01',
          end: '2025-07-22',
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
      entityDimensionId: ids.customerName,
      byMetricId: ids.metric,
      byPeriodId: 'current',
      direction: 'desc',
      limit: 5,
      tiePolicy: 'stable_secondary_key',
    },
    requestedOutputs: [
      { id: 'customer_name', kind: 'dimension' },
      {
        id: 'current_revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'current',
      },
      {
        id: 'previous_revenue',
        kind: 'metric_value',
        metricId: ids.metric,
        periodId: 'previous_year',
      },
      { id: 'revenue_delta', kind: 'delta', metricId: ids.metric },
      { id: 'revenue_delta_pct', kind: 'percent_delta', metricId: ids.metric },
    ],
    ambiguity: [],
  };
}

const metricCandidate: AgentEvidenceCandidate = {
  id: 'metric:net_revenue',
  qualifiedId: ids.metric,
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Net Revenue',
  primaryEntity: ids.order,
  dimensions: [ids.customerName, ids.reportDate],
  timeGrains: ['day', 'month', 'year'],
  relevanceScore: 1,
  matchReasons: ['exact metric meaning'],
  compatibility: 'compatible',
  analyticalCapability: semanticCapability,
};

const orderCountCapability: MetricCapabilityContract = {
  ...semanticCapability,
  metricId: ids.orderCountMetric,
  measureIds: [ids.orderCountMeasure],
  aggregation: 'count',
  sourceFingerprint: 'semantic-order-count-capability-v1',
};

const orderCountCandidate: AgentEvidenceCandidate = {
  ...metricCandidate,
  id: 'metric:order_count',
  qualifiedId: ids.orderCountMetric,
  name: 'Order Count',
  aliases: ['orders'],
  analyticalCapability: orderCountCapability,
};

const customerCandidate: AgentEvidenceCandidate = {
  id: 'dimension:customer_name',
  qualifiedId: ids.customerName,
  kind: 'semantic_member',
  trustTier: 'semantic',
  name: 'Customer Name',
  aliases: ['customer', 'customers'],
  relevanceScore: 0.2,
  matchReasons: ['customer dimension'],
  compatibility: 'compatible',
};

const revenuePolicy = {
  policyId: 'commerce::skill::revenue_reporting',
  sourceHash: 'revenue-policy-v1',
  metricIds: [ids.metric],
  timeRole: 'report_as_of',
  calendarId: 'calendar:gregorian',
  timezone: 'America/Chicago',
  completenessPolicy: 'latest_complete' as const,
  comparisonAlignment: 'elapsed_period' as const,
  defaultRankingPeriod: 'current' as const,
};

describe('deterministic analytical compatibility (CONTRACT-002 / AGT-017 / AGT-018)', () => {
  it('reports exact scenario readiness and incomplete legacy metadata', () => {
    const report = buildAnalyticalCapabilityReadiness([metricCandidate]);
    expect(report).toEqual([
      expect.objectContaining({
        candidateId: ids.metric,
        metricId: ids.metric,
        status: 'complete',
        support: {
          scalar: true,
          filter: true,
          grouping: true,
          trend: true,
          comparison: true,
          ranking: true,
        },
        blockers: {},
      }),
    ]);
    const incomplete = buildAnalyticalCapabilityReadiness([
      {
        ...metricCandidate,
        id: 'legacy-metric',
        qualifiedId: undefined,
        analyticalCapability: undefined,
      },
    ]);
    expect(incomplete[0]).toMatchObject({
      candidateId: 'legacy-metric',
      status: 'incomplete',
      support: { scalar: false, comparison: false },
    });
  });

  it('constructs all three canonical frames without an AI call', () => {
    const today = buildDeterministicAnalyticalFrame({
      question: 'What is revenue today?',
      evidence: {
        candidates: [metricCandidate],
        parsedIntent: { measures: ['net revenue'] },
        analyticalPolicies: [revenuePolicy],
      },
      metricCandidate,
      candidates: [metricCandidate],
    });
    expect(today).toMatchObject({
      questionType: 'scalar',
      entityGrainIds: ['commerce::grain::scalar'],
      timeContext: {
        timeDimensionId: ids.reportDate,
        timezone: 'America/Chicago',
        completenessPolicy: 'latest_complete',
        periods: [{ id: 'current', kind: 'current' }],
      },
    });

    const zoom = buildDeterministicAnalyticalFrame({
      question: 'What is revenue from Zoom customer?',
      evidence: {
        candidates: [metricCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue'],
          dimensions: ['customer'],
          filters: [{ field: 'customer', value: 'Zoom' }],
        },
      },
      metricCandidate,
      candidates: [metricCandidate, customerCandidate],
    });
    expect(zoom).toMatchObject({
      entityGrainIds: ['commerce::grain::scalar'],
      dimensions: [{ dimensionId: ids.customerName, role: 'filter' }],
      memberBindings: [{ dimensionId: ids.customerName, canonicalValues: ['Zoom'] }],
    });

    const comparison = buildDeterministicAnalyticalFrame({
      question: 'Show current revenue and last year revenue for top 5 customers.',
      evidence: {
        candidates: [metricCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue'],
          dimensions: ['customer'],
          order: 'desc',
          limit: 5,
        },
        analyticalPolicies: [revenuePolicy],
      },
      metricCandidate,
      candidates: [metricCandidate, customerCandidate],
    });
    expect(comparison).toMatchObject({
      questionType: 'ranking',
      entityGrainIds: [ids.customer],
      comparison: {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
      },
      ranking: {
        entityDimensionId: ids.customerName,
        byPeriodId: 'current',
        limit: 5,
      },
      requestedOutputs: [
        { id: 'customer_name', kind: 'dimension' },
        { id: 'net_revenue__current', kind: 'metric_value' },
        { id: 'net_revenue__previous_year', kind: 'metric_value' },
        { id: 'net_revenue__delta', kind: 'delta' },
        { id: 'net_revenue__percent_delta', kind: 'percent_delta' },
      ],
    });
  });

  it('preserves every explicitly requested metric in the deterministic frame', () => {
    const frame = buildDeterministicAnalyticalFrame({
      question: 'Show net revenue and order count by customer.',
      evidence: {
        candidates: [metricCandidate, orderCountCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue', 'order count'],
          dimensions: ['customer'],
        },
      },
      metricCandidate,
      metricCandidates: [metricCandidate, orderCountCandidate],
      candidates: [metricCandidate, orderCountCandidate, customerCandidate],
    });

    expect(frame.metricConceptIds).toEqual([ids.metric, ids.orderCountMetric]);
    expect(frame.requestedOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'metric_value', metricId: ids.metric }),
      expect.objectContaining({ kind: 'metric_value', metricId: ids.orderCountMetric }),
    ]));
  });

  it('selects one compatible semantic execution tuple for a multi-metric frame', () => {
    const frame = buildDeterministicAnalyticalFrame({
      question: 'Show net revenue and order count by customer.',
      evidence: {
        candidates: [metricCandidate, orderCountCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue', 'order count'],
          dimensions: ['customer'],
        },
      },
      metricCandidate,
      metricCandidates: [metricCandidate, orderCountCandidate],
      candidates: [metricCandidate, orderCountCandidate, customerCandidate],
    });
    const result = solveAnalyticalCompatibility({
      frame,
      candidates: [
        { candidateId: ids.metric, capability: semanticCapability },
        { candidateId: ids.orderCountMetric, capability: orderCountCapability },
      ],
    });

    expect(result).toMatchObject({
      status: 'ready',
      route: 'semantic',
      adapterId: 'metricflow-cli',
      candidateIds: [ids.metric, ids.orderCountMetric],
      capabilities: [
        expect.objectContaining({ metricId: ids.metric }),
        expect.objectContaining({ metricId: ids.orderCountMetric }),
      ],
    });
  });

  it('fails closed when requested metrics cannot share a governed execution tuple', () => {
    const frame = buildDeterministicAnalyticalFrame({
      question: 'Show net revenue and order count by customer.',
      evidence: {
        candidates: [metricCandidate, orderCountCandidate, customerCandidate],
        parsedIntent: {
          measures: ['net revenue', 'order count'],
          dimensions: ['customer'],
        },
      },
      metricCandidate,
      metricCandidates: [metricCandidate, orderCountCandidate],
      candidates: [metricCandidate, orderCountCandidate, customerCandidate],
    });
    const result = solveAnalyticalCompatibility({
      frame,
      candidates: [
        { candidateId: ids.metric, capability: semanticCapability },
        {
          candidateId: ids.orderCountMetric,
          capability: {
            ...orderCountCapability,
            semanticModelId: 'commerce::semantic_model::shipments',
          },
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'blocked',
      failures: [expect.objectContaining({ code: 'MULTI_METRIC_INCOMPATIBLE' })],
    });
  });

  it('resolves revenue today through the unique governed default time dimension', () => {
    const result = solveAnalyticalCompatibility({
      frame: revenueTodayFrame(),
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    });
    expect(result).toMatchObject({
      status: 'ready',
      route: 'semantic',
      adapterId: 'metricflow-cli',
      frame: {
        timeContext: {
          timeDimensionId: ids.reportDate,
          completenessPolicy: 'latest_complete',
        },
      },
    });
  });

  it('keeps Zoom as a customer filter instead of changing the result grain', () => {
    const result = solveAnalyticalCompatibility({
      frame: zoomRevenueFrame(),
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.frame.entityGrainIds).toEqual(['commerce::grain::scalar']);
    expect(result.frame.memberBindings).toEqual([
      expect.objectContaining({
        dimensionId: ids.customerName,
        canonicalValues: ['Zoom'],
      }),
    ]);
    expect(result.proof).toContain(`operation:filter`);
    expect(result.proof).not.toContain(`dimension:${ids.customerName}:group_by`);
  });

  it('rejects a partial certified block and selects the complete semantic route', () => {
    const certifiedPartial: MetricCapabilityContract = {
      ...semanticCapability,
      operations: ['filter', 'group', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
      declaredOutputIds: ['customer_name', 'current_revenue'],
      executionCapabilities: [{ route: 'certified', adapterId: 'block:revenue_by_customer' }],
      sourceFingerprint: 'certified-partial-v1',
    };
    const result = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [
        {
          candidateId: 'commerce::block::revenue_by_customer',
          capability: certifiedPartial,
          fitClass: 'parameterized',
        },
        { candidateId: ids.metric, capability: semanticCapability },
      ],
    });
    expect(result).toMatchObject({
      status: 'ready',
      candidateId: ids.metric,
      route: 'semantic',
    });
  });

  it('selects a fully compatible certified block before semantic compilation', () => {
    const certifiedComplete: MetricCapabilityContract = {
      ...semanticCapability,
      declaredOutputIds: topCustomersComparisonFrame().requestedOutputs.map((output) => output.id),
      executionCapabilities: [{ route: 'certified', adapterId: 'block:revenue_yoy_top_customers' }],
      sourceFingerprint: 'certified-complete-v1',
    };
    const result = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [
        {
          candidateId: 'commerce::block::revenue_yoy_top_customers',
          capability: certifiedComplete,
        },
        { candidateId: ids.metric, capability: semanticCapability },
      ],
    });
    expect(result).toMatchObject({
      status: 'ready',
      candidateId: 'commerce::block::revenue_yoy_top_customers',
      route: 'certified',
      fitClass: 'exact',
    });
  });

  it('clarifies when multiple time dimensions have no unique governed default', () => {
    const capability: MetricCapabilityContract = {
      ...semanticCapability,
      timeDimensions: [
        {
          dimensionId: ids.reportDate,
          role: 'report_as_of',
          supportedGrains: ['day'],
        },
        {
          dimensionId: 'commerce::dimension::order_date',
          role: 'event_time',
          supportedGrains: ['day'],
        },
      ],
    };
    const frame = revenueTodayFrame();
    frame.timeContext = { ...frame.timeContext!, timeRole: undefined };
    const result = solveAnalyticalCompatibility({
      frame,
      candidates: [{ candidateId: ids.metric, capability }],
    });
    expect(result).toMatchObject({
      status: 'blocked',
      failures: [expect.objectContaining({ code: 'TIME_DIMENSION_AMBIGUOUS' })],
    });
  });

  it('fails closed on ambiguous members, missing relationship proof, and non-additive grouping (E2E-013)', () => {
    const ambiguous = zoomRevenueFrame();
    ambiguous.ambiguity = [{
      field: `memberBindings.${ids.customerName}`,
      reasonCode: 'MEMBER_AMBIGUOUS',
      candidateIds: ['commerce::member::zoom-us', 'commerce::member::zoom-emea'],
    }];
    expect(solveAnalyticalCompatibility({
      frame: ambiguous,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({
      status: 'clarify',
      failure: { code: 'FRAME_AMBIGUOUS', candidateIds: ['commerce::member::zoom-us', 'commerce::member::zoom-emea'] },
    });

    const missingBinding = zoomRevenueFrame();
    missingBinding.ambiguity = [{
      field: 'dimensions.region',
      reasonCode: 'DIMENSION_UNRESOLVED',
      candidateIds: [],
    }];
    expect(solveAnalyticalCompatibility({
      frame: missingBinding,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({
      status: 'blocked',
      failure: { code: 'FRAME_AMBIGUOUS', candidateIds: [] },
    });

    const noRelationship: MetricCapabilityContract = {
      ...semanticCapability,
      dimensions: semanticCapability.dimensions.map((dimension) => ({
        ...dimension,
        relationshipPathIds: [],
        nativeGroupingReference: undefined,
        nativeGroupingPath: undefined,
      })),
    };
    const missingRelationship = solveAnalyticalCompatibility({
      frame: zoomRevenueFrame(),
      candidates: [{ candidateId: ids.metric, capability: noRelationship }],
    });
    expect(missingRelationship.status).toBe('blocked');
    if (missingRelationship.status === 'blocked') {
      expect(missingRelationship.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'RELATIONSHIP_PROOF_MISSING' }),
      ]));
    }

    const nonAdditive: MetricCapabilityContract = {
      ...semanticCapability,
      additivity: {
        entities: 'non_additive',
        time: 'non_additive',
        nonAdditiveDimensionIds: [ids.customerName],
      },
    };
    const nonAdditiveResult = solveAnalyticalCompatibility({
      frame: topCustomersComparisonFrame(),
      candidates: [{ candidateId: ids.metric, capability: nonAdditive }],
    });
    expect(nonAdditiveResult.status).toBe('blocked');
    if (nonAdditiveResult.status === 'blocked') {
      expect(nonAdditiveResult.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'NON_ADDITIVE_DIMENSION' }),
      ]));
    }
  });

  it('accepts an exact adapter-native grouping proof only on its pinned semantic route', () => {
    const nativeSemanticCapability: MetricCapabilityContract = {
      ...semanticCapability,
      primaryEntityId: 'semantic:uncategorized:entity:order_item',
      defaultResultGrainId: 'semantic:uncategorized:entity:order_item',
      resultGrainIds: [
        'semantic:uncategorized:entity:order_item',
        'semantic:uncategorized:entity:customer',
      ],
      dimensions: [{
        dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
        entityId: 'semantic:uncategorized:entity:customer',
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'order_id__customer__customer_name',
        nativeGroupingPath: ['order_id', 'customer'],
      }],
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
      sourceFingerprint: 'jaffle-revenue-capability-v1',
    };
    const frame = topCustomersComparisonFrame();
    frame.metricConceptIds = [nativeSemanticCapability.metricId];
    frame.entityGrainIds = ['semantic:uncategorized:entity:customer'];
    frame.dimensions = frame.dimensions.map((binding) => binding.role === 'time_axis'
      ? binding
      : { ...binding, dimensionId: nativeSemanticCapability.dimensions[0]!.dimensionId });
    frame.memberBindings = [];
    frame.ranking = {
      ...frame.ranking!,
      entityDimensionId: nativeSemanticCapability.dimensions[0]!.dimensionId,
      byMetricId: nativeSemanticCapability.metricId,
    };
    frame.requestedOutputs = frame.requestedOutputs.map((output) => 'metricId' in output
      ? { ...output, metricId: nativeSemanticCapability.metricId }
      : output);

    expect(solveAnalyticalCompatibility({
      frame,
      candidates: [{ candidateId: nativeSemanticCapability.metricId, capability: nativeSemanticCapability }],
    })).toMatchObject({ status: 'ready', route: 'semantic', adapterId: 'metricflow-cli' });
  });

  it('keeps the canonical output contract equivalent across certified, semantic, and governed SQL routes (E2E-013)', () => {
    const frame = topCustomersComparisonFrame();
    const variants = [
      { route: 'certified' as const, adapterId: 'block:top_customers' },
      { route: 'semantic' as const, adapterId: 'metricflow-cli' },
      { route: 'governed_sql' as const, adapterId: 'sql-ast-v1' },
    ].map((execution) => solveAnalyticalCompatibility({
      frame,
      candidates: [{
        candidateId: `${ids.metric}:${execution.route}`,
        capability: {
          ...semanticCapability,
          ...(execution.route === 'certified'
            ? { declaredOutputIds: frame.requestedOutputs.map((output) => output.id) }
            : {}),
          executionCapabilities: [execution],
          sourceFingerprint: `capability-${execution.route}`,
        },
      }],
    }));
    expect(variants.map((result) => result.status)).toEqual(['ready', 'ready', 'ready']);
    expect(variants.map((result) => result.status === 'ready'
      ? {
          route: result.route,
          outputs: result.frame.requestedOutputs,
          ranking: result.frame.ranking,
          comparison: result.frame.comparison,
        }
      : result)).toEqual([
        expect.objectContaining({ route: 'certified', outputs: frame.requestedOutputs }),
        expect.objectContaining({ route: 'semantic', outputs: frame.requestedOutputs }),
        expect.objectContaining({ route: 'governed_sql', outputs: frame.requestedOutputs }),
      ]);
  });

  it('reports legacy evidence as incomplete instead of inventing capability from names', () => {
    const legacy = normalizeEvidenceAnalyticalCapability({
      ...metricCandidate,
      analyticalCapability: undefined,
    });
    expect(legacy).toMatchObject({ status: 'incomplete' });
    expect(legacy.missing).toContain('additivity');
    expect(legacy.missing).toContain('supportedOperations');
  });

  it('binds an exact v2 frame into the immutable resolved plan without breaking v1 plans', () => {
    const frame = topCustomersComparisonFrame();
    const evidence: AgentRetrievalEvidence = {
      snapshotId: 'snapshot-analytical-v2',
      candidates: [metricCandidate],
    };
    const resolution: MeaningResolution = {
      interpretedQuestion: frame.interpretedQuestion,
      questionType: 'ranking',
      selectedConceptIds: [metricCandidate.id],
      recommendedExecutionId: metricCandidate.id,
      queryIntent: {
        measures: ['net revenue'],
        dimensions: ['customer name', 'report date'],
        filters: [],
        timeGrain: 'day',
        order: 'desc',
        limit: 5,
      },
      analyticalFrame: frame,
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'semantic',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution,
      evidence,
      candidates: [metricCandidate],
      mode: 'authoritative',
    });
    expect(plan).toMatchObject({
      schemaVersion: 2,
      entityGrain: ids.customer,
      analyticalFrame: {
        comparison: { basePeriodId: 'current' },
        ranking: { byPeriodId: 'current', limit: 5 },
      },
      outputContract: {
        fields: ['customer_name', 'current_revenue', 'previous_revenue', 'revenue_delta', 'revenue_delta_pct'],
        periodIds: ['current', 'previous_year'],
      },
    });
    expect(Object.isFrozen(plan.analyticalFrame)).toBe(true);

    const projected = projectResolvedAnalyticalFrame({ plan, sourceFrame: frame });
    expect(projected.metricConceptIds).toEqual([ids.metric]);
    expect(projected.ambiguity).toEqual([]);

    // AGT-011: the old natural-language phrase remains in the immutable query
    // audit list after a server-issued display-key click.  It must not reopen
    // the exact capability ambiguity when one (and only one) offered ID is
    // already bound by both the host frame and the RAP.
    const selectedDisplaySourceFrame = {
      ...frame,
      ambiguity: [{
        field: 'dimensions.customer',
        candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
        reasonCode: 'DIMENSION_AMBIGUOUS',
      }],
    };
    const selectedDisplayPlan = {
      ...plan,
      query: {
        ...plan.query,
        dimensions: [{
          requested: 'customer',
          status: 'ambiguous' as const,
          candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
        }, ...plan.query.dimensions],
      },
    };
    expect(projectResolvedAnalyticalFrame({
      plan: selectedDisplayPlan,
      sourceFrame: selectedDisplaySourceFrame,
    }).ambiguity).toEqual([]);

    // The identity escape is not a lexical tie-breaker. If the frozen plan
    // somehow resolves more than one of the original offered IDs, the frame
    // remains ambiguous instead of silently choosing either display key.
    const multiplyResolvedProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...selectedDisplayPlan,
        query: {
          ...selectedDisplayPlan.query,
          dimensions: [
            ...selectedDisplayPlan.query.dimensions,
            {
              requested: 'customer type',
              qualifiedId: 'commerce::dimension::customer_type',
              status: 'resolved' as const,
              candidateIds: ['commerce::dimension::customer_type'],
            },
          ],
        },
      },
      sourceFrame: {
        ...selectedDisplaySourceFrame,
        dimensions: [
          ...selectedDisplaySourceFrame.dimensions,
          { dimensionId: 'commerce::dimension::customer_type', role: 'group_by' },
        ],
      },
    });
    expect(multiplyResolvedProjection.ambiguity).toContainEqual({
      field: 'dimensions.customer',
      candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
      reasonCode: 'DIMENSION_AMBIGUOUS',
    });

    // A same-name RAP binding for an unrelated third dimension is not proof
    // that the server-issued A/B selection was consumed. The ambiguity remains
    // until one offered source ID is resolved exactly.
    const unrelatedThirdIdProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...selectedDisplayPlan,
        query: {
          ...selectedDisplayPlan.query,
          dimensions: [{
            requested: 'customer',
            qualifiedId: 'commerce::dimension::customer_region',
            status: 'resolved' as const,
            candidateIds: ['commerce::dimension::customer_region'],
          // Do not retain the original offered customer_name binding here:
          // this fixture deliberately models a RAP that resolved only C, not
          // either source-offered A/B candidate.
          }, ...plan.query.dimensions.filter((binding) => binding.qualifiedId !== ids.customerName)],
        },
      },
      sourceFrame: selectedDisplaySourceFrame,
    });
    expect(unrelatedThirdIdProjection.ambiguity).toContainEqual({
      field: 'dimensions.customer',
      candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
      reasonCode: 'DIMENSION_AMBIGUOUS',
    });

    // No offered dimension resolved is equally non-authoritative. This must
    // remain a clarification, rather than let the raw request text select a
    // display field after the original A/B candidates disappeared.
    const zeroResolvedDimensionProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...selectedDisplayPlan,
        query: {
          ...selectedDisplayPlan.query,
          dimensions: [{
            requested: 'customer',
            status: 'unresolved' as const,
            candidateIds: [],
          }, ...plan.query.dimensions.filter((binding) => binding.qualifiedId !== ids.customerName)],
        },
      },
      sourceFrame: selectedDisplaySourceFrame,
    });
    expect(zeroResolvedDimensionProjection.ambiguity).toContainEqual({
      field: 'dimensions.customer',
      candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
      reasonCode: 'DIMENSION_AMBIGUOUS',
    });
    // The cascade-facing compatibility solver sees this as an actionable
    // clarification, never as a silent same-name selection.
    expect(solveAnalyticalCompatibility({
      frame: unrelatedThirdIdProjection,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({ status: 'clarify', failure: { code: 'FRAME_AMBIGUOUS' } });
    expect(solveAnalyticalCompatibility({
      frame: zeroResolvedDimensionProjection,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({ status: 'clarify', failure: { code: 'FRAME_AMBIGUOUS' } });

    // Older frames may not have retained offered IDs. Keep their legacy
    // lexical fallback so persisted V1/V2 runs remain readable.
    const legacyNoCandidateProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...plan,
        query: {
          ...plan.query,
          dimensions: [{
            requested: 'customer',
            qualifiedId: ids.customerName,
            status: 'resolved' as const,
            candidateIds: [ids.customerName],
          }, ...plan.query.dimensions],
        },
      },
      sourceFrame: {
        ...frame,
        ambiguity: [{
          field: 'dimensions.customer',
          candidateIds: [],
          reasonCode: 'DIMENSION_UNRESOLVED',
        }],
      },
    });
    expect(legacyNoCandidateProjection.ambiguity).toEqual([]);

    // The same identity rule applies to metric ambiguity. A same-name third
    // metric cannot consume an offered Revenue/Margin choice; legacy empty
    // candidate lists retain their lexical V1/V2 fallback.
    const metricAmbiguity = {
      field: 'metrics.net revenue',
      candidateIds: [ids.metric, 'commerce::metric::gross_profit'],
      reasonCode: 'METRIC_AMBIGUOUS',
    };
    expect(projectResolvedAnalyticalFrame({
      plan,
      sourceFrame: { ...frame, ambiguity: [metricAmbiguity] },
    }).ambiguity).toEqual([]);
    // A metric-like ID attached only as a host dimension is not a selected
    // metric. Cross-role identity reuse must retain the source ambiguity.
    const crossLaneMetricProjection = projectResolvedAnalyticalFrame({
      plan,
      sourceFrame: {
        ...frame,
        metricConceptIds: [],
        dimensions: [
          ...frame.dimensions,
          { dimensionId: ids.metric, role: 'group_by' as const },
        ],
        ambiguity: [metricAmbiguity],
      },
    });
    expect(crossLaneMetricProjection.ambiguity).toContainEqual(metricAmbiguity);
    const thirdMetricProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...plan,
        query: {
          ...plan.query,
          measures: [{
            requested: 'net revenue',
            qualifiedId: 'commerce::metric::gross_profit',
            status: 'resolved' as const,
            candidateIds: ['commerce::metric::gross_profit'],
          }],
        },
      },
      sourceFrame: { ...frame, ambiguity: [metricAmbiguity] },
    });
    expect(thirdMetricProjection.ambiguity).toContainEqual(metricAmbiguity);
    const zeroResolvedMetricProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...plan,
        query: {
          ...plan.query,
          measures: [{
            requested: 'net revenue',
            status: 'unresolved' as const,
            candidateIds: [],
          }],
        },
      },
      sourceFrame: { ...frame, ambiguity: [metricAmbiguity] },
    });
    expect(zeroResolvedMetricProjection.ambiguity).toContainEqual(metricAmbiguity);
    expect(solveAnalyticalCompatibility({
      frame: thirdMetricProjection,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({ status: 'clarify', failure: { code: 'FRAME_AMBIGUOUS' } });
    expect(solveAnalyticalCompatibility({
      frame: zeroResolvedMetricProjection,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({ status: 'clarify', failure: { code: 'FRAME_AMBIGUOUS' } });
    expect(projectResolvedAnalyticalFrame({
      plan,
      sourceFrame: {
        ...frame,
        ambiguity: [{ ...metricAmbiguity, candidateIds: [], reasonCode: 'METRIC_UNRESOLVED' }],
      },
    }).ambiguity).toEqual([]);

    // Filter binding uses the same candidate identity contract. Unlike the
    // original lexical query text, a source-offered region A/B choice cannot
    // be discharged by a same-named C filter. Persisted legacy frames with no
    // candidate IDs still retain their historical filter fallback.
    const filterA = 'commerce::dimension::customer_region';
    const filterB = 'commerce::dimension::customer_segment';
    const filterC = 'commerce::dimension::customer_country';
    const filterAmbiguity = {
      field: 'filters.region',
      candidateIds: [filterA, filterB],
      reasonCode: 'FILTER_AMBIGUOUS' as const,
    };
    const filterSourceFrame = {
      ...frame,
      memberBindings: [{
        dimensionId: filterA,
        canonicalValues: ['North'],
        source: 'question' as const,
        confidence: 'exact' as const,
      }],
      ambiguity: [filterAmbiguity],
    };
    const filterPlan = (binding: {
      status: 'resolved' | 'ambiguous' | 'unresolved';
      qualifiedId?: string;
      candidateIds: string[];
    }) => ({
      ...plan,
      query: {
        ...plan.query,
        filters: [{
          field: 'region',
          value: 'North',
          binding: {
            requested: 'region',
            ...binding,
          },
        }],
      },
    });
    expect(projectResolvedAnalyticalFrame({
      plan: filterPlan({ status: 'resolved', qualifiedId: filterA, candidateIds: [filterA] }),
      sourceFrame: filterSourceFrame,
    }).ambiguity).toEqual([]);

    // The ID alone is not enough: filter A only appearing as a group-by on
    // the host frame cannot discharge a source filter ambiguity. This guards
    // against an identifier reused in two analytical roles.
    const crossLaneFilterProjection = projectResolvedAnalyticalFrame({
      plan: filterPlan({ status: 'resolved', qualifiedId: filterA, candidateIds: [filterA] }),
      sourceFrame: {
        ...frame,
        dimensions: [
          ...frame.dimensions,
          { dimensionId: filterA, role: 'group_by' as const },
        ],
        memberBindings: [],
        ambiguity: [filterAmbiguity],
      },
    });
    expect(crossLaneFilterProjection.ambiguity).toContainEqual(filterAmbiguity);

    const thirdFilterProjection = projectResolvedAnalyticalFrame({
      plan: filterPlan({ status: 'resolved', qualifiedId: filterC, candidateIds: [filterC] }),
      sourceFrame: filterSourceFrame,
    });
    expect(thirdFilterProjection.ambiguity).toContainEqual(filterAmbiguity);
    const zeroResolvedFilterProjection = projectResolvedAnalyticalFrame({
      plan: filterPlan({ status: 'unresolved', candidateIds: [] }),
      sourceFrame: filterSourceFrame,
    });
    expect(zeroResolvedFilterProjection.ambiguity).toContainEqual(filterAmbiguity);
    const multiResolvedFilterProjection = projectResolvedAnalyticalFrame({
      plan: {
        ...filterPlan({ status: 'resolved', qualifiedId: filterA, candidateIds: [filterA] }),
        query: {
          ...filterPlan({ status: 'resolved', qualifiedId: filterA, candidateIds: [filterA] }).query,
          filters: [{
            field: 'region',
            value: 'North',
            binding: { requested: 'region', status: 'resolved' as const, qualifiedId: filterA, candidateIds: [filterA] },
          }, {
            field: 'segment',
            value: 'Enterprise',
            binding: { requested: 'region', status: 'resolved' as const, qualifiedId: filterB, candidateIds: [filterB] },
          }],
        },
      },
      sourceFrame: {
        ...filterSourceFrame,
        memberBindings: [
          ...filterSourceFrame.memberBindings,
          { dimensionId: filterB, canonicalValues: ['Enterprise'], source: 'question' as const, confidence: 'exact' as const },
        ],
      },
    });
    expect(multiResolvedFilterProjection.ambiguity).toContainEqual(filterAmbiguity);
    expect(solveAnalyticalCompatibility({
      frame: thirdFilterProjection,
      candidates: [{ candidateId: ids.metric, capability: semanticCapability }],
    })).toMatchObject({ status: 'clarify', failure: { code: 'FRAME_AMBIGUOUS' } });

    expect(projectResolvedAnalyticalFrame({
      plan: filterPlan({ status: 'resolved', qualifiedId: filterA, candidateIds: [filterA] }),
      sourceFrame: {
        ...frame,
        ambiguity: [{ ...filterAmbiguity, candidateIds: [], reasonCode: 'FILTER_UNRESOLVED' }],
      },
    }).ambiguity).toEqual([]);

    const ambiguousPlan = {
      ...plan,
      query: {
        ...plan.query,
        dimensions: [
          {
            requested: 'customer',
            status: 'ambiguous' as const,
            candidateIds: [ids.customerName, 'commerce::dimension::customer_type'],
          },
          ...plan.query.dimensions.slice(1),
        ],
      },
    };
    const ambiguousProjection = projectResolvedAnalyticalFrame({
      plan: ambiguousPlan,
      sourceFrame: frame,
    });
    expect(ambiguousProjection.ambiguity).toContainEqual({
      field: 'dimensions.customer',
      candidateIds: [ids.customerName, 'commerce::dimension::customer_type'].sort(),
      reasonCode: 'DIMENSION_AMBIGUOUS',
    });
    expect(ambiguousProjection.dimensions).not.toContainEqual(
      expect.objectContaining({ dimensionId: ids.customerName, role: 'group_by' }),
    );
  });
});
