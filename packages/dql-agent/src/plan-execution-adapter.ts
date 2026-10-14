/**
 * The single identity adapter between a ResolvedAnalyticalPlan and execution.
 * It does no question search and no fuzzy rematching: every executable member
 * must resolve by an identity captured in the immutable registry snapshot.
 *
 * Acceptance: AGT-013, AGT-014, API-006.
 */

import {
  normalizeMetricCapabilityContract,
  type MetricCapabilityContract,
  type SemanticLayer,
} from '@zlens/core';
import type { KGNode } from './kg/types.js';
import type { MetadataObject } from './metadata/catalog.js';
import type { SemanticMemberSelection } from './semantic-bridge/compose.js';
import type {
  AnalyticalExecutionGraphV1,
  AnalyticalGraphSourceInvocationNode,
} from './analytical-execution-graph.js';
import type { ResolvedAnalyticalPlan, ResolvedPlanMemberBinding } from './resolved-analytical-plan.js';
import type { AnalyticalFreshnessRequestV1 } from './analytical-period-resolution.js';
import {
  authorityIdentitiesForKGNode,
  authorityIdentitiesForMetadataObject,
  retrievalAliasesForKGNode,
  semanticRuntimeReferencesForKGNode,
} from './semantic-identities.js';

export interface PlanExecutionRegistryEntry {
  node: KGNode;
  /** Exact execution identities only; free-form aliases are never included. */
  identities: string[];
  retrievalAliases?: string[];
}

/**
 * Add the frozen grouping outputs as deterministic ascending tie breakers.
 * Their order is the RAP/source output order; retrieval aliases and unrelated
 * compatible dimensions are never consulted.
 */
export function appendStableSemanticSecondaryOrder(
  orderBy: NonNullable<SemanticMemberSelection['orderBy']>,
  frozenGroupingNames: string[],
  tiePolicy: 'stable_secondary_key' | 'include_ties' | undefined,
): NonNullable<SemanticMemberSelection['orderBy']> {
  if (tiePolicy !== 'stable_secondary_key') return [...orderBy];
  const ordered = [...orderBy];
  const existing = new Set(ordered.map((order) => order.name));
  for (const name of frozenGroupingNames) {
    if (!existing.has(name)) {
      ordered.push({ name, direction: 'asc' });
      existing.add(name);
    }
  }
  return ordered;
}

export type PlanExecutionBlockedCode =
  | 'PLAN_BLOCKED'
  | 'SNAPSHOT_MISMATCH'
  | 'EXECUTION_ID_MISSING'
  | 'EXECUTION_ID_AMBIGUOUS'
  | 'EXECUTION_KIND_MISMATCH'
  | 'CERTIFICATION_REQUIRED'
  | 'SEMANTIC_LAYER_REQUIRED'
  | 'SEMANTIC_MEMBER_MISSING'
  | 'SEMANTIC_MEMBER_AMBIGUOUS'
  | 'TIME_DIMENSION_REQUIRED'
  | 'TIME_RANGE_UNBOUND'
  | 'EXECUTION_GRAPH_MISMATCH'
  | 'EXECUTION_GRAPH_ROUTE_MISMATCH';

export interface SemanticGraphInvocation {
  nodeId: string;
  adapterId?: string;
  selection: SemanticMemberSelection;
  outputAliases: AnalyticalGraphSourceInvocationNode['outputAliases'];
  period?: AnalyticalGraphSourceInvocationNode['period'];
}

export type SemanticGraphExecutionBinding =
  | {
      schemaVersion: 1;
      status: 'ready';
      kind: 'semantic_graph';
      graphId: string;
      graphFingerprint: string;
      planId: string;
      planFingerprint: string;
      /**
       * The exact normalized capability frozen on the RAP. The registry node
       * remains the adapter identity lookup, but it is allowed to be a compact
       * projection that omits relationship-path metadata. Reconstructing
       * aggregation authority from that projection would make a valid native
       * MetricFlow grouping fail after the graph has already accepted it.
       */
      capability: MetricCapabilityContract;
      metricNode: KGNode;
      invocations: SemanticGraphInvocation[];
    }
  | {
      schemaVersion: 1;
      status: 'blocked';
      kind: 'semantic_graph';
      graphId: string;
      graphFingerprint: string;
      planId: string;
      planFingerprint: string;
      code: PlanExecutionBlockedCode;
      reason: string;
      candidateIds?: string[];
    };

export type PlanExecutionBinding =
  | {
      schemaVersion: 1;
      status: 'ready';
      kind: 'certified';
      planId: string;
      fingerprint: string;
      node: KGNode;
    }
  | {
      schemaVersion: 1;
      status: 'ready';
      kind: 'semantic';
      planId: string;
      fingerprint: string;
      metricNode: KGNode;
      selection: SemanticMemberSelection;
    }
  | {
      schemaVersion: 1;
      status: 'delegated';
      kind: 'governed_relational' | 'bounded_exploration';
      planId: string;
      fingerprint: string;
    }
  | {
      schemaVersion: 1;
      status: 'blocked';
      kind: 'blocked';
      planId: string;
      fingerprint: string;
      code: PlanExecutionBlockedCode;
      reason: string;
      candidateIds?: string[];
    };

export type AnalyticalFreshnessAdapterBinding =
  | {
      schemaVersion: 1;
      status: 'ready';
      kind: 'semantic_freshness';
      request: NonNullable<AnalyticalFreshnessRequestV1['authorizedAdapterRequest']>;
    }
  | {
      schemaVersion: 1;
      status: 'blocked';
      kind: 'semantic_freshness';
      code: PlanExecutionBlockedCode;
      reason: string;
      candidateIds?: string[];
    };

export interface AdaptResolvedAnalyticalPlanInput {
  plan: ResolvedAnalyticalPlan;
  registry: PlanExecutionRegistryEntry[];
  semanticLayer?: SemanticLayer;
  expectedSnapshotId?: string;
}

export function buildPlanExecutionRegistry(input: {
  nodes: KGNode[];
  objects?: MetadataObject[];
}): PlanExecutionRegistryEntry[] {
  const byNodeId = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const identitiesByNode = new Map<string, Set<string>>();
  for (const node of input.nodes) {
    identitiesByNode.set(node.nodeId, new Set(authorityIdentitiesForKGNode(node)));
  }
  for (const object of input.objects ?? []) {
    const nodeId = nodeIdForMetadataObject(object);
    if (!nodeId || !byNodeId.has(nodeId)) continue;
    const identities = identitiesByNode.get(nodeId) ?? new Set<string>();
    for (const identity of authorityIdentitiesForMetadataObject(object)) identities.add(identity);
    identitiesByNode.set(nodeId, identities);
  }
  return input.nodes.map((node) => ({
    node,
    identities: [...(identitiesByNode.get(node.nodeId) ?? [])].filter(Boolean).sort(),
    retrievalAliases: retrievalAliasesForKGNode(node).sort(),
  }));
}

export function adaptResolvedAnalyticalPlan(
  input: AdaptResolvedAnalyticalPlanInput,
): PlanExecutionBinding {
  const { plan } = input;
  const block = (code: PlanExecutionBlockedCode, reason: string, candidateIds?: string[]): PlanExecutionBinding => ({
    schemaVersion: 1,
    status: 'blocked',
    kind: 'blocked',
    planId: plan.planId,
    fingerprint: plan.fingerprint,
    code,
    reason,
    ...(candidateIds?.length ? { candidateIds: [...candidateIds].sort() } : {}),
  });
  if (input.expectedSnapshotId && plan.snapshotId !== input.expectedSnapshotId) {
    return block('SNAPSHOT_MISMATCH', `Plan snapshot ${plan.snapshotId} does not match active snapshot ${input.expectedSnapshotId}.`);
  }
  if (plan.capability === 'blocked') {
    return block('PLAN_BLOCKED', plan.missingInformation.join(' ') || 'The resolved plan is not executable.');
  }
  if (plan.capability === 'governed_relational' || plan.capability === 'bounded_exploration') {
    return {
      schemaVersion: 1,
      status: 'delegated',
      kind: plan.capability,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
    };
  }
  if (!plan.executionId) return block('EXECUTION_ID_MISSING', 'The resolved plan has no qualified execution ID.');
  const execution = resolveRegistryIdentity(plan.executionId, input.registry);
  if (execution.length === 0) {
    return block('EXECUTION_ID_MISSING', `Qualified execution ID ${plan.executionId} is not present in the pinned registry.`);
  }
  if (execution.length > 1) {
    return block('EXECUTION_ID_AMBIGUOUS', `Qualified execution ID ${plan.executionId} resolves to more than one registry object.`, execution.map((entry) => entry.node.nodeId));
  }
  const entry = execution[0]!;
  if (plan.capability === 'certified_execution') {
    if (entry.node.kind !== 'block') {
      return block('EXECUTION_KIND_MISMATCH', `${plan.executionId} is ${entry.node.kind}, not a certified block.`);
    }
    if (entry.node.status !== 'certified') {
      return block('CERTIFICATION_REQUIRED', `${plan.executionId} is not certified in the pinned snapshot.`);
    }
    return {
      schemaVersion: 1,
      status: 'ready',
      kind: 'certified',
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      node: entry.node,
    };
  }
  if (entry.node.kind !== 'metric') {
    return block('EXECUTION_KIND_MISMATCH', `${plan.executionId} is ${entry.node.kind}, not a semantic metric.`);
  }
  const selectedCapability = normalizeMetricCapabilityContract(plan.selectedCapability);
  if (!input.semanticLayer) {
    const entryCapability = normalizeMetricCapabilityContract(entry.node.payload?.analyticalCapability);
    if (
      !selectedCapability
      || !entryCapability
      || selectedCapability.sourceFingerprint !== entryCapability.sourceFingerprint
      || plan.selectedCapabilityFingerprint !== selectedCapability.sourceFingerprint
    ) return block('SEMANTIC_LAYER_REQUIRED', 'The pinned semantic layer is unavailable.');
    return {
      schemaVersion: 1,
      status: 'ready',
      kind: 'semantic',
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      metricNode: entry.node,
      selection: { metrics: [entry.node.name], dimensions: [] },
    };
  }
  const metricNames: string[] = [];
  const metricBindings = plan.query.measures.length > 0
    ? plan.query.measures
    : [{
        requested: entry.node.name,
        qualifiedId: plan.executionId,
        status: 'resolved' as const,
        candidateIds: [plan.executionId],
      }];
  for (const binding of metricBindings) {
    const resolved = resolveSemanticMetric(binding, input.registry, input.semanticLayer);
    if ('code' in resolved) return block(resolved.code, resolved.reason, resolved.candidateIds);
    if (!metricNames.includes(resolved.name)) metricNames.push(resolved.name);
  }

  const dimensions: string[] = [];
  const dimensionOutputAliases: string[] = [];
  let timeDimension: SemanticMemberSelection['timeDimension'];
  let timeFilterDimensionName: string | undefined;
  for (const binding of plan.query.dimensions) {
    const resolved = resolveSemanticDimension(
      binding,
      input.registry,
      input.semanticLayer,
      selectedCapability,
      plan.schemaVersion === 1,
      metricNames,
    );
    if ('code' in resolved) return block(resolved.code, resolved.reason, resolved.candidateIds);
    if (isTimeDimension(resolved.definition)) {
      timeFilterDimensionName = resolved.name;
      if (timeDimension && timeDimension.name !== resolved.name) {
        return block('SEMANTIC_MEMBER_AMBIGUOUS', 'The plan selects more than one time dimension.', [timeDimension.name, resolved.name]);
      }
      if (plan.query.timeGrain) timeDimension = { name: resolved.name, granularity: plan.query.timeGrain };
      else dimensions.push(resolved.name);
    } else {
      dimensions.push(resolved.name);
      dimensionOutputAliases.push(resolved.definition.name);
    }
  }
  const filters: NonNullable<SemanticMemberSelection['filters']> = [];
  for (const filter of plan.query.filters) {
    const resolved = resolveSemanticDimension(
      filter.binding,
      input.registry,
      input.semanticLayer,
      selectedCapability,
      plan.schemaVersion === 1,
      metricNames,
    );
    if ('code' in resolved) return block(resolved.code, resolved.reason, resolved.candidateIds);
    filters.push({ dimension: resolved.name, operator: 'equals', values: [filter.value] });
  }

  if ((plan.query.timeGrain || plan.query.timeBounds) && !timeFilterDimensionName) {
    const defaultNames = Array.from(new Set(metricNames.map((metricName) =>
      input.semanticLayer!.listMetrics().find((candidate) => candidate.name === metricName)?.aggTimeDimension,
    ).filter((name): name is string => Boolean(name))));
    if (defaultNames.length > 1) {
      return block(
        'TIME_DIMENSION_REQUIRED',
        `Selected metrics do not share one default time dimension: ${metricNames.join(', ')}.`,
        defaultNames,
      );
    }
    const defaultName = defaultNames[0];
    const defaultDimension = defaultName ? input.semanticLayer.getTimeDimension(defaultName) : undefined;
    if (!defaultDimension) {
      return block('TIME_DIMENSION_REQUIRED', `Metrics ${metricNames.join(', ')} have no shared default time dimension for the requested time scope.`);
    }
    timeFilterDimensionName = defaultDimension.name;
    if (plan.query.timeGrain) timeDimension = { name: defaultDimension.name, granularity: plan.query.timeGrain };
  }
  if (plan.query.timeBounds && timeFilterDimensionName) {
    filters.push(
      { dimension: timeFilterDimensionName, operator: 'gte', values: [plan.query.timeBounds.startInclusive] },
      { dimension: timeFilterDimensionName, operator: 'lt', values: [plan.query.timeBounds.endExclusive] },
    );
  } else if (plan.query.timeRange) {
    return block('TIME_RANGE_UNBOUND', `Time range "${plan.query.timeRange}" must be resolved to typed bounds before execution.`);
  }
  const selection: SemanticMemberSelection = {
    metrics: metricNames,
    dimensions,
    ...(timeDimension ? { timeDimension } : {}),
    ...(filters.length ? { filters } : {}),
    ...(plan.query.order ? {
      orderBy: appendStableSemanticSecondaryOrder(
        [{ name: metricNames[0]!, direction: plan.query.order }],
        dimensionOutputAliases,
        plan.analyticalFrame?.ranking?.tiePolicy,
      ),
    } : {}),
    ...(plan.query.limit !== undefined ? { limit: plan.query.limit } : {}),
  };
  return {
    schemaVersion: 1,
    status: 'ready',
    kind: 'semantic',
    planId: plan.planId,
    fingerprint: plan.fingerprint,
    metricNode: entry.node,
    selection,
  };
}

/**
 * Bind a freshness observation to the same exact semantic identities as the
 * selected plan. This is intentionally not a search API: the request, plan,
 * registry, and semantic layer must all agree before the host receives adapter
 * member names. Acceptance: AGT-019, SEC-004.
 */
export function adaptAnalyticalFreshnessRequest(input: {
  plan: ResolvedAnalyticalPlan;
  request: AnalyticalFreshnessRequestV1;
  registry: PlanExecutionRegistryEntry[];
  semanticLayer: SemanticLayer;
  expectedSnapshotId?: string;
}): AnalyticalFreshnessAdapterBinding {
  const block = (
    code: PlanExecutionBlockedCode,
    reason: string,
    candidateIds?: string[],
  ): AnalyticalFreshnessAdapterBinding => ({
    schemaVersion: 1,
    status: 'blocked',
    kind: 'semantic_freshness',
    code,
    reason,
    ...(candidateIds?.length ? { candidateIds: [...candidateIds].sort() } : {}),
  });
  const frame = input.plan.analyticalFrame;
  const time = frame?.timeContext;
  if (input.plan.schemaVersion !== 2 || input.plan.capability !== 'semantic_execution' || !frame || !time) {
    return block('PLAN_BLOCKED', 'The selected plan does not define a semantic analytical freshness route.');
  }
  if (
    input.request.snapshotId !== input.plan.snapshotId
    || (input.expectedSnapshotId && input.request.snapshotId !== input.expectedSnapshotId)
  ) {
    return block('SNAPSHOT_MISMATCH', 'The freshness request does not match the pinned analytical snapshot.');
  }
  if (input.request.metricId !== frame.metricConceptIds[0]) {
    return block('EXECUTION_ID_MISSING', 'The freshness metric does not match the immutable analytical frame.');
  }
  if (!time.timeDimensionId || input.request.timeDimensionId !== time.timeDimensionId) {
    return block('TIME_DIMENSION_REQUIRED', 'The freshness time dimension does not match the immutable analytical frame.');
  }
  if (!input.plan.executionId) {
    return block('EXECUTION_ID_MISSING', 'The semantic plan has no qualified execution identity.');
  }
  const executions = resolveRegistryIdentity(input.plan.executionId, input.registry);
  if (executions.length !== 1) {
    return block(
      executions.length > 1 ? 'EXECUTION_ID_AMBIGUOUS' : 'EXECUTION_ID_MISSING',
      `Qualified execution ID ${input.plan.executionId} resolves to ${executions.length} pinned registry objects.`,
      executions.map((entry) => entry.node.nodeId),
    );
  }
  const metricNode = executions[0]!.node;
  if (metricNode.kind !== 'metric') {
    return block('EXECUTION_KIND_MISMATCH', `${input.plan.executionId} is ${metricNode.kind}, not a semantic metric.`);
  }
  const metricNames = semanticMetricNames(metricNode, input.semanticLayer);
  if (metricNames.length !== 1) {
    return block(
      metricNames.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      `${input.plan.executionId} maps to ${metricNames.length} semantic metrics.`,
      metricNames,
    );
  }
  const resolvedTime = resolveSemanticDimensionId(time.timeDimensionId, input.registry, input.semanticLayer);
  if ('code' in resolvedTime) return block(resolvedTime.code, resolvedTime.reason, resolvedTime.candidateIds);
  const resolvedTimeDefinition = resolvedTime.definition;
  if (!resolvedTimeDefinition || !isTimeDimension(resolvedTimeDefinition)) {
    return block('TIME_DIMENSION_REQUIRED', `${time.timeDimensionId} is not a semantic time dimension.`);
  }
  const timeDefinitions = input.semanticLayer.listTimeDimensions().filter((candidate) =>
    candidate.name === resolvedTimeDefinition.name
    && candidate.table === resolvedTimeDefinition.table);
  if (timeDefinitions.length !== 1) {
    return block(
      timeDefinitions.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      `${time.timeDimensionId} maps to ${timeDefinitions.length} semantic time definitions.`,
      timeDefinitions.map((candidate) => `${candidate.cube ?? candidate.table}.${candidate.name}`),
    );
  }
  const timeDefinition = timeDefinitions[0]!;
  const availableGrains = timeDefinition.granularities;
  const requestedGrain = availableGrains.find((candidate) => candidate === time.grain);
  const granularity = availableGrains.includes('day')
    ? 'day'
    : requestedGrain ?? availableGrains[0] ?? 'day';
  const outputField = `${timeDefinition.name}_${granularity}`;
  return {
    schemaVersion: 1,
    status: 'ready',
    kind: 'semantic_freshness',
    request: {
      route: 'semantic',
      metric: metricNames[0]!,
      timeDimension: resolvedTime.name,
      granularity,
      outputField,
    },
  };
}

/**
 * Convert semantic source nodes into exact adapter selections. Every metric,
 * dimension, filter, and period comes from the frozen graph/plan; this adapter
 * performs identity lookup only and never searches or rematches question text.
 *
 * Acceptance: AGT-014, AGT-018, AGT-019.
 */
export function adaptAnalyticalSemanticGraph(input: {
  graph: AnalyticalExecutionGraphV1;
  plan: ResolvedAnalyticalPlan;
  registry: PlanExecutionRegistryEntry[];
  semanticLayer: SemanticLayer;
  expectedSnapshotId?: string;
}): SemanticGraphExecutionBinding {
  const { graph, plan } = input;
  const block = (
    code: PlanExecutionBlockedCode,
    reason: string,
    candidateIds?: string[],
  ): SemanticGraphExecutionBinding => ({
    schemaVersion: 1,
    status: 'blocked',
    kind: 'semantic_graph',
    graphId: graph.graphId,
    graphFingerprint: graph.fingerprint,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    code,
    reason,
    ...(candidateIds?.length ? { candidateIds: [...candidateIds].sort() } : {}),
  });
  if (
    graph.planId !== plan.planId ||
    graph.planFingerprint !== plan.fingerprint ||
    graph.snapshotId !== plan.snapshotId
  ) {
    return block('EXECUTION_GRAPH_MISMATCH', 'The executable graph does not bind the supplied immutable plan.');
  }
  const expectedRelationshipProofs = [...new Set(
    plan.relationshipProofs?.map((proof) => proof.authorityFingerprint) ?? [],
  )].sort();
  if ([...graph.relationshipProofFingerprints ?? []].sort().join('|') !== expectedRelationshipProofs.join('|')) {
    return block('EXECUTION_GRAPH_MISMATCH', 'The executable graph relationship authority does not match the immutable plan.');
  }
  if (input.expectedSnapshotId && graph.snapshotId !== input.expectedSnapshotId) {
    return block(
      'SNAPSHOT_MISMATCH',
      `Graph snapshot ${graph.snapshotId} does not match active snapshot ${input.expectedSnapshotId}.`,
    );
  }
  if (graph.route !== 'semantic') {
    return block('EXECUTION_GRAPH_ROUTE_MISMATCH', `Graph route ${graph.route} is not semantic.`);
  }
  if (!plan.executionId) return block('EXECUTION_ID_MISSING', 'The resolved plan has no qualified semantic execution ID.');
  const execution = resolveRegistryIdentity(plan.executionId, input.registry);
  if (execution.length !== 1) {
    return block(
      execution.length > 1 ? 'EXECUTION_ID_AMBIGUOUS' : 'EXECUTION_ID_MISSING',
      `Qualified execution ID ${plan.executionId} resolves to ${execution.length} pinned registry objects.`,
      execution.map((entry) => entry.node.nodeId),
    );
  }
  const metricNode = execution[0]!.node;
  if (metricNode.kind !== 'metric') {
    return block('EXECUTION_KIND_MISMATCH', `${plan.executionId} is ${metricNode.kind}, not a semantic metric.`);
  }
  const selectedCapability = normalizeMetricCapabilityContract(plan.selectedCapability);
  const metricNodeCapability = normalizeMetricCapabilityContract(metricNode.payload?.analyticalCapability);
  const semanticExecution = selectedCapability?.executionCapabilities.find((candidate) =>
    candidate.route === 'semantic' && candidate.adapterId === graph.adapterId);
  if (
    !selectedCapability
    || plan.selectedCapabilityFingerprint !== selectedCapability.sourceFingerprint
    || plan.executionId !== selectedCapability.metricId
    || graph.metricId !== selectedCapability.metricId
    || graph.capabilityFingerprint !== selectedCapability.sourceFingerprint
    || !semanticExecution
    || (metricNodeCapability !== undefined && (
      metricNodeCapability.metricId !== selectedCapability.metricId
      || metricNodeCapability.sourceFingerprint !== selectedCapability.sourceFingerprint
    ))
  ) {
    return block(
      'EXECUTION_GRAPH_MISMATCH',
      'The semantic graph, frozen capability, and pinned registry metric do not share one exact execution authority.',
      [plan.executionId, graph.metricId],
    );
  }
  const metricNames = semanticMetricNames(metricNode, input.semanticLayer);
  if (metricNames.length !== 1) {
    return block(
      metricNames.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      `${plan.executionId} maps to ${metricNames.length} semantic metrics.`,
      metricNames,
    );
  }
  const invocations: SemanticGraphInvocation[] = [];
  const frame = plan.analyticalFrame;
  const sourceRanking = frame && !frame.comparison
    && frame.ranking?.byMetricId === frame.metricConceptIds[0]
    ? frame.ranking
    : undefined;
  for (const source of graph.nodes.filter(
    (node): node is AnalyticalGraphSourceInvocationNode => node.kind === 'source_invocation',
  )) {
    if (source.strategy !== 'period_aggregate') {
      return block('EXECUTION_GRAPH_ROUTE_MISMATCH', 'A semantic graph cannot invoke a complete certified asset.');
    }
    const dimensions: string[] = [];
    const dimensionOutputAliases: string[] = [];
    let timeDimension: SemanticMemberSelection['timeDimension'];
    for (const dimensionId of source.groupByDimensionIds) {
      const resolved = resolveSemanticDimensionId(
        dimensionId,
        input.registry,
        input.semanticLayer,
        selectedCapability,
        metricNames,
      );
      if ('code' in resolved) return block(resolved.code, resolved.reason, resolved.candidateIds);
      if (source.period?.timeDimensionId === dimensionId) {
        timeDimension = { name: resolved.name, granularity: source.period.grain };
      } else {
        dimensions.push(resolved.name);
        dimensionOutputAliases.push(resolved.definition.name);
      }
    }
    const filters: NonNullable<SemanticMemberSelection['filters']> = [];
    for (const member of source.memberFilters) {
      const resolved = resolveSemanticDimensionId(
        member.dimensionId,
        input.registry,
        input.semanticLayer,
        selectedCapability,
        metricNames,
      );
      if ('code' in resolved) return block(resolved.code, resolved.reason, resolved.candidateIds);
      const values = member.canonicalValues.flatMap((value) => scalarFilterValue(value));
      if (values.length !== member.canonicalValues.length) {
        return block('SEMANTIC_MEMBER_MISSING', `Filter ${member.dimensionId} contains a non-scalar canonical value.`);
      }
      filters.push({ dimension: resolved.name, operator: 'equals', values });
    }
    if (source.period) {
      const resolvedTime = resolveSemanticDimensionId(
        source.period.timeDimensionId,
        input.registry,
        input.semanticLayer,
      );
      if ('code' in resolvedTime) return block(resolvedTime.code, resolvedTime.reason, resolvedTime.candidateIds);
      filters.push(
        {
          dimension: resolvedTime.name,
          operator: 'gte',
          values: [source.period.startInclusive],
        },
        {
          dimension: resolvedTime.name,
          operator: 'lt',
          values: [source.period.endExclusive],
        },
      );
    }
    invocations.push({
      nodeId: source.id,
      ...(source.adapterId ? { adapterId: source.adapterId } : {}),
      selection: {
        metrics: metricNames,
        dimensions,
        ...(timeDimension ? { timeDimension } : {}),
        ...(filters.length ? { filters } : {}),
        ...(sourceRanking
          ? {
              orderBy: appendStableSemanticSecondaryOrder(
                [{ name: metricNames[0]!, direction: sourceRanking.direction }],
                dimensionOutputAliases,
                sourceRanking.tiePolicy,
              ),
              limit: sourceRanking.limit,
            }
          : {}),
      },
      outputAliases: structuredClone(source.outputAliases),
      ...(source.period ? { period: structuredClone(source.period) } : {}),
    });
  }
  return {
    schemaVersion: 1,
    status: 'ready',
    kind: 'semantic_graph',
    graphId: graph.graphId,
    graphFingerprint: graph.fingerprint,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    capability: selectedCapability,
    metricNode,
    invocations,
  };
}

function resolveRegistryIdentity(identity: string, registry: PlanExecutionRegistryEntry[]): PlanExecutionRegistryEntry[] {
  return registry.filter((entry) => entry.identities.includes(identity));
}

function resolveSemanticMetric(
  binding: ResolvedPlanMemberBinding,
  registry: PlanExecutionRegistryEntry[],
  layer: SemanticLayer,
): { name: string; node: KGNode } | {
  code: 'SEMANTIC_MEMBER_MISSING' | 'SEMANTIC_MEMBER_AMBIGUOUS';
  reason: string;
  candidateIds?: string[];
} {
  if (binding.status !== 'resolved' || !binding.qualifiedId) {
    return {
      code: binding.status === 'ambiguous' ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: `Metric ${binding.requested} is ${binding.status} in the resolved plan.`,
      candidateIds: binding.candidateIds,
    };
  }
  const matches = resolveRegistryIdentity(binding.qualifiedId, registry).filter((candidate) => candidate.node.kind === 'metric');
  if (matches.length !== 1) {
    return {
      code: matches.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: `Qualified metric ${binding.qualifiedId} resolves to ${matches.length} pinned registry objects.`,
      candidateIds: matches.map((candidate) => candidate.node.nodeId),
    };
  }
  const names = semanticMetricNames(matches[0]!.node, layer);
  if (names.length !== 1) {
    return {
      code: names.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: `Qualified metric ${binding.qualifiedId} maps to ${names.length} semantic definitions.`,
      candidateIds: names,
    };
  }
  return { name: names[0]!, node: matches[0]!.node };
}

function resolveSemanticDimension(
  binding: ResolvedPlanMemberBinding,
  registry: PlanExecutionRegistryEntry[],
  layer: SemanticLayer,
  selectedCapability = undefined as ReturnType<typeof normalizeMetricCapabilityContract>,
  allowLegacyCapabilityFallback = false,
  selectedMetricNames: string[] = [],
): { name: string; definition: NonNullable<ReturnType<SemanticLayer['resolveGroupBy']>> } | {
  code: 'SEMANTIC_MEMBER_MISSING' | 'SEMANTIC_MEMBER_AMBIGUOUS';
  reason: string;
  candidateIds?: string[];
} {
  if (binding.status !== 'resolved' || !binding.qualifiedId) {
    return {
      code: binding.status === 'ambiguous' ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: `Dimension ${binding.requested} is ${binding.status} in the resolved plan.`,
      candidateIds: binding.candidateIds,
    };
  }
  const matches = resolveRegistryIdentity(binding.qualifiedId, registry).filter((entry) => entry.node.kind === 'dimension');
  if (matches.length === 0 && allowLegacyCapabilityFallback) {
    const capabilityMatches = selectedCapability?.dimensions.filter((dimension) =>
      dimension.dimensionId === binding.qualifiedId) ?? [];
    const definitions = capabilityMatches.length === 1
      ? uniqueDefinitions([layer.resolveGroupBy(binding.qualifiedId), layer.resolveGroupBy(binding.requested)])
      : [];
    if (definitions.length === 1) {
      return {
        name: definitions[0]!.qualifiedName ?? definitions[0]!.name,
        definition: definitions[0],
      };
    }
  }
  if (matches.length !== 1) {
    return {
      code: matches.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: `Qualified dimension ${binding.qualifiedId} resolves to ${matches.length} pinned registry objects.`,
      candidateIds: matches.map((entry) => entry.node.nodeId),
    };
  }
  const node = matches[0]!.node;
  const capabilityDimension = selectedCapability?.dimensions.find((dimension) =>
    dimension.dimensionId === binding.qualifiedId);
  const crossModelCapabilityDimension = Boolean(
    capabilityDimension
    && selectedCapability
    && capabilityDimension.entityId !== selectedCapability.primaryEntityId,
  );
  // A cross-model semantic grouping is not a bare catalog field. It must use
  // the metric-relative MetricFlow reference frozen in the capability (for
  // example `order_id__location__location_name`). Passing
  // `locations.location_name` through here discards the proven entity path and
  // lets composeQuery bind an unrelated leaf variant or fail after freeze.
  const nativeGroupingReference = crossModelCapabilityDimension
    ? capabilityDimension?.nativeGroupingReference?.trim()
    : undefined;
  const nativeGroupingPath = crossModelCapabilityDimension
    ? capabilityDimension?.nativeGroupingPath?.map((part) => part.trim()).filter(Boolean) ?? []
    : [];
  if (crossModelCapabilityDimension && (!nativeGroupingReference || nativeGroupingPath.length === 0)) {
    return {
      code: 'SEMANTIC_MEMBER_MISSING',
      reason: `Qualified dimension ${binding.qualifiedId} has no adapter-native grouping proof for the selected metric.`,
      candidateIds: [binding.qualifiedId],
    };
  }
  const candidates = nativeGroupingReference
    ? exactNativeGroupingDefinitions({
        layer,
        metricNames: selectedMetricNames,
        reference: nativeGroupingReference,
        entityPath: nativeGroupingPath,
      })
    : uniqueDefinitions(semanticRuntimeReferencesForKGNode(node)
        .map((reference) => layer.resolveGroupBy(reference)));
  if (candidates.length !== 1) {
    return {
      code: candidates.length > 1 ? 'SEMANTIC_MEMBER_AMBIGUOUS' : 'SEMANTIC_MEMBER_MISSING',
      reason: nativeGroupingReference
        ? `Qualified dimension ${binding.qualifiedId} is not an exact MetricFlow grouping for the selected metric tuple.`
        : `Qualified dimension ${binding.qualifiedId} maps to ${candidates.length} semantic definitions.`,
      candidateIds: candidates.map((candidate) => `${candidate.cube ?? candidate.table}.${candidate.name}`),
    };
  }
  return {
    // Preserve the exact metric-relative reference for composeQuery. The
    // definition still owns output aliases (`location_name`) and type checks.
    name: nativeGroupingReference ?? candidates[0]!.qualifiedName ?? candidates[0]!.name,
    definition: candidates[0],
  };
}

function resolveSemanticDimensionId(
  dimensionId: string,
  registry: PlanExecutionRegistryEntry[],
  layer: SemanticLayer,
  selectedCapability = undefined as ReturnType<typeof normalizeMetricCapabilityContract>,
  selectedMetricNames: string[] = [],
): ReturnType<typeof resolveSemanticDimension> {
  return resolveSemanticDimension(
    {
      requested: dimensionId,
      qualifiedId: dimensionId,
      status: 'resolved',
      candidateIds: [dimensionId],
    },
    registry,
    layer,
    selectedCapability,
    false,
    selectedMetricNames,
  );
}

/**
 * Resolve a cross-model grouping from the selected metric's own MetricFlow
 * compatibility graph. `SemanticLayer.resolveGroupBy()` deliberately accepts
 * a bare leaf as a legacy convenience, so it cannot prove that a frozen
 * multi-hop reference such as `order_id__location__location_name` is actually
 * queryable for `revenue`. This path is deliberately exact: the reference and
 * entity trail must both be returned by the adapter for the selected metric
 * tuple. Otherwise the semantic plan must remain pre-freeze ineligible.
 */
function exactNativeGroupingDefinitions(input: {
  layer: SemanticLayer;
  metricNames: string[];
  reference: string;
  entityPath: string[];
}): Array<NonNullable<ReturnType<SemanticLayer['resolveGroupBy']>>> {
  const metricNames = [...new Set(input.metricNames.map((name) => name.trim()).filter(Boolean))];
  if (metricNames.length === 0) return [];
  try {
    return uniqueDefinitions(input.layer.explainCompatibleDimensions(metricNames).compatible
      .filter((dimension) =>
        dimension.qualifiedName === input.reference
        && sameNativeEntityPath(dimension.entityPath, input.entityPath)));
  } catch {
    // A compiler/readiness exception is not permission to fall back to a
    // similarly named leaf. The caller returns a typed semantic member miss,
    // allowing the pre-freeze cascade to consider only a separately proven
    // relational/exploratory path.
    return [];
  }
}

function sameNativeEntityPath(actual: string[] | undefined, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((segment, index) => segment === expected[index]);
}

function semanticMetricNames(node: KGNode, layer: SemanticLayer): string[] {
  const exactIdentities = new Set(semanticRuntimeReferencesForKGNode(node));
  return [...new Set(layer.listMetrics().filter((metric) =>
    exactIdentities.has(metric.name)
    || exactIdentities.has(`${metric.cube ?? ''}.${metric.name}`)
    || (metric.source?.objectId ? exactIdentities.has(metric.source.objectId) : false)
  ).map((metric) => metric.name))].sort();
}

function nodeIdForMetadataObject(object: MetadataObject): string | undefined {
  if (object.objectType === 'dql_block') return `block:${object.name}`;
  if (object.objectType === 'semantic_metric') return `metric:${object.name}`;
  if (object.objectType === 'semantic_dimension' || object.objectType === 'semantic_time_dimension') return `dimension:${object.name}`;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function scalarFilterValue(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (typeof value === 'boolean' || typeof value === 'bigint') return [String(value)];
  return [];
}

function uniqueDefinitions<T extends { name: string; cube?: string; table?: string }>(values: Array<T | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    if (value) byId.set(`${value.cube ?? ''}:${value.table ?? ''}:${value.name}`, value);
  }
  return [...byId.values()];
}

function isTimeDimension(value: ReturnType<SemanticLayer['resolveGroupBy']>): boolean {
  return Boolean(value && (value.isTimeDimension || value.source?.objectType === 'time_dimension'));
}
