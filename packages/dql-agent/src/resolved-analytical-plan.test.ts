import { describe, expect, it } from 'vitest';
import { buildResolvedAnalyticalPlan, deriveResolvedAnalyticalPlan, resolvePlanTimeRange } from './resolved-analytical-plan.js';
import type { AgentEvidenceCandidate, AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import { buildAnalyticalRequirementSeedV1 } from './analytical-orchestration.js';

const metric: AgentEvidenceCandidate = {
  id: 'semantic:metric:consumption_model.rollover_balance_amount',
  qualifiedId: 'semantic:consumption:rollover_balance_amount',
  kind: 'semantic_metric',
  trustTier: 'semantic',
  name: 'Rollover Balance Amount',
  aliases: ['rollover balance'],
  definition: 'Remaining eligible balance carried into the next billing month.',
  domain: 'consumption',
  primaryEntity: 'account',
  dimensions: ['semantic:consumption:dimension:customer', 'semantic:consumption:dimension:month'],
  timeGrains: ['month'],
  relationshipEvidence: ['consumption::relationship::balance_to_customer'],
  relevanceScore: 0.98,
  matchReasons: ['meaning match'],
  compatibility: 'compatible',
  compatibilityFacts: ['dimension: customer', 'time grain: month'],
  // The common fixture is a single semantic model: `customer_name` is a
  // declared group-by on the metric model, not a cross-model relationship.
  // Keep the fixture capability complete so these plan tests exercise the
  // authoritative semantic contract rather than the legacy descriptive path.
  analyticalCapability: {
    metricId: 'semantic:consumption:rollover_balance_amount',
    semanticModelId: 'semantic:consumption:model:usage',
    measureIds: ['semantic:consumption:rollover_balance_amount'],
    primaryEntityId: 'account',
    defaultResultGrainId: 'account',
    resultGrainIds: ['account'],
    aggregation: 'sum',
    additivity: { entities: 'additive', time: 'additive' },
    dimensions: [{
      dimensionId: 'semantic:consumption:dimension:customer',
      entityId: 'account',
      label: 'Customer',
      aliases: ['customer'],
      supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
      nativeGroupingReference: 'customer_name',
      nativeGroupingPath: [],
    }],
    timeDimensions: [{
      dimensionId: 'semantic:consumption:dimension:month',
      role: 'report_date',
      supportedGrains: ['day', 'month', 'year'],
    }],
    operations: ['filter', 'group', 'rank'],
    supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
    executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
    sourceFingerprint: 'sha256:consumption-rollover-fixture',
  },
};

const evidence: AgentRetrievalEvidence = {
  snapshotId: 'snapshot-1',
  sourceFingerprint: 'source-1',
  knowledgeLens: {
    mode: 'pinned',
    activeDomainId: 'consumption',
    skillRefs: ['consumption::skill::rollover-analysis'],
    snapshotId: 'snapshot-1',
    skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
  },
  candidates: [metric],
};

const resolution: MeaningResolution = {
  interpretedQuestion: 'Top customers by monthly rollover balance amount.',
  questionType: 'ranking',
  selectedConceptIds: [metric.id],
  recommendedExecutionId: metric.id,
  queryIntent: {
    measures: ['rollover balance'],
    dimensions: ['customer'],
    filters: [],
    timeGrain: 'month',
    order: 'desc',
    limit: 10,
  },
  rejectedCandidates: [],
  confidence: 'high',
  missingInformation: [],
  recommendedRoute: 'semantic',
};

describe('ResolvedAnalyticalPlan (AGT-013 / API-006)', () => {
  it('resolves relative time once against the plan clock', () => {
    expect(resolvePlanTimeRange('last month', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last month',
      startInclusive: '2026-06-01T00:00:00.000Z',
      endExclusive: '2026-07-01T00:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(resolvePlanTimeRange('last 7 days', new Date('2026-07-22T15:00:00Z'))).toEqual({
      expression: 'last 7 days',
      startInclusive: '2026-07-15T00:00:00.000Z',
      endExclusive: '2026-07-22T00:00:00.000Z',
      timeZone: 'UTC',
    });
  });

  it('binds canonical IDs, snapshot/Skill hashes, compatibility, and output shape deterministically', () => {
    const first = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });
    const second = buildResolvedAnalyticalPlan({
      question: 'Who are the top 10 customers by monthly rollover balance?',
      resolution,
      evidence,
      candidates: [metric],
    });

    expect(first).toMatchObject({
      mode: 'authoritative',
      snapshotId: 'snapshot-1',
      selectedConceptIds: ['semantic:consumption:rollover_balance_amount'],
      executionId: 'semantic:consumption:rollover_balance_amount',
      capability: 'semantic_execution',
      entityGrain: 'account',
      query: {
        measures: [expect.objectContaining({ status: 'resolved' })],
        dimensions: [expect.objectContaining({
          requested: 'customer',
          qualifiedId: 'semantic:consumption:dimension:customer',
          status: 'resolved',
        })],
        timeGrain: 'month',
        order: 'desc',
        limit: 10,
      },
      knowledgeLens: {
        skillFingerprints: { 'consumption::skill::rollover-analysis': 'skill-hash-1' },
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.planId).toBe(second.planId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.query.dimensions)).toBe(true);
  });

  it('keeps a seeded ranking display key authoritative when legacy intent retains a broad entity noun', () => {
    const decoyMetric = structuredClone(metric);
    decoyMetric.analyticalCapability = {
      ...decoyMetric.analyticalCapability!,
      dimensions: [{
        dimensionId: 'semantic:consumption:dimension:customers.customer_name',
        entityId: 'account',
        label: 'Customer Name',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'customer_name',
        nativeGroupingPath: [],
      }, {
        dimensionId: 'semantic:consumption:dimension:customers.customer_type',
        entityId: 'account',
        label: 'Customer Type',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'customer_type',
        nativeGroupingPath: [],
      }, {
        dimensionId: 'semantic:consumption:dimension:orders.customer_order_number',
        entityId: 'order',
        label: 'Customer Order Number',
        aliases: ['customer'],
        supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
        nativeGroupingReference: 'order_id__customer_order_number',
        nativeGroupingPath: ['order_id'],
      }],
    };
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'who are the top customers by rollover balance?',
      parsedIntent: { measures: ['rollover balance'], dimensions: ['customer'] },
    });
    const plan = buildResolvedAnalyticalPlan({
      question: seed.sourceQuestion,
      resolution: {
        ...resolution,
        // Simulate a legacy downstream carrier that has not yet been
        // normalized. The seeded host frame, not this broad noun, owns the
        // frozen display/rank requirement.
        queryIntent: { ...resolution.queryIntent, dimensions: ['customer'] },
        hostRequirementSeed: seed,
        analyticalFrame: {
          version: 2,
          interpretedQuestion: seed.sourceQuestion,
          questionType: 'ranking',
          metricConceptIds: [decoyMetric.analyticalCapability!.metricId],
          entityGrainIds: ['account'],
          dimensions: [
            {
              dimensionId: 'semantic:consumption:dimension:customers.customer_name',
              role: 'group_by',
            },
            {
              dimensionId: 'semantic:consumption:dimension:customers.customer_name',
              role: 'rank_entity',
            },
          ],
          memberBindings: [],
          ranking: {
            entityDimensionId: 'semantic:consumption:dimension:customers.customer_name',
            byMetricId: decoyMetric.analyticalCapability!.metricId,
            direction: 'desc',
            limit: 10,
            tiePolicy: 'stable_secondary_key',
          },
          requestedOutputs: [
            {
              id: 'customer_name',
              kind: 'dimension',
            },
            {
              id: 'rollover_balance_amount',
              kind: 'metric_value',
              metricId: decoyMetric.analyticalCapability!.metricId,
            },
          ],
          ambiguity: [],
        },
      },
      evidence: { ...evidence, candidates: [decoyMetric] },
      candidates: [decoyMetric],
    });

    expect(seed.queryIntent.dimensions).toEqual(['customer name']);
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({
        requested: 'customer name',
        qualifiedId: 'semantic:consumption:dimension:customers.customer_name',
        status: 'resolved',
      }),
    ]);
    expect(plan.query.dimensions.some((binding) => /customer_(?:type|order_number)$/.test(binding.qualifiedId ?? ''))).toBe(false);
  });

  it('AGT-031 binds the grounded member when the provider returns no filter', () => {
    // The provider named the grouping field and forgot the member, so the run
    // returned every customer. ZLens had already grounded "Wesley Jenkins" in
    // `parsedIntent.filters`; that binding is evidence-backed, not a guess.
    const attribute = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'customer_type', aliases: ['customer type'],
      primaryEntity: 'customer', dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1, matchReasons: [], compatibility: 'compatible', eligible: true,
    } as unknown as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'Look up customer_type.',
        questionType: 'value',
        selectedConceptIds: [attribute.id],
        recommendedExecutionId: attribute.id,
        queryIntent: { measures: [], dimensions: ['customer_type'], filters: [] },
        rejectedCandidates: [], confidence: 'high', missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: {
        ...evidence,
        candidates: [attribute],
        parsedIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
      } as never,
      candidates: [attribute],
    });

    expect(plan.query.filters).toHaveLength(1);
    expect(plan.query.filters[0]).toMatchObject({ field: 'customer_name', value: 'Wesley Jenkins' });
    expect(plan.query.filters[0]?.binding.status).toBe('resolved');
  });

  it('AGT-031 lets the provider\'s own filters win over the grounded fallback', () => {
    const attribute = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member', semanticObjectType: 'dimension', trustTier: 'semantic',
      name: 'customer_type', aliases: [], primaryEntity: 'customer',
      dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1, matchReasons: [], compatibility: 'compatible', eligible: true,
    } as unknown as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'x', questionType: 'value',
        selectedConceptIds: [attribute.id], recommendedExecutionId: attribute.id,
        queryIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Benjamin Bell' }],
        },
        rejectedCandidates: [], confidence: 'high', missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: {
        ...evidence, candidates: [attribute],
        parsedIntent: {
          measures: [], dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
      } as never,
      candidates: [attribute],
    });

    expect(plan.query.filters[0]).toMatchObject({ value: 'Benjamin Bell' });
  });

  it('AGT-031 freezes a metric-free attribute lookup as semantic execution', () => {
    // "What customer type is <member>?" names a FIELD and a MEMBER and no
    // measure at all. The claim under test is whether the plan builder can
    // freeze such a plan, or whether it is structurally metric-only.
    const attribute: AgentEvidenceCandidate = {
      id: 'semantic:dimension:customers.customer_type',
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      trustTier: 'semantic',
      name: 'customer_type',
      aliases: ['customer type'],
      definition: 'Whether the customer is new or returning.',
      primaryEntity: 'customer',
      dimensions: ['customer_type', 'customer_name'],
      relevanceScore: 1,
      matchReasons: ['exact name or alias'],
      compatibility: 'compatible',
      eligible: true,
      exactMatch: true,
    } as AgentEvidenceCandidate;

    const plan = buildResolvedAnalyticalPlan({
      question: 'What customer type is Wesley Jenkins?',
      resolution: {
        interpretedQuestion: 'Look up the customer_type attribute for one customer.',
        questionType: 'value',
        selectedConceptIds: [attribute.id],
        recommendedExecutionId: attribute.id,
        queryIntent: {
          measures: [],
          dimensions: ['customer_type'],
          filters: [{ field: 'customer_name', value: 'Wesley Jenkins' }],
        },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'semantic',
      } as unknown as MeaningResolution,
      evidence: { ...evidence, candidates: [attribute] },
      candidates: [attribute],
    });

    expect(plan.capability).toBe('semantic_execution');
    expect(plan.query.measures).toEqual([]);
    // The dimension arrived twice — once as the candidate's qualified identity
    // and once as its own declared dimension name — and two ids read as
    // ambiguous, which blocked every metric-free lookup.
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({
        requested: 'customer_type',
        qualifiedId: 'semantic:dimension:customers.customer_type',
        status: 'resolved',
        candidateIds: ['semantic:dimension:customers.customer_type'],
      }),
    ]);
    expect(plan.query.filters[0]?.binding.status).toBe('resolved');
  });

  it('fails capability closed when a requested semantic dimension is unresolved', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by campaign channel.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, dimensions: ['campaign channel'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.dimensions).toEqual([
      expect.objectContaining({ requested: 'campaign channel', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('AGT-034 freezes a partial semantic metric only after a selected same-snapshot geography extension proves the complete tuple', () => {
    // Match the live shape: `location_name` belongs to a distinct semantic
    // model and can only be selected through the metric-relative MetricFlow
    // reference, not a flattened `order_items.location_name` leaf.
    const locationNameId = 'semantic:uncategorized:dimension:locations.location_name';
    const revenue: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:order_items.revenue',
      qualifiedId: 'semantic:metric:order_item.revenue',
      name: 'Revenue',
      aliases: ['sales'],
      compatibility: 'partial',
      analyticalCapability: {
        metricId: 'semantic:metric:order_item.revenue',
        semanticModelId: 'semantic:uncategorized:model:order_items',
        measureIds: ['semantic:measure:order_item.revenue'],
        primaryEntityId: 'semantic:uncategorized:entity:order_item.order_item',
        defaultResultGrainId: 'semantic:uncategorized:entity:order_item.order_item',
        resultGrainIds: ['semantic:uncategorized:entity:order_item.order_item', 'semantic:uncategorized:entity:locations.location'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: locationNameId,
          entityId: 'semantic:uncategorized:entity:locations.location',
          label: 'Location name',
          aliases: ['region'],
          supportedRoles: ['group_by', 'display'],
          nativeGroupingReference: 'order_id__location__location_name',
          nativeGroupingPath: ['order_id', 'location'],
        }],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow' }],
        sourceFingerprint: 'sha256:jaffle-revenue-location',
      },
    };
    const regionExtension: AgentEvidenceCandidate = {
      ...revenue,
      id: locationNameId,
      qualifiedId: locationNameId,
      kind: 'semantic_member',
      semanticObjectType: 'dimension',
      name: 'Location name',
      aliases: ['region'],
      compatibility: 'compatible',
      analyticalCapability: undefined,
      sameSnapshotRoleExtension: {
        version: 1,
        role: 'categorical_dimension',
        requestedTerm: 'region',
        metricId: revenue.qualifiedId!,
        dimensionId: locationNameId,
        basis: 'sole_metricflow_grouping_dimension',
      },
    };
    const build = ({
      metricCandidate = revenue,
      extension = regionExtension,
    }: {
      metricCandidate?: AgentEvidenceCandidate;
      extension?: AgentEvidenceCandidate;
    } = {}) => buildResolvedAnalyticalPlan({
      question: 'Show revenue by sales based on the region',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Show revenue by region.',
        questionType: 'aggregation',
        selectedConceptIds: [metricCandidate.id, extension.id],
        recommendedExecutionId: metricCandidate.id,
        queryIntent: { measures: ['revenue'], dimensions: ['region'], filters: [] },
        recommendedRoute: 'semantic',
      },
      evidence: { ...evidence, candidates: [metricCandidate, extension] },
      candidates: [metricCandidate, extension],
    });

    const plan = build();
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.query.measures).toEqual([expect.objectContaining({
      requested: 'revenue', qualifiedId: revenue.qualifiedId, status: 'resolved',
    })]);
    expect(plan.query.dimensions).toEqual([expect.objectContaining({
      requested: 'region', qualifiedId: locationNameId, status: 'resolved',
    })]);

    const mismatchedExtension = {
      ...regionExtension,
      sameSnapshotRoleExtension: {
        ...regionExtension.sameSnapshotRoleExtension!,
        metricId: 'semantic:metric:other.revenue',
      },
    };
    expect(build({ extension: mismatchedExtension }).capability).toBe('blocked');

    // The local registry can retain its own card ID while preserving the
    // MetricFlow field as the card's qualified identity.  That is sufficient
    // for a selected partial metric to prove the declared native grouping;
    // it must not require the historical wrapper record to be present.
    const registryIdentityExtension: AgentEvidenceCandidate = {
      ...regionExtension,
      id: 'semantic:registry:dimension:locations.location_name',
      qualifiedId: locationNameId,
      aliases: ['locations.location_name', locationNameId],
      sameSnapshotRoleExtension: undefined,
    };
    expect(build({ extension: registryIdentityExtension }).capability).toBe('semantic_execution');

    // A leaf spelling alone is not a MetricFlow execution graph. This is the
    // exact failure shape from the live trace: a cross-model `locations`
    // member looked superficially compatible with `order_item.revenue`, but
    // no metric-relative group-by path was supplied to the adapter. The
    // semantic tier must stay pre-freeze-ineligible rather than fail later in
    // compilation (or flatten the field onto `order_items`).
    const flattenedRevenue: AgentEvidenceCandidate = {
      ...revenue,
      analyticalCapability: {
        ...revenue.analyticalCapability!,
        dimensions: [{
          ...revenue.analyticalCapability!.dimensions[0]!,
          nativeGroupingReference: 'location_name',
          nativeGroupingPath: [],
        }],
      },
    };
    const flattenedPlan = build({ metricCandidate: flattenedRevenue });
    expect(flattenedPlan.capability).toBe('blocked');
    expect(flattenedPlan.relationshipProofs ?? []).toEqual([]);
  });

  it('does not let a v2 frame dimension outrank selected-capability authority', () => {
    const exactDimensionId = 'semantic:consumption:dimension:customer.customer_name';
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by customer name.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, dimensions: ['customer name'] },
        selectedConceptIds: [metric.id, 'semantic:member:customer_name'],
        analyticalFrame: {
          version: 2,
          interpretedQuestion: 'Show rollover balance by customer name.',
          questionType: 'ranking',
          metricConceptIds: [metric.qualifiedId!],
          entityGrainIds: ['semantic:consumption:entity:customer'],
          dimensions: [{ dimensionId: exactDimensionId, role: 'group_by', requestedLabel: 'customer name' }],
          memberBindings: [],
          requestedOutputs: [
            { id: 'customer_name', kind: 'dimension' },
            { id: 'rollover_balance', kind: 'metric_value', metricId: metric.qualifiedId },
          ],
          ambiguity: [],
        },
      },
      evidence,
      candidates: [
        metric,
        {
          ...metric,
          id: 'semantic:member:customer_name',
          qualifiedId: 'semantic:consumption:member:customer_name',
          kind: 'semantic_member',
          name: 'Customer Name',
        },
        {
          ...metric,
          id: 'semantic:member:other_customer_name',
          qualifiedId: 'semantic:sales:member:customer_name',
          kind: 'semantic_member',
          name: 'Customer Name',
        },
      ],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'customer name',
      status: 'unresolved',
      candidateIds: [],
    }]);
    expect(plan.query.dimensions[0]?.qualifiedId).not.toBe(exactDimensionId);
  });

  it('AGT-012 binds an arbitrary requested entity only from the selected metric capability', () => {
    const workspaceNameId = 'semantic:workforce:dimension:workspace_name';
    const capabilityMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:workforce.active_seats',
      qualifiedId: 'semantic:workforce:metric:active_seats',
      name: 'Active seats',
      aliases: ['seat count'],
      dimensions: [workspaceNameId],
      analyticalCapability: {
        metricId: 'semantic:workforce:metric:active_seats',
        measureIds: ['semantic:workforce:measure:active_seats'],
        primaryEntityId: 'semantic:workforce:entity:subscription',
        defaultResultGrainId: 'semantic:workforce:grain:scalar',
        resultGrainIds: ['semantic:workforce:grain:scalar', 'semantic:workforce:entity:workspace'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          {
            dimensionId: workspaceNameId,
            entityId: 'semantic:workforce:entity:workspace',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
            nativeGroupingReference: 'subscription__workspace__workspace_name',
            nativeGroupingPath: ['subscription', 'workspace'],
          },
          {
            dimensionId: 'semantic:workforce:dimension:is_archived',
            entityId: 'semantic:workforce:entity:workspace',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_workspace'],
          },
          {
            dimensionId: 'semantic:inventory:dimension:is_trial_item',
            entityId: 'semantic:inventory:entity:item',
            supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
            relationshipPathIds: ['semantic:workforce:relationship:subscription_to_item'],
          },
        ],
        timeDimensions: [],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:workforce-active-seats',
      },
    };
    const genericMember: AgentEvidenceCandidate = {
      ...capabilityMetric,
      id: 'semantic:member:workspace_name',
      qualifiedId: workspaceNameId,
      kind: 'semantic_member',
      name: 'Workspace',
      aliases: ['workspace identity'],
      analyticalCapability: undefined,
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which workspaces have the most active seats?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank workspaces by active seats.',
        selectedConceptIds: [capabilityMetric.id, genericMember.id],
        recommendedExecutionId: capabilityMetric.id,
        queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        analyticalFrame: {
          version: 2,
          interpretedQuestion: 'Rank workspaces by active seats.',
          questionType: 'ranking',
          metricConceptIds: ['semantic:workforce:metric:active_seats'],
          entityGrainIds: ['semantic:finance:entity:cost_center'],
          dimensions: [{
            dimensionId: 'semantic:finance:dimension:cost_center',
            role: 'group_by',
          }],
          memberBindings: [],
          ranking: {
            entityDimensionId: 'semantic:finance:dimension:cost_center',
            byMetricId: 'semantic:workforce:metric:active_seats',
            direction: 'desc',
            limit: 10,
            tiePolicy: 'stable_secondary_key',
          },
          requestedOutputs: [{
            id: 'active_seats',
            kind: 'metric_value',
            metricId: 'semantic:workforce:metric:active_seats',
          }],
          ambiguity: [],
        },
      },
      evidence: { ...evidence, candidates: [capabilityMetric, genericMember] },
      candidates: [capabilityMetric, genericMember],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'workspace',
      qualifiedId: workspaceNameId,
      status: 'resolved',
      candidateIds: [workspaceNameId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.entityGrain).toBe('semantic:workforce:entity:workspace');
    expect(plan.relationshipPathIds).toEqual([]);
    expect(plan.relationshipProofs).toEqual([expect.objectContaining({
      kind: 'semantic_native_grouping',
      dimensionId: workspaceNameId,
      nativeGroupingReference: 'subscription__workspace__workspace_name',
      nativeGroupingPath: ['subscription', 'workspace'],
    })]);
    expect(plan.compatibilityProof).toContainEqual(expect.objectContaining({
      candidateId: 'semantic:workforce:metric:active_seats',
      facts: expect.arrayContaining([
        'capability:metric:semantic:workforce:metric:active_seats',
        'capability:primary_entity:semantic:workforce:entity:subscription',
        'capability:result_grain:semantic:workforce:entity:workspace',
        'capability:relationship:semantic:workforce:relationship:subscription_to_workspace',
      ]),
    }));
    expect(plan.entityGrain).not.toBe('semantic:finance:entity:cost_center');
    expect(plan.query.dimensions[0]?.qualifiedId).not.toBe('semantic:finance:dimension:cost_center');
    const repeated = buildResolvedAnalyticalPlan({
      question: 'Which workspaces have the most active seats?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank workspaces by active seats.',
        selectedConceptIds: [capabilityMetric.id, genericMember.id],
        recommendedExecutionId: capabilityMetric.id,
        queryIntent: { measures: ['active seats'], dimensions: ['workspace'], filters: [], order: 'desc', limit: 10 },
        analyticalFrame: plan.analyticalFrame,
      },
      evidence: { ...evidence, candidates: [capabilityMetric, genericMember] },
      candidates: [capabilityMetric, genericMember],
    });
    expect(repeated.fingerprint).toBe(plan.fingerprint);
  });

  it('AGT-012 binds the requested entity display dimension and excludes unrelated capability booleans', () => {
    const customerNameId = 'semantic:order_item:dimension:customers.customer_name';
    const revenueMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:order_item.revenue',
      qualifiedId: 'semantic:order_item:revenue',
      name: 'Revenue',
      aliases: ['total revenue'],
      primaryEntity: 'order_item',
      dimensions: [
        customerNameId,
        'semantic:order_item:dimension:customers.customer_type',
        'semantic:order_item:dimension:customers.first_ordered_at',
        'semantic:order_item:dimension:orders.customer_order_number',
        'semantic:order_item:dimension:orders.ordered_at',
        'semantic:order_item:dimension:products.is_drink_item',
        'semantic:order_item:dimension:products.is_food_item',
      ],
      analyticalCapability: {
        metricId: 'semantic:order_item:revenue',
        measureIds: ['semantic:order_item:measure:revenue'],
        primaryEntityId: 'semantic:order_item:entity:order_item',
        defaultResultGrainId: 'semantic:order_item:entity:order_item',
        resultGrainIds: ['semantic:order_item:entity:order_item'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          ['customers.customer_name', 'customer_name', 'semantic:order_item:entity:customer'],
          ['customers.customer_type', 'customer_type', 'semantic:order_item:entity:customer'],
          ['customers.first_ordered_at', 'first_ordered_at', 'semantic:order_item:entity:customer'],
          ['orders.customer_order_number', 'customer_order_number', 'semantic:order_item:entity:order'],
          ['orders.ordered_at', 'ordered_at', 'semantic:order_item:entity:order'],
          ['products.is_drink_item', 'is_drink_item', 'semantic:order_item:entity:product'],
          ['products.is_food_item', 'is_food_item', 'semantic:order_item:entity:product'],
        ].map(([localId, label, entityId]) => ({
          dimensionId: `semantic:order_item:dimension:${localId}`,
          entityId,
          supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'] as const,
          label,
          nativeGroupingReference: localId.replace('.', '__'),
          nativeGroupingPath: [localId.split('.')[0]!],
        })),
        timeDimensions: [],
        operations: ['filter', 'group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:order-item-revenue',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'who are the top customers have a highest revenue',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank customers by revenue.',
        selectedConceptIds: [revenueMetric.id],
        recommendedExecutionId: revenueMetric.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [revenueMetric] },
      candidates: [revenueMetric],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'customer',
      qualifiedId: customerNameId,
      status: 'resolved',
      candidateIds: [customerNameId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
    expect(plan.resolutionFailure).toBeUndefined();
    expect(plan.relationshipPathIds).toEqual([]);
    expect(plan.relationshipProofs).toEqual([expect.objectContaining({
      version: 1,
      kind: 'semantic_native_grouping',
      metricId: 'semantic:order_item:revenue',
      dimensionId: customerNameId,
      nativeGroupingReference: 'customers__customer_name',
      nativeGroupingPath: ['customers'],
      route: 'semantic',
      adapterId: 'native',
      snapshotId: 'snapshot-1',
      capabilityFingerprint: 'sha256:order-item-revenue',
      authorityFingerprint: expect.any(String),
    })]);
    expect(plan.compatibilityProof).toContainEqual(expect.objectContaining({
      candidateId: 'semantic:order_item:revenue',
      facts: expect.arrayContaining([
        `capability:dimension:${customerNameId}:semantic:order_item:entity:customer`,
        `capability:native_grouping:${customerNameId}:customers__customer_name`,
      ]),
    }));
    expect(plan.query.dimensions[0]!.candidateIds).not.toEqual(expect.arrayContaining([
      'semantic:order_item:dimension:products.is_drink_item',
      'semantic:order_item:dimension:products.is_food_item',
    ]));
  });

  it('AGT-012 uses arbitrary authored entity and display labels without leaking attribute distractors', () => {
    const assetLabelId = 'semantic:maintenance:dimension:assets.asset_label';
    const assetMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:maintenance.open_cost',
      qualifiedId: 'semantic:maintenance:metric:open_cost',
      name: 'Open cost',
      aliases: ['maintenance cost'],
      analyticalCapability: {
        metricId: 'semantic:maintenance:metric:open_cost',
        measureIds: ['semantic:maintenance:measure:open_cost'],
        primaryEntityId: 'semantic:maintenance:entity:work_order',
        defaultResultGrainId: 'semantic:maintenance:entity:work_order',
        resultGrainIds: ['semantic:maintenance:entity:work_order'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          { dimensionId: assetLabelId, label: 'asset_label', entityId: 'semantic:maintenance:entity:asset', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'asset__asset_label', nativeGroupingPath: ['asset'] },
          { dimensionId: 'semantic:maintenance:dimension:assets.asset_type', label: 'asset_type', entityId: 'semantic:maintenance:entity:asset', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'asset__asset_type', nativeGroupingPath: ['asset'] },
          { dimensionId: 'semantic:maintenance:dimension:work_orders.asset_work_order_number', label: 'asset_work_order_number', entityId: 'semantic:maintenance:entity:work_order', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'work_order__asset_work_order_number', nativeGroupingPath: [] },
          { dimensionId: 'semantic:maintenance:dimension:parts.is_asset_critical', label: 'is_asset_critical', entityId: 'semantic:maintenance:entity:part', supportedRoles: ['group_by', 'display', 'rank_entity'], nativeGroupingReference: 'part__is_asset_critical', nativeGroupingPath: ['part'] },
        ],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:maintenance-open-cost',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which assets have the highest open cost?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank assets by open cost.',
        selectedConceptIds: [assetMetric.id],
        recommendedExecutionId: assetMetric.id,
        queryIntent: { measures: ['open cost'], dimensions: ['asset'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [assetMetric] },
      candidates: [assetMetric],
    });

    expect(plan.query.dimensions).toEqual([{
      requested: 'asset',
      qualifiedId: assetLabelId,
      status: 'resolved',
      candidateIds: [assetLabelId],
    }]);
    expect(plan.capability).toBe('semantic_execution');
  });

  it('AGT-012 retains every qualified selected-capability dimension when the entity binding is ambiguous', () => {
    const ambiguousMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'semantic:metric:support.case_volume',
      qualifiedId: 'semantic:support:metric:case_volume',
      name: 'Case volume',
      aliases: ['cases'],
      analyticalCapability: {
        metricId: 'semantic:support:metric:case_volume',
        measureIds: ['semantic:support:measure:case_count'],
        primaryEntityId: 'semantic:support:entity:case',
        defaultResultGrainId: 'semantic:support:grain:scalar',
        resultGrainIds: ['semantic:support:grain:scalar', 'semantic:support:entity:account'],
        aggregation: 'count',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [
          {
            dimensionId: 'semantic:support:dimension:billing_account',
            entityId: 'semantic:support:entity:account',
            supportedRoles: ['group_by', 'rank_entity'],
            nativeGroupingReference: 'case__account__billing_account',
            nativeGroupingPath: ['case', 'account'],
          },
          {
            dimensionId: 'semantic:support:dimension:service_account',
            entityId: 'semantic:support:entity:account',
            supportedRoles: ['group_by', 'rank_entity'],
            nativeGroupingReference: 'case__account__service_account',
            nativeGroupingPath: ['case', 'account'],
          },
        ],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'semantic', adapterId: 'native' }],
        sourceFingerprint: 'sha256:support-case-volume',
      },
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'Which accounts have the most cases?',
      resolution: {
        ...resolution,
        interpretedQuestion: 'Rank accounts by case volume.',
        selectedConceptIds: [ambiguousMetric.id],
        recommendedExecutionId: ambiguousMetric.id,
        queryIntent: { measures: ['case volume'], dimensions: ['account'], filters: [], order: 'desc', limit: 10 },
      },
      evidence: { ...evidence, candidates: [ambiguousMetric] },
      candidates: [ambiguousMetric],
    });

    expect(plan.query.dimensions).toEqual([expect.objectContaining({
      requested: 'account',
      status: 'ambiguous',
      candidateIds: [
        'semantic:support:dimension:billing_account',
        'semantic:support:dimension:service_account',
      ],
    })]);
    expect(plan.capability).toBe('blocked');
  });

  it('fails capability closed when a requested measure cannot bind inside the selected meaning', () => {
    const plan = buildResolvedAnalyticalPlan({
      question: 'Show rollover liability by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, measures: ['unrelated liability'] },
      },
      evidence,
      candidates: [metric],
    });
    expect(plan.query.measures).toEqual([
      expect.objectContaining({ requested: 'unrelated liability', status: 'unresolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
  });

  it('AGT-034 freezes an exact exploratory physical closure without reopening decoy snapshot outputs', () => {
    const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
    const physical = (name: string): AgentEvidenceCandidate => ({
      ...metric,
      id: `dbt:column:order_items.${name}`,
      qualifiedId: `order_items.${name}`,
      kind: 'sql_column',
      trustTier: 'exploratory',
      name,
      aliases: [name.replace(/_/g, ' ')],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
    });
    const orderItems: AgentEvidenceCandidate = {
      ...metric,
      id: 'dbt:model:order_items',
      qualifiedId: 'dbt::model.jaffle_shop.order_items',
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: 'order_items',
      aliases: ['order items'],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
    };
    const selectedColumns = ['order_id', 'product_id', 'product_price'].map(physical);
    // These neighbouring fields share a short leaf name but are not in the
    // router-selected single-relation closure. They must not make the frozen
    // output contract ambiguous.
    const decoys = [
      { ...physical('order_id'), id: 'dbt:column:orders.order_id', qualifiedId: 'orders.order_id', sourceObjects: ['orders'] },
      { ...physical('product_id'), id: 'dbt:column:products.product_id', qualifiedId: 'products.product_id', sourceObjects: ['products'] },
      { ...physical('product_price'), id: 'dbt:column:inventory.product_price', qualifiedId: 'inventory.product_price', sourceObjects: ['inventory'] },
    ];
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: { measures: ['product price'], dimensions: [], filters: [] },
    });
    const plan = buildResolvedAnalyticalPlan({
      question,
      resolution: {
        interpretedQuestion: question,
        questionType: 'ranking',
        selectedConceptIds: [orderItems, ...selectedColumns].map((candidate) => candidate.id),
        recommendedExecutionId: orderItems.id,
        queryIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'exploratory',
        hostRequirementSeed: seed,
      },
      evidence: { ...evidence, candidates: [orderItems, ...selectedColumns, ...decoys] },
      candidates: [orderItems, ...selectedColumns, ...decoys],
    });

    expect(plan.capability).toBe('bounded_exploration');
    expect(plan.query.dimensions).toEqual([]);
    expect(plan.outputContract.requiredOutputs).toEqual([
      expect.objectContaining({ requested: 'order id', qualifiedId: 'order_items.order_id', outputName: 'order_id', status: 'resolved' }),
      expect.objectContaining({ requested: 'product id', qualifiedId: 'order_items.product_id', outputName: 'product_id', status: 'resolved' }),
      expect.objectContaining({ requested: 'product price', qualifiedId: 'order_items.product_price', outputName: 'product_price', status: 'resolved' }),
    ]);
    expect(plan.selectedConceptIds).toEqual(expect.arrayContaining([
      'dbt::model.jaffle_shop.order_items',
      'order_items.order_id',
      'order_items.product_id',
      'order_items.product_price',
    ]));
    expect(plan.selectedConceptIds).not.toEqual(expect.arrayContaining([
      'orders.order_id',
      'products.product_id',
      'inventory.product_price',
    ]));
  });

  it('AGT-034 binds selected physical output identities one-to-one before the provisional governed route cascades', () => {
    const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
    const physical = (name: string, overrides: Partial<AgentEvidenceCandidate> = {}): AgentEvidenceCandidate => ({
      ...metric,
      id: `dbt:column:order_items.${name}`,
      qualifiedId: `order_items.${name}`,
      kind: 'sql_column',
      trustTier: 'exploratory',
      name,
      aliases: [name.replace(/_/g, ' ')],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
      ...overrides,
    });
    const orderItems: AgentEvidenceCandidate = {
      ...metric,
      id: 'dbt:model:order_items',
      qualifiedId: 'dbt::model.jaffle_shop.order_items',
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: 'order_items',
      aliases: ['order items'],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
    };
    const orderId = physical('order_id');
    // The metadata/index may emit the same physical output through two lanes.
    // It is one selected output, not a second interpretation.
    const duplicateOrderId = physical('order_id', {
      id: 'runtime:column:order_items.order_id',
      qualifiedId: 'order_items.order_id',
      aliases: ['order id', 'line order id'],
    });
    // A bad lexical alias cannot turn this physical product column into an
    // output alternative for the separately requested order identifier.
    const productId = physical('product_id', { aliases: ['product id', 'order id'] });
    const productPrice = physical('product_price');
    const decoys = [
      physical('order_id', {
        id: 'dbt:column:orders.order_id',
        qualifiedId: 'orders.order_id',
        sourceObjects: ['orders'],
      }),
      physical('product_id', {
        id: 'dbt:column:stg_order_items.product_id',
        qualifiedId: 'stg_order_items.product_id',
        sourceObjects: ['stg_order_items'],
      }),
    ];
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
    });
    const selected = [orderItems, orderId, duplicateOrderId, productId, productPrice];
    const plan = buildResolvedAnalyticalPlan({
      question,
      // The old provider payload sent this pre-cascade label. It must not
      // reopen the snapshot for host-owned outputs after selected IDs exist.
      resolution: {
        interpretedQuestion: question,
        questionType: 'value',
        selectedConceptIds: selected.map((candidate) => candidate.id),
        recommendedExecutionId: orderItems.id,
        queryIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
        hostRequirementSeed: seed,
      },
      evidence: { ...evidence, candidates: [...selected, ...decoys] },
      candidates: [...selected, ...decoys],
    });

    // A raw dbt/runtime closure is only provisional at this layer. The router
    // must evaluate its safe same-snapshot exploratory cascade before any
    // plan freezes; it is not a compiler-owned governed projection.
    expect(plan.capability).toBe('blocked');
    expect(plan.query).toMatchObject({
      order: 'desc',
      limit: 5,
      measures: [expect.objectContaining({ requested: 'product price', qualifiedId: 'order_items.product_price' })],
    });
    expect(plan.outputContract.requiredOutputs).toEqual([
      expect.objectContaining({
        requested: 'order id',
        qualifiedId: 'order_items.order_id',
        outputName: 'order_id',
        status: 'resolved',
        candidateIds: ['order_items.order_id'],
      }),
      expect.objectContaining({
        requested: 'product id',
        qualifiedId: 'order_items.product_id',
        outputName: 'product_id',
        status: 'resolved',
        candidateIds: ['order_items.product_id'],
      }),
      expect.objectContaining({
        requested: 'product price',
        qualifiedId: 'order_items.product_price',
        outputName: 'product_price',
        status: 'resolved',
        candidateIds: ['order_items.product_price'],
      }),
    ]);
    expect(plan.missingInformation).toEqual([
      'The selected governed_sql capability is not executable for this analytical tuple.',
    ]);
    expect(plan.outputContract.requiredOutputs?.[0]?.candidateIds).not.toContain('orders.order_id');
    expect(plan.outputContract.requiredOutputs?.[0]?.candidateIds).not.toContain('order_items.product_id');
    expect(plan.outputContract.requiredOutputs?.[1]?.candidateIds).not.toContain('stg_order_items.product_id');

    // The same leaf on a *different selected physical relation* remains a
    // genuine choice. Do not hide that ambiguity by treating all `order_id`
    // cards as duplicates; the cascade must retain it for clarification.
    const distinctOrderId = physical('order_id', {
      id: 'dbt:column:orders.order_id',
      qualifiedId: 'orders.order_id',
      sourceObjects: ['orders'],
    });
    const genuinelyAmbiguous = buildResolvedAnalyticalPlan({
      question,
      resolution: {
        interpretedQuestion: question,
        questionType: 'value',
        selectedConceptIds: [orderItems, orderId, distinctOrderId, productId, productPrice]
          .map((candidate) => candidate.id),
        recommendedExecutionId: orderItems.id,
        queryIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
        hostRequirementSeed: seed,
      },
      evidence: { ...evidence, candidates: [orderItems, orderId, distinctOrderId, productId, productPrice] },
      candidates: [orderItems, orderId, distinctOrderId, productId, productPrice],
    });
    expect(genuinelyAmbiguous.capability).toBe('blocked');
    expect(genuinelyAmbiguous.outputContract.requiredOutputs?.[0]).toMatchObject({
      requested: 'order id',
      status: 'ambiguous',
      candidateIds: ['order_items.order_id', 'orders.order_id'],
    });
  });

  it('AGT-034 rejects an alias-only product identifier when the requested order identifier is absent', () => {
    const question = 'Show the five most expensive individual order items with order ID, product ID, and product price.';
    const orderItems: AgentEvidenceCandidate = {
      ...metric,
      id: 'dbt:model:order_items',
      qualifiedId: 'dbt::model.jaffle_shop.order_items',
      kind: 'dbt_model',
      trustTier: 'exploratory',
      name: 'order_items',
      aliases: ['order items'],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
    };
    const productId: AgentEvidenceCandidate = {
      ...metric,
      id: 'dbt:column:order_items.product_id',
      qualifiedId: 'order_items.product_id',
      kind: 'sql_column',
      trustTier: 'exploratory',
      name: 'product_id',
      // Deliberately malformed retrieval metadata: an alias must not turn a
      // physical product key into the user-requested order key.
      aliases: ['product id', 'order id'],
      dimensions: undefined,
      timeGrains: undefined,
      analyticalCapability: undefined,
      sourceObjects: ['order_items'],
      compatibility: 'compatible',
    };
    const productPrice: AgentEvidenceCandidate = {
      ...productId,
      id: 'dbt:column:order_items.product_price',
      qualifiedId: 'order_items.product_price',
      name: 'product_price',
      aliases: ['product price'],
    };
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
    });
    const selected = [orderItems, productId, productPrice];
    const plan = buildResolvedAnalyticalPlan({
      question,
      resolution: {
        interpretedQuestion: question,
        questionType: 'value',
        selectedConceptIds: selected.map((candidate) => candidate.id),
        recommendedExecutionId: orderItems.id,
        queryIntent: { measures: ['product price'], dimensions: [], filters: [], order: 'desc', limit: 5 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
        hostRequirementSeed: seed,
      },
      evidence: { ...evidence, candidates: selected },
      candidates: selected,
    });

    const orderIdOutput = plan.outputContract.requiredOutputs?.find((binding) => binding.requested === 'order id');
    expect(orderIdOutput).toMatchObject({ status: 'unresolved', candidateIds: [] });
    expect(orderIdOutput).not.toHaveProperty('qualifiedId');
    expect(orderIdOutput?.candidateIds).not.toContain('order_items.product_id');
    expect(plan.capability).toBe('blocked');
    expect(plan.capability).not.toBe('bounded_exploration');
  });

  it('AGT-029 requires exact fresh automatic snapshot relationship proof before a cross-entity governed tuple can freeze', () => {
    const relationshipId = 'commerce::relationship::orders_to_customers';
    const governedMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'dql:metric:orders.revenue',
      qualifiedId: 'dql:metric:orders.revenue',
      kind: 'semantic_metric',
      trustTier: 'governed_sql',
      name: 'Revenue',
      aliases: ['revenue'],
      relationshipEvidence: [relationshipId],
      analyticalCapability: {
        metricId: 'dql:metric:orders.revenue',
        measureIds: ['dql:metric:orders.revenue'],
        primaryEntityId: 'commerce::entity::order',
        defaultResultGrainId: 'commerce::entity::order',
        // Result grain is descriptive only; it cannot replace the path proof.
        resultGrainIds: ['commerce::entity::order', 'commerce::entity::customer'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'dql:dimension:customers.customer_name',
          entityId: 'commerce::entity::customer',
          label: 'Customer Name',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
          relationshipPathIds: [relationshipId],
        }],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
        sourceFingerprint: 'sha256:governed-orders-revenue',
      },
    };
    const customer: AgentEvidenceCandidate = {
      ...metric,
      id: 'dql:dimension:customers.customer_name',
      qualifiedId: 'dql:dimension:customers.customer_name',
      kind: 'semantic_member',
      trustTier: 'governed_sql',
      name: 'Customer Name',
      aliases: ['customer'],
      analyticalCapability: undefined,
      relationshipEvidence: undefined,
      relationshipSafety: undefined,
    };
    const safety = (overrides: Partial<NonNullable<AgentEvidenceCandidate['relationshipSafety']>[number]> = {}) => ({
      id: relationshipId,
      from: 'commerce::entity::order',
      to: 'commerce::entity::customer',
      keys: [{ from: 'customer_id', to: 'customer_id' }],
      status: 'certified',
      cardinality: 'many_to_one',
      fanout: 'safe',
      staleCertification: false,
      automaticJoinAllowed: true,
      certificationFingerprint: 'sha256:orders-customers',
      validation: {
        status: 'passed',
        checkedAt: '2026-08-24T00:00:00.000Z',
        queryFingerprint: 'sha256:orders-customers-query',
        proofFingerprint: 'sha256:orders-customers-validation',
      },
      ...overrides,
    });
    const relationshipCarrier = (proof: ReturnType<typeof safety>): AgentEvidenceCandidate => ({
      ...customer,
      id: relationshipId,
      qualifiedId: relationshipId,
      name: 'Orders to Customers',
      relationshipEvidence: [relationshipId],
      relationshipSafety: [proof],
    });
    const governedResolution: MeaningResolution = {
      interpretedQuestion: 'Top customers by revenue.',
      questionType: 'ranking',
      selectedConceptIds: [governedMetric.id],
      recommendedExecutionId: governedMetric.id,
      queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [], order: 'desc', limit: 10 },
      rejectedCandidates: [],
      confidence: 'high',
      missingInformation: [],
      recommendedRoute: 'governed_sql',
    };
    const build = (proof?: ReturnType<typeof safety>, pathIds = [relationshipId]) => {
      const selected = {
        ...governedMetric,
        analyticalCapability: {
          ...governedMetric.analyticalCapability!,
          dimensions: [{
            ...governedMetric.analyticalCapability!.dimensions[0]!,
            relationshipPathIds: pathIds,
          }],
        },
      };
      const candidates = [selected, customer, ...(proof ? [relationshipCarrier(proof)] : [])];
      return buildResolvedAnalyticalPlan({
        question: governedResolution.interpretedQuestion,
        resolution: { ...governedResolution, selectedConceptIds: [selected.id], recommendedExecutionId: selected.id },
        evidence: { ...evidence, snapshotId: 'snapshot-governed-proof', candidates },
        candidates,
      });
    };

    expect(build(safety())).toMatchObject({
      capability: 'governed_relational',
      relationshipProofs: [expect.objectContaining({ relationshipPathIds: [relationshipId] })],
    });
    // A result-grain membership or a path label without a matching snapshot
    // proof cannot authorize the compiler-owned route.
    expect(build(undefined)).toMatchObject({ capability: 'blocked' });
    expect(build(safety(), [])).toMatchObject({ capability: 'blocked' });
    for (const invalid of [
      safety({ staleCertification: true }),
      safety({ status: 'draft', certificationFingerprint: undefined }),
      safety({ automaticJoinAllowed: false }),
      safety({ fanout: 'attribution_required' }),
    ]) {
      expect(build(invalid)).toMatchObject({ capability: 'blocked' });
    }
  });

  it('AGT-029 keeps a declared raw governed output pre-freeze when it is not a compiler projection', () => {
    const question = 'Show revenue by customer with order ID.';
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
    });
    const hostRequirementSeed = {
      ...seed,
      requirements: { ...seed.requirements, outputTerms: ['order id'] },
    };
    const governedMetric: AgentEvidenceCandidate = {
      ...metric,
      id: 'dql:metric:orders.revenue',
      qualifiedId: 'dql:metric:orders.revenue',
      kind: 'semantic_metric',
      trustTier: 'governed_sql',
      name: 'Revenue',
      analyticalCapability: {
        metricId: 'dql:metric:orders.revenue',
        measureIds: ['dql:metric:orders.revenue'],
        primaryEntityId: 'commerce::entity::order',
        defaultResultGrainId: 'commerce::entity::order',
        resultGrainIds: ['commerce::entity::order'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'dql:dimension:orders.customer_name',
          entityId: 'commerce::entity::order',
          label: 'Customer Name',
          aliases: ['customer'],
          supportedRoles: ['group_by', 'display', 'rank_entity'],
        }],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['dimension', 'metric_value'],
        // This declaration is insufficient: no compiler-owned dimension is
        // available for the user-named row-level output.
        declaredOutputIds: ['dbt:column:orders.order_id'],
        executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
        sourceFingerprint: 'sha256:governed-raw-output',
      },
    };
    const customer = {
      ...metric,
      id: 'dql:dimension:orders.customer_name',
      qualifiedId: 'dql:dimension:orders.customer_name',
      kind: 'dql_modeling' as const,
      trustTier: 'governed_sql' as const,
      name: 'Customer Name',
      aliases: ['customer'],
      analyticalCapability: undefined,
    };
    const rawOutput = {
      ...metric,
      id: 'dbt:column:orders.order_id',
      qualifiedId: 'dbt:column:orders.order_id',
      kind: 'sql_column' as const,
      trustTier: 'exploratory' as const,
      name: 'order_id',
      aliases: ['order id'],
      analyticalCapability: undefined,
      sourceObjects: ['runtime:relation:orders'],
    };
    const candidates = [governedMetric, customer, rawOutput];
    const plan = buildResolvedAnalyticalPlan({
      question,
      resolution: {
        interpretedQuestion: question,
        questionType: 'value',
        selectedConceptIds: [governedMetric.id, rawOutput.id],
        recommendedExecutionId: governedMetric.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
        hostRequirementSeed,
      },
      evidence: { ...evidence, snapshotId: 'snapshot-governed-raw-output', candidates },
      candidates,
    });

    expect(plan.outputContract.requiredOutputs).toEqual([
      expect.objectContaining({ requested: 'order id', qualifiedId: rawOutput.qualifiedId, status: 'resolved' }),
    ]);
    expect(plan.capability).toBe('blocked');
    expect(plan.relationshipProofs).toEqual([]);
  });

  it('AGT-029 requires every governed metric output to be selected in the frozen measure tuple', () => {
    const question = 'Show revenue with gross profit.';
    const seed = buildAnalyticalRequirementSeedV1({
      question,
      parsedIntent: { measures: ['revenue'], dimensions: [], filters: [] },
    });
    const hostRequirementSeed = {
      ...seed,
      requirements: { ...seed.requirements, outputTerms: ['gross profit'] },
    };
    const revenue: AgentEvidenceCandidate = {
      ...metric,
      id: 'dql:metric:orders.revenue',
      qualifiedId: 'dql:metric:orders.revenue',
      kind: 'semantic_metric',
      trustTier: 'governed_sql',
      name: 'Revenue',
      aliases: ['revenue'],
      analyticalCapability: {
        metricId: 'dql:metric:orders.revenue',
        measureIds: ['dql:metric:orders.revenue', 'dql:metric:orders.gross_profit'],
        primaryEntityId: 'commerce::entity::order',
        defaultResultGrainId: 'commerce::entity::order',
        resultGrainIds: ['commerce::entity::order'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [],
        timeDimensions: [],
        operations: ['group'],
        supportedOutputKinds: ['metric_value'],
        executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
        sourceFingerprint: 'sha256:governed-revenue-gross-profit',
      },
    };
    // The host output is a projection binding, while the selected measure is
    // its metric card. They intentionally share the exact qualified metric
    // identity so the frozen plan has to prove that the measure is actually
    // in the compiler tuple rather than merely declared by the capability.
    const grossProfitOutput: AgentEvidenceCandidate = {
      ...revenue,
      id: 'semantic:member:orders.gross_profit',
      qualifiedId: 'dql:metric:orders.gross_profit',
      kind: 'semantic_member',
      name: 'Gross Profit',
      aliases: ['gross profit'],
      analyticalCapability: undefined,
    };
    const grossProfitMeasure: AgentEvidenceCandidate = {
      ...revenue,
      id: 'dql:metric:orders.gross_profit',
      qualifiedId: 'dql:metric:orders.gross_profit',
      name: 'Gross Profit',
      aliases: ['gross profit'],
      analyticalCapability: undefined,
    };
    const candidates = [revenue, grossProfitOutput, grossProfitMeasure];
    const build = (measureTerms: string[]) => buildResolvedAnalyticalPlan({
      question,
      resolution: {
        interpretedQuestion: question,
        questionType: 'value',
        selectedConceptIds: candidates.map((candidate) => candidate.id),
        recommendedExecutionId: revenue.id,
        queryIntent: { measures: measureTerms, dimensions: [], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'governed_sql',
        hostRequirementSeed,
      },
      evidence: { ...evidence, snapshotId: 'snapshot-governed-metric-output', candidates },
      candidates,
    });

    const missingProjection = build(['revenue']);
    expect(missingProjection.outputContract.requiredOutputs).toEqual([
      expect.objectContaining({
        requested: 'gross profit',
        qualifiedId: grossProfitOutput.qualifiedId,
        status: 'resolved',
      }),
    ]);
    expect(missingProjection.query.measures).toEqual([
      expect.objectContaining({ qualifiedId: revenue.qualifiedId, status: 'resolved' }),
    ]);
    expect(missingProjection.capability).toBe('blocked');

    const completeProjection = build(['revenue', 'gross profit']);
    expect(completeProjection.query.measures).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedId: revenue.qualifiedId, status: 'resolved' }),
      expect.objectContaining({ qualifiedId: grossProfitMeasure.qualifiedId, status: 'resolved' }),
    ]));
    expect(completeProjection.capability).toBe('governed_relational');
  });

  it('AGT-009 never binds requested revenue to a certified block that returns only lifetime_spend', () => {
    const topCustomers: AgentEvidenceCandidate = {
      id: 'dql:block:top_customers',
      qualifiedId: 'orders::block::top_customers',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customers',
      relevanceScore: 1,
      matchReasons: ['tag: revenue'],
      compatibility: 'compatible',
      compatibilityFacts: ['output: customer_name', 'output: lifetime_spend', 'output: order_count'],
    };
    const plan = buildResolvedAnalyticalPlan({
      question: 'show me revenue',
      resolution: {
        interpretedQuestion: 'show me revenue',
        questionType: 'value',
        selectedConceptIds: [topCustomers.id],
        recommendedExecutionId: topCustomers.id,
        queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
      },
      evidence: { ...evidence, candidates: [topCustomers] },
      candidates: [topCustomers],
    });

    expect(plan.capability).toBe('blocked');
    expect(plan.query.measures).toEqual([
      expect.objectContaining({ requested: 'revenue', status: 'unresolved' }),
    ]);
    expect(plan.query.measures[0]).not.toHaveProperty('qualifiedId');
  });

  it('AGT-034 preserves a certified block display output when the host ranking seed says customer name', () => {
    const topCustomers: AgentEvidenceCandidate = {
      id: 'dql:block:top_customer_revenue',
      qualifiedId: 'orders::block::top_customer_revenue',
      kind: 'certified_block',
      trustTier: 'certified',
      name: 'top_customer_revenue',
      relevanceScore: 1,
      matchReasons: ['exact certified fit'],
      compatibility: 'compatible',
      compatibilityFacts: ['output: customer', 'output: revenue'],
      analyticalCapability: {
        metricId: 'semantic:commerce:metric:revenue',
        semanticModelId: 'semantic:commerce:model:orders',
        measureIds: ['semantic:commerce:metric:revenue'],
        primaryEntityId: 'semantic:commerce:entity:order',
        defaultResultGrainId: 'semantic:commerce:entity:customer',
        resultGrainIds: ['semantic:commerce:entity:customer'],
        aggregation: 'sum',
        additivity: { entities: 'additive', time: 'additive' },
        dimensions: [{
          dimensionId: 'semantic:commerce:dimension:customer',
          entityId: 'semantic:commerce:entity:customer',
          supportedRoles: ['group_by', 'rank_entity'],
          nativeGroupingReference: 'order__customer',
          nativeGroupingPath: ['order'],
        }],
        timeDimensions: [],
        operations: ['group', 'rank'],
        supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
        executionCapabilities: [{ route: 'certified', adapterId: 'native' }],
        sourceFingerprint: 'sha256:certified-top-customers',
      },
    };
    const seed = buildAnalyticalRequirementSeedV1({
      question: 'Who are the top customers by revenue?',
      parsedIntent: { measures: ['revenue'], dimensions: ['customer'] },
    });
    const analyticalFrame = {
      version: 2 as const,
      interpretedQuestion: seed.sourceQuestion,
      questionType: 'ranking' as const,
      metricConceptIds: ['semantic:commerce:metric:revenue'],
      entityGrainIds: ['semantic:commerce:entity:customer'],
      dimensions: [
        { dimensionId: 'semantic:commerce:dimension:customer', role: 'group_by' as const },
        { dimensionId: 'semantic:commerce:dimension:customer', role: 'rank_entity' as const },
      ],
      memberBindings: [],
      ranking: {
        entityDimensionId: 'semantic:commerce:dimension:customer',
        byMetricId: 'semantic:commerce:metric:revenue',
        direction: 'desc' as const,
        limit: 10,
        tiePolicy: 'stable_secondary_key' as const,
      },
      requestedOutputs: [
        { id: 'customer', kind: 'dimension' as const },
        { id: 'revenue', kind: 'metric_value' as const, metricId: 'semantic:commerce:metric:revenue' },
      ],
      ambiguity: [],
    };
    const plan = buildResolvedAnalyticalPlan({
      question: seed.sourceQuestion,
      resolution: {
        interpretedQuestion: seed.sourceQuestion,
        questionType: 'ranking',
        selectedConceptIds: [topCustomers.id],
        recommendedExecutionId: topCustomers.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer name'], filters: [], order: 'desc', limit: 10 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
        hostRequirementSeed: seed,
        analyticalFrame,
      },
      evidence: { ...evidence, candidates: [topCustomers] },
      candidates: [topCustomers],
    });

    expect(plan.capability).toBe('certified_execution');
    expect(plan.query.dimensions).toEqual([expect.objectContaining({
      requested: 'customer name',
      qualifiedId: 'orders::block::top_customer_revenue',
      outputName: 'customer',
      status: 'resolved',
    })]);

    // The selected block has contextual semantic capability metadata, but the
    // metadata cannot lend it a customer output it did not certify. The same
    // host seed/frame must remain pre-freeze when the block declares revenue
    // only; a later cascade may choose a proven semantic or exploratory tier,
    // but this route must never receive a certified/governed label.
    const revenueOnlyBlock: AgentEvidenceCandidate = {
      ...topCustomers,
      id: 'dql:block:revenue_only',
      qualifiedId: 'orders::block::revenue_only',
      compatibilityFacts: ['output: revenue'],
    };
    const denied = buildResolvedAnalyticalPlan({
      question: seed.sourceQuestion,
      resolution: {
        interpretedQuestion: seed.sourceQuestion,
        questionType: 'ranking',
        selectedConceptIds: [revenueOnlyBlock.id],
        recommendedExecutionId: revenueOnlyBlock.id,
        queryIntent: { measures: ['revenue'], dimensions: ['customer name'], filters: [], order: 'desc', limit: 10 },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'certified',
        hostRequirementSeed: seed,
        analyticalFrame,
      },
      evidence: { ...evidence, candidates: [revenueOnlyBlock] },
      candidates: [revenueOnlyBlock],
    });
    expect(denied.capability).toBe('blocked');
    expect(denied.capability).not.toBe('certified_execution');
    expect(denied.query.dimensions).toEqual([expect.objectContaining({
      requested: 'customer name',
      status: 'unresolved',
      candidateIds: [],
    })]);
    expect(denied.query.dimensions[0]).not.toHaveProperty('qualifiedId');
  });

  it('applies a typed follow-up delta without reading prior prose or SQL', () => {
    const root = buildResolvedAnalyticalPlan({
      question: 'Show rollover balance by customer.',
      resolution: {
        ...resolution,
        queryIntent: { ...resolution.queryIntent, timeRange: 'last month' },
      },
      evidence,
      candidates: [metric],
      mode: 'authoritative',
      referenceTime: new Date('2026-07-22T15:00:00Z'),
    });
    const followUp = deriveResolvedAnalyticalPlan(root, {
      question: 'Only Melissa, top 3.',
      selectedResultFilter: {
        binding: root.query.dimensions[0]!,
        value: 'Melissa Lopez',
        sourceTurnId: 'turn-1',
      },
      limit: 3,
    });
    expect(followUp).toMatchObject({
      parentPlanId: root.planId,
      rootPlanId: root.planId,
      revision: 1,
      snapshotId: root.snapshotId,
      executionId: root.executionId,
      query: {
        limit: 3,
        timeBounds: {
          startInclusive: '2026-06-01T00:00:00.000Z',
          endExclusive: '2026-07-01T00:00:00.000Z',
        },
        filters: [{
          value: 'Melissa Lopez',
          binding: { qualifiedId: 'semantic:consumption:dimension:customer' },
        }],
      },
    });
    expect(followUp.fingerprint).not.toBe(root.fingerprint);
    expect(followUp.query.timeBounds).toEqual(root.query.timeBounds);
    expect(Object.isFrozen(followUp)).toBe(true);
  });
});
