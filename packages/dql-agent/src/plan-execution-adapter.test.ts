import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import { buildResolvedAnalyticalPlan } from './resolved-analytical-plan.js';
import { buildAnalyticalExecutionGraph } from './analytical-execution-graph.js';
import {
  adaptAnalyticalFreshnessRequest,
  adaptAnalyticalSemanticGraph,
  adaptResolvedAnalyticalPlan,
  appendStableSemanticSecondaryOrder,
  buildPlanExecutionRegistry,
} from './plan-execution-adapter.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import type { KGNode } from './kg/types.js';
import type { AnalyticalQuestionFrameV2, MetricCapabilityContract } from '@zlens/core';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:usage.rollover_balance',
  qualifiedId: 'semantic:consumption:rollover_balance',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Balance',
  aliases: ['rollover balance'],
  domain: 'consumption',
  dimensions: ['semantic:consumption:dimension:customer_name'],
  relevanceScore: 0.99,
  matchReasons: ['exact meaning'],
  compatibility: 'compatible',
  analyticalCapability: {
    metricId: 'semantic:consumption:rollover_balance',
    semanticModelId: 'semantic:consumption:model:usage',
    measureIds: ['semantic:consumption:rollover_balance'],
    primaryEntityId: 'account',
    defaultResultGrainId: 'account',
    resultGrainIds: ['account'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [{
      dimensionId: 'semantic:consumption:dimension:customer_name',
      entityId: 'account',
      label: 'Customer',
      aliases: ['customer'],
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      nativeGroupingReference: 'customer_name',
      nativeGroupingPath: [],
    }],
    timeDimensions: [{
      dimensionId: 'semantic:consumption:dimension:report_date',
      role: 'report_as_of',
      supportedGrains: ['day', 'month', 'year'],
    }],
    operations: ['filter', 'group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    sourceFingerprint: 'sha256:consumption-rollover-adapter-fixture',
  },
};
const dimension: AgentEvidenceCandidate = {
  id: 'semantic:dimension:usage.customer_name',
  qualifiedId: 'semantic:consumption:dimension:customer_name',
  kind: 'semantic_member',
  trustTier: 'semantic',
  name: 'Customer',
  aliases: ['customer'],
  domain: 'consumption',
  relevanceScore: 0.95,
  matchReasons: ['requested grouping'],
  compatibility: 'compatible',
};
const evidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-1',
  candidates: [metric, dimension],
};
const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by rollover balance.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['rollover balance'],
    dimensions: ['customer'],
    filters: [],
    order: 'desc',
    limit: 10,
  },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

function semanticPlan() {
  return buildResolvedAnalyticalPlan({
    question: 'Who are the top customers by rollover balance?',
    resolution,
    evidence,
    candidates: [metric, dimension],
    mode: 'authoritative',
  });
}

function semanticNodes(): KGNode[] {
  return [{
    nodeId: 'metric:usage.rollover_balance',
    kind: 'metric',
    name: 'rollover_balance',
    domain: 'consumption',
    payload: {
      qualifiedId: 'semantic:consumption:rollover_balance',
      localId: 'rollover_balance',
      aliases: ['usage.rollover_balance'],
    },
  }, {
    nodeId: 'dimension:usage.customer_name',
    kind: 'dimension',
    name: 'customer_name',
    domain: 'consumption',
    payload: {
      registryQualifiedId: 'semantic:consumption:dimension:customer_name',
      qualifiedId: 'semantic:consumption:dimension:customer_name',
      localId: 'customer_name',
    },
  }];
}

describe('plan execution adapter (AGT-013 / AGT-014 / API-006)', () => {
  it('adds only canonical frozen grouping dimensions as stable secondary order', () => {
    expect(appendStableSemanticSecondaryOrder(
      [{ name: 'revenue', direction: 'desc' }],
      ['customer_name'],
      'stable_secondary_key',
    )).toEqual([
      { name: 'revenue', direction: 'desc' },
      { name: 'customer_name', direction: 'asc' },
    ]);
    expect(appendStableSemanticSecondaryOrder(
      [{ name: 'revenue', direction: 'desc' }, { name: 'customer_name', direction: 'desc' }],
      ['customer_name', 'region'],
      'stable_secondary_key',
    )).toEqual([
      { name: 'revenue', direction: 'desc' },
      { name: 'customer_name', direction: 'desc' },
      { name: 'region', direction: 'asc' },
    ]);
    expect(appendStableSemanticSecondaryOrder(
      [{ name: 'revenue', direction: 'desc' }],
      ['customer_name'],
      'include_ties',
    )).toEqual([{ name: 'revenue', direction: 'desc' }]);
  });
  it('binds exact qualified semantic IDs to a compiler selection without question rematching', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });
    const binding = adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: semanticNodes() }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });
    expect(binding).toMatchObject({
      status: 'ready',
      kind: 'semantic',
      selection: {
        metrics: ['rollover_balance'],
        dimensions: ['customer_name'],
        orderBy: [{ name: 'rollover_balance', direction: 'desc' }],
        limit: 10,
      },
    });
  });

  it('AGT-034 binds a cross-model dimension only through its frozen MetricFlow group-by reference', () => {
    const metricId = 'semantic:metric:order_item.revenue';
    const locationId = 'semantic:uncategorized:dimension:locations.location_name';
    const capability: MetricCapabilityContract = {
      metricId,
      semanticModelId: 'semantic:uncategorized:model:order_items',
      measureIds: ['semantic:measure:order_item.revenue'],
      primaryEntityId: 'semantic:uncategorized:entity:order_item.order_item',
      defaultResultGrainId: 'semantic:uncategorized:entity:order_item.order_item',
      resultGrainIds: [
        'semantic:uncategorized:entity:order_item.order_item',
        'semantic:uncategorized:entity:locations.location',
      ],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: locationId,
        entityId: 'semantic:uncategorized:entity:locations.location',
        label: 'Location name',
        aliases: ['region'],
        supportedRoles: ['group_by', 'display'],
        nativeGroupingReference: 'order_id__location__location_name',
        nativeGroupingPath: ['order_id', 'location'],
        relationshipPathIds: [
          'commerce::relationship::order_to_location',
          'dql:relationship:commerce::relationship::order_to_location',
          'order_to_location',
        ],
      }],
      timeDimensions: [],
      operations: ['group'],
      supportedOutputKinds: ['dimension', 'metric_value'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
      sourceFingerprint: 'sha256:jaffle-revenue-location-adapter',
    };
    const revenue: AgentEvidenceCandidate = {
      ...metric,
      id: metricId,
      qualifiedId: metricId,
      name: 'Revenue',
      aliases: ['revenue', 'sales'],
      analyticalCapability: capability,
    };
    const location: AgentEvidenceCandidate = {
      ...dimension,
      id: locationId,
      qualifiedId: locationId,
      name: 'Location Name',
      aliases: ['region'],
    };
    const makePlan = (candidate = revenue) => buildResolvedAnalyticalPlan({
      question: 'Show revenue by sales based on the region',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Show revenue by region.',
        questionType: 'aggregation',
        selectedConceptIds: [candidate.id, location.id],
        recommendedExecutionId: candidate.id,
        queryIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
        recommendedRoute: 'semantic',
      },
      evidence: { snapshotId: 'snapshot-jaffle-region', candidates: [candidate, location] },
      candidates: [candidate, location],
      mode: 'authoritative',
    });
    // This matches the packaged Jaffle runtime shape: the frozen candidate
    // carries relationship authority, while the compact KG metric projection
    // retains only the metric identity/native member capability.
    const compactRegistryCapability: MetricCapabilityContract = {
      ...capability,
      dimensions: capability.dimensions.map(({ relationshipPathIds: _relationshipPathIds, ...dimension }) => dimension),
    };
    const registry = buildPlanExecutionRegistry({
      nodes: [{
        nodeId: 'metric:order_items.revenue', kind: 'metric', name: 'revenue',
        payload: {
          qualifiedId: metricId,
          localId: 'revenue',
          analyticalCapability: compactRegistryCapability,
        },
      }, {
        nodeId: 'dimension:locations.location_name', kind: 'dimension', name: 'location_name',
        payload: { qualifiedId: locationId, localId: 'location_name' },
      }],
    });
    const layer = new SemanticLayer();
    const cube = (name: string, table: string, joins: Array<{
      name: string;
      left: string;
      right: string;
      type: 'left';
      sql: string;
      entity?: string;
    }> = []) => ({
      name, label: name, description: '', sql: `SELECT * FROM ${table}`, table,
      domain: 'commerce', measures: [], dimensions: [], timeDimensions: [], joins,
      segments: [], preAggregations: [],
    });
    // This is the same adapter-native entity graph the capability claims.
    // Merely adding a `location_name` leaf must not make the test pass.
    layer.addCube(cube('order_item', 'order_items', [{
      name: 'orders', left: 'order_item', right: 'orders', type: 'left',
      sql: '${left}.order_id = ${right}.order_id', entity: 'order_id',
    }]));
    layer.addCube(cube('orders', 'orders', [{
      name: 'locations', left: 'orders', right: 'locations', type: 'left',
      sql: '${left}.location_id = ${right}.location_id', entity: 'location',
    }]));
    layer.addCube(cube('locations', 'locations'));
    layer.addMetric({ name: 'revenue', label: 'Revenue', description: '', domain: 'commerce', sql: 'product_price', type: 'sum', table: 'order_items', cube: 'order_item' });
    layer.addDimension({
      name: 'location_name', label: 'Location name', description: '', domain: 'commerce',
      sql: 'location_name', type: 'string', table: 'locations', cube: 'locations',
      entityLink: 'location', qualifiedName: 'location__location_name',
    });

    const plan = makePlan();
    expect(plan.capability).toBe('semantic_execution');
    const nativeBinding = adaptResolvedAnalyticalPlan({
      plan,
      registry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-jaffle-region',
    });
    expect(nativeBinding).toMatchObject({
      status: 'ready',
      kind: 'semantic',
      selection: { metrics: ['revenue'], dimensions: ['order_id__location__location_name'] },
    });

    const graph = {
      version: 1 as const,
      graphId: 'graph:jaffle-region',
      fingerprint: 'fingerprint:jaffle-region',
      planId: plan.planId,
      planFingerprint: plan.fingerprint,
      snapshotId: plan.snapshotId,
      route: 'semantic' as const,
      adapterId: 'metricflow',
      metricId,
      capabilityFingerprint: capability.sourceFingerprint,
      relationshipProofFingerprints: plan.relationshipProofs?.map((proof) => proof.authorityFingerprint) ?? [],
      nodes: [{
        id: 'source:all_time',
        kind: 'source_invocation' as const,
        dependencies: [],
        strategy: 'period_aggregate' as const,
        route: 'semantic' as const,
        adapterId: 'metricflow',
        metricId,
        entityGrainIds: ['semantic:uncategorized:entity:locations.location'],
        groupByDimensionIds: [locationId],
        memberFilters: [],
        outputAliases: {
          dimensions: [{ dimensionId: locationId, outputId: 'location_name' }],
          metric: { metricId, outputId: 'revenue' },
        },
      }, {
        id: 'validate:result_contract',
        kind: 'project_validate' as const,
        dependencies: ['source:all_time'],
        outputIds: ['location_name', 'revenue'],
        entityGrainIds: ['semantic:uncategorized:entity:locations.location'],
        maxRows: 100,
      }],
      terminalNodeId: 'validate:result_contract',
    };
    const graphBinding = adaptAnalyticalSemanticGraph({
      graph,
      plan,
      registry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-jaffle-region',
    });
    expect(graphBinding).toMatchObject({
      status: 'ready',
      capability: {
        sourceFingerprint: capability.sourceFingerprint,
        dimensions: [expect.objectContaining({
          dimensionId: locationId,
          relationshipPathIds: capability.dimensions[0]!.relationshipPathIds,
        })],
      },
    });

    const mismatchedRegistry = buildPlanExecutionRegistry({
      nodes: [{
        nodeId: 'metric:order_items.revenue', kind: 'metric', name: 'revenue',
        payload: {
          qualifiedId: metricId,
          localId: 'revenue',
          analyticalCapability: { ...compactRegistryCapability, sourceFingerprint: 'sha256:wrong-registry-capability' },
        },
      }, {
        nodeId: 'dimension:locations.location_name', kind: 'dimension', name: 'location_name',
        payload: { qualifiedId: locationId, localId: 'location_name' },
      }],
    });
    expect(adaptAnalyticalSemanticGraph({
      graph,
      plan,
      registry: mismatchedRegistry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-jaffle-region',
    })).toMatchObject({ status: 'blocked', code: 'EXECUTION_GRAPH_MISMATCH' });

    // The generic leaf exists in the semantic layer but is not a valid
    // metric-relative traversal. It must be rejected before a semantic plan
    // can freeze, rather than reaching MetricFlow and failing after SQL route
    // selection.
    const flattenedRevenue: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...capability,
        dimensions: [{
          ...capability.dimensions[0]!,
          nativeGroupingReference: 'location_name',
          nativeGroupingPath: [],
        }],
      },
    };
    const flattenedPlan = makePlan(flattenedRevenue);
    expect(flattenedPlan.capability).toBe('blocked');
    expect(adaptResolvedAnalyticalPlan({
      plan: flattenedPlan,
      registry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-jaffle-region',
    })).toMatchObject({ status: 'blocked', code: 'PLAN_BLOCKED' });
  });

  it('fails closed on duplicate canonical registry IDs and never binds a retrieval alias', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });
    const duplicate = {
      ...semanticNodes()[1]!,
      nodeId: 'dimension:other.customer_name',
      name: 'other_customer_name',
      payload: {
        registryQualifiedId: 'semantic:consumption:dimension:customer_name',
        qualifiedId: 'semantic:other:dimension:customer_name',
        localId: 'other_customer_name',
      },
    };
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: [...semanticNodes(), duplicate] }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    })).toMatchObject({ status: 'blocked', code: 'SEMANTIC_MEMBER_AMBIGUOUS' });

    const forgedAliasNodes = semanticNodes().map((node) => node.kind === 'dimension'
      ? {
          ...node,
          payload: {
            ...node.payload,
            registryQualifiedId: 'semantic:other:dimension:customer_name',
            aliases: ['semantic:consumption:dimension:customer_name'],
          },
        }
      : node);
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: forgedAliasNodes }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    })).toMatchObject({ status: 'blocked', code: 'SEMANTIC_MEMBER_MISSING' });
  });

  it('AGT-017 binds every resolved metric instead of collapsing to the execution metric', () => {
    const basePlan = semanticPlan();
    const plan = {
      ...basePlan,
      query: {
        ...basePlan.query,
        measures: [
          ...basePlan.query.measures,
          {
            requested: 'refunds',
            qualifiedId: 'semantic:consumption:refunds',
            status: 'resolved' as const,
            candidateIds: ['semantic:consumption:refunds'],
          },
        ],
      },
    };
    const nodes = [
      ...semanticNodes(),
      {
        nodeId: 'metric:usage.refunds',
        kind: 'metric' as const,
        name: 'refunds',
        domain: 'consumption',
        payload: {
          qualifiedId: 'semantic:consumption:refunds',
          localId: 'refunds',
        },
      },
    ];
    const layer = new SemanticLayer({
      metrics: [
        { name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' },
        { name: 'refunds', label: 'Refunds', description: '', domain: 'consumption', sql: 'refunds', type: 'sum', table: 'usage' },
      ],
      dimensions: [{ name: 'customer_name', label: 'Customer', description: '', domain: 'consumption', sql: 'customer_name', type: 'string', table: 'usage' }],
    });

    const binding = adaptResolvedAnalyticalPlan({
      plan,
      registry: buildPlanExecutionRegistry({ nodes }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });

    expect(binding).toMatchObject({
      status: 'ready',
      kind: 'semantic',
      selection: {
        metrics: ['rollover_balance', 'refunds'],
        dimensions: ['customer_name'],
      },
    });
  });

  it('fails closed on a stale snapshot and an ambiguous canonical registry ID', () => {
    const registry = buildPlanExecutionRegistry({ nodes: semanticNodes() });
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry,
      expectedSnapshotId: 'snapshot-2',
    })).toMatchObject({ status: 'blocked', code: 'SNAPSHOT_MISMATCH' });

    const duplicate = { ...semanticNodes()[0]!, nodeId: 'metric:usage.rollover_balance_copy' };
    expect(adaptResolvedAnalyticalPlan({
      plan: semanticPlan(),
      registry: buildPlanExecutionRegistry({ nodes: [...semanticNodes(), duplicate] }),
      semanticLayer: new SemanticLayer({ metrics: [], dimensions: [] }),
    })).toMatchObject({ status: 'blocked', code: 'EXECUTION_ID_AMBIGUOUS' });
  });

  it('binds freshness to the same exact metric, time dimension, and snapshot without search', () => {
    const dateId = 'semantic:consumption:dimension:report_date';
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'What is rollover balance today?',
      questionType: 'scalar',
      metricConceptIds: [metric.qualifiedId!],
      entityGrainIds: ['account'],
      dimensions: [{ dimensionId: dateId, role: 'time_axis' }],
      memberBindings: [],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'UTC',
        grain: 'month',
        completenessPolicy: 'latest_complete',
        periods: [{ id: 'current', kind: 'current' }],
      },
      requestedOutputs: [{ id: 'rollover_balance', kind: 'metric_value', metricId: metric.qualifiedId!, periodId: 'current' }],
      ambiguity: [],
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: frame },
      evidence: { snapshotId: 'snapshot-1', candidates: [metric] },
      candidates: [metric],
      mode: 'authoritative',
    });
    const registry = buildPlanExecutionRegistry({
      nodes: [
        semanticNodes()[0]!,
        {
          nodeId: 'dimension:usage.report_date',
          kind: 'dimension',
          name: 'report_date',
          payload: { qualifiedId: dateId, localId: 'report_date' },
        },
      ],
    });
    const layer = new SemanticLayer({
      metrics: [{ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage' }],
      dimensions: [{
        name: 'report_date', label: 'Report date', description: '', domain: 'consumption', sql: 'report_date', type: 'date', table: 'usage',
        isTimeDimension: true, granularities: ['day', 'month'],
      }],
    });
    const request = {
      version: 1 as const,
      snapshotId: 'snapshot-1',
      metricId: metric.qualifiedId!,
      timeDimensionId: dateId,
    };
    expect(adaptAnalyticalFreshnessRequest({
      plan,
      request,
      registry,
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    })).toEqual({
      schemaVersion: 1,
      status: 'ready',
      kind: 'semantic_freshness',
      request: {
        route: 'semantic',
        metric: 'rollover_balance',
        timeDimension: 'report_date',
        granularity: 'day',
        outputField: 'report_date_day',
      },
    });
    expect(adaptAnalyticalFreshnessRequest({
      plan,
      request: { ...request, timeDimensionId: 'semantic:consumption:dimension:other_date' },
      registry,
      semanticLayer: layer,
    })).toMatchObject({ status: 'blocked', code: 'TIME_DIMENSION_REQUIRED' });
  });

  it('binds a certified block only when its snapshot status is certified', () => {
    const blockCandidate: AgentEvidenceCandidate = {
      id: 'dql:block:consumption:rollover_leaders',
      qualifiedId: 'consumption::block::rollover_leaders',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'Rollover Leaders',
      relevanceScore: 1,
      matchReasons: ['explicit block'],
      compatibility: 'compatible',
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Run the certified rollover leaders block.',
      resolution: {
        interpretedQuestion: 'Run Rollover Leaders.',
        questionType: 'value',
        selectedConceptIds: [blockCandidate.id],
        recommendedExecutionId: blockCandidate.id,
        queryIntent: { measures: [], dimensions: [], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
      },
      evidence: { snapshotId: 'snapshot-1', candidates: [blockCandidate] },
      candidates: [blockCandidate],
      mode: 'authoritative',
    });
    const node: KGNode = { nodeId: 'block:Rollover Leaders', kind: 'block', name: 'Rollover Leaders', status: 'certified' };
    const registry = buildPlanExecutionRegistry({
      nodes: [node],
      objects: [{
        objectKey: blockCandidate.id,
        objectType: 'dql_block',
        name: node.name,
        fullName: blockCandidate.qualifiedId,
      }],
    });
    expect(adaptResolvedAnalyticalPlan({ plan, registry })).toMatchObject({
      status: 'ready',
      kind: 'certified',
      node: { nodeId: 'block:Rollover Leaders' },
    });
    expect(adaptResolvedAnalyticalPlan({
      plan,
      registry: buildPlanExecutionRegistry({ nodes: [{ ...node, status: 'draft' }], objects: [{
        objectKey: blockCandidate.id,
        objectType: 'dql_block',
        name: node.name,
        fullName: blockCandidate.qualifiedId,
      }] }),
    })).toMatchObject({ status: 'blocked', code: 'CERTIFICATION_REQUIRED' });
  });

  it('adapts each bounded graph period to exact semantic members without rematching the question', () => {
    const customerId = 'semantic:consumption:dimension:customer_name';
    const dateId = 'semantic:consumption:dimension:report_date';
    const metricId = metric.qualifiedId!;
    const frame: AnalyticalQuestionFrameV2 = {
      version: 2,
      interpretedQuestion: 'Current and prior rollover balance for top customers.',
      questionType: 'ranking',
      metricConceptIds: [metricId],
      entityGrainIds: ['customer'],
      dimensions: [
        { dimensionId: customerId, role: 'group_by' },
        { dimensionId: customerId, role: 'rank_entity' },
        { dimensionId: dateId, role: 'time_axis' },
      ],
      memberBindings: [{
        dimensionId: customerId,
        canonicalValues: ['Zoom'],
        source: 'question',
        confidence: 'exact',
      }],
      timeContext: {
        timeDimensionId: dateId,
        timeRole: 'report_as_of',
        calendarId: 'calendar:gregorian',
        timezone: 'UTC',
        grain: 'day',
        completenessPolicy: 'closed_period',
        periods: [
          { id: 'current', kind: 'absolute', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
          { id: 'previous_year', kind: 'previous_year', start: '2025-07-01T00:00:00.000Z', end: '2025-08-01T00:00:00.000Z', alignToPeriodId: 'current' },
        ],
      },
      comparison: {
        basePeriodId: 'current',
        comparisonPeriodIds: ['previous_year'],
        alignment: 'calendar_period',
        outputs: ['value', 'absolute_delta', 'percent_delta'],
        zeroDenominatorPolicy: 'null',
      },
      ranking: {
        entityDimensionId: customerId,
        byMetricId: metricId,
        byPeriodId: 'current',
        direction: 'desc',
        limit: 5,
        tiePolicy: 'stable_secondary_key',
      },
      requestedOutputs: [
        { id: 'customer', kind: 'dimension' },
        { id: 'current_balance', kind: 'metric_value', metricId, periodId: 'current' },
        { id: 'prior_balance', kind: 'metric_value', metricId, periodId: 'previous_year' },
        { id: 'balance_delta', kind: 'delta', metricId },
        { id: 'balance_percent_delta', kind: 'percent_delta', metricId },
      ],
      ambiguity: [],
    };
    const analyticalCapability: MetricCapabilityContract = {
      metricId,
      semanticModelId: 'semantic:consumption:model:usage',
      measureIds: ['semantic:consumption:measure:rollover_balance'],
      primaryEntityId: 'account',
      defaultResultGrainId: 'scalar',
      resultGrainIds: ['scalar', 'customer'],
      aggregation: 'sum',
      additivity: { entities: 'additive', time: 'additive' },
      dimensions: [{
        dimensionId: customerId,
        entityId: 'customer',
        supportedRoles: ['group_by', 'filter', 'rank_entity'],
        nativeGroupingReference: 'customer__customer_name',
        nativeGroupingPath: ['customer'],
      }],
      timeDimensions: [{
        dimensionId: dateId,
        role: 'report_as_of',
        supportedGrains: ['day', 'month', 'year'],
      }],
      operations: ['filter', 'group', 'compare', 'rank'],
      supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta'],
      executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
      sourceFingerprint: 'semantic-capability-v1',
    };
    const graphMetric: AgentEvidenceCandidate = {
      ...metric,
      analyticalCapability,
    };
    const plan = buildResolvedAnalyticalPlan({
      question: frame.interpretedQuestion,
      resolution: { ...resolution, analyticalFrame: frame, selectedConceptIds: [graphMetric.id], recommendedExecutionId: graphMetric.id },
      evidence: { ...evidence, candidates: [graphMetric, dimension] },
      candidates: [graphMetric, dimension],
      mode: 'authoritative',
    });
    const built = buildAnalyticalExecutionGraph({
      plan,
      capability: analyticalCapability,
      route: 'semantic',
      adapterId: 'metricflow-cli',
    });
    if (built.status !== 'ready') throw new Error(built.reason);
    const nodes = [
      ...semanticNodes(),
      {
        nodeId: 'dimension:usage.report_date',
        kind: 'dimension' as const,
        name: 'report_date',
        domain: 'consumption',
        payload: { qualifiedId: dateId, localId: 'report_date' },
      },
    ];
    const layer = new SemanticLayer();
    const cube = (name: string, table: string, joins: Array<{
      name: string;
      left: string;
      right: string;
      type: 'left';
      sql: string;
      entity?: string;
    }> = []) => ({
      name, label: name, description: '', sql: `SELECT * FROM ${table}`, table,
      domain: 'consumption', measures: [], dimensions: [], timeDimensions: [], joins,
      segments: [], preAggregations: [],
    });
    layer.addCube(cube('usage', 'usage', [{
      name: 'customers', left: 'usage', right: 'customers', type: 'left',
      sql: '${left}.customer_id = ${right}.customer_id', entity: 'customer',
    }]));
    layer.addCube(cube('customers', 'customers'));
    layer.addMetric({ name: 'rollover_balance', label: 'Rollover', description: '', domain: 'consumption', sql: 'balance', type: 'sum', table: 'usage', cube: 'usage' });
    layer.addDimension({
      name: 'customer_name', label: 'Customer', description: '', domain: 'consumption',
      sql: 'customer_name', type: 'string', table: 'customers', cube: 'customers',
      entityLink: 'customer', qualifiedName: 'customer__customer_name',
    });
    layer.addDimension({ name: 'report_date', label: 'Report date', description: '', domain: 'consumption', sql: 'report_date', type: 'date', table: 'usage', cube: 'usage', isTimeDimension: true, granularities: ['day', 'month', 'year'] });
    const binding = adaptAnalyticalSemanticGraph({
      graph: built.graph,
      plan,
      registry: buildPlanExecutionRegistry({ nodes }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });
    expect(binding).toMatchObject({
      status: 'ready',
      kind: 'semantic_graph',
      invocations: [
        {
          nodeId: 'source:current',
          adapterId: 'metricflow-cli',
          selection: {
            metrics: ['rollover_balance'],
            dimensions: ['customer__customer_name'],
            filters: [
              { dimension: 'customer__customer_name', operator: 'equals', values: ['Zoom'] },
              { dimension: 'report_date', operator: 'gte', values: ['2026-07-01T00:00:00.000Z'] },
              { dimension: 'report_date', operator: 'lt', values: ['2026-08-01T00:00:00.000Z'] },
            ],
          },
          outputAliases: { metric: { outputId: 'current_balance' } },
        },
        {
          nodeId: 'source:previous_year',
          selection: {
            metrics: ['rollover_balance'],
            dimensions: ['customer__customer_name'],
            filters: [
              { dimension: 'customer__customer_name', operator: 'equals', values: ['Zoom'] },
              { dimension: 'report_date', operator: 'gte', values: ['2025-07-01T00:00:00.000Z'] },
              { dimension: 'report_date', operator: 'lt', values: ['2025-08-01T00:00:00.000Z'] },
            ],
          },
          outputAliases: { metric: { outputId: 'prior_balance' } },
        },
      ],
    });

    const { analyticalFrame: _frame, ...planWithoutFrame } = plan;
    const noFrameBinding = adaptAnalyticalSemanticGraph({
      graph: built.graph,
      plan: planWithoutFrame,
      registry: buildPlanExecutionRegistry({ nodes }),
      semanticLayer: layer,
      expectedSnapshotId: 'snapshot-1',
    });
    expect(noFrameBinding).toMatchObject({ status: 'ready', kind: 'semantic_graph' });
    if (noFrameBinding.status === 'ready') {
      expect(noFrameBinding.invocations.every((invocation) => invocation.selection.orderBy === undefined)).toBe(true);
    }
  });
});
