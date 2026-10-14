/**
 * Constrained relational compiler. It accepts only qualified registry IDs and
 * certified relationship proof; the model never writes relations, joins,
 * columns, aliases, parameters, or SQL text.
 *
 * Acceptance: AGT-015, API-006.
 */

import { createHash } from 'node:crypto';
import { getDialect, type DQLManifest, type DqlArtifactReference } from '@zlens/core';
import type {
  AnalyticalExecutionGraphV1,
  AnalyticalGraphSourceInvocationNode,
} from './analytical-execution-graph.js';
import type { ResolvedAnalyticalPlan, ResolvedPlanMemberBinding } from './resolved-analytical-plan.js';
import {
  governedRelationshipSafetyProofIsSelfConsistentV1,
  type GovernedRelationshipSafetyProofV1,
} from './relationship-proof.js';

export interface GovernedRelationColumn {
  qualifiedId: string;
  name: string;
  type?: string;
  description?: string;
  isTime?: boolean;
  identities: string[];
}

export interface GovernedRelation {
  qualifiedId: string;
  sqlName: string;
  entityId?: string;
  identities: string[];
  columns: GovernedRelationColumn[];
}

export interface GovernedRelationship {
  qualifiedId: string;
  fromRelationId: string;
  toRelationId: string;
  /** Exact modeling entities, retained so frozen safety evidence can reject a restamped registry. */
  fromEntityId?: string;
  toEntityId?: string;
  keys: Array<{ fromColumnId: string; toColumnId: string }>;
  joinType: 'inner' | 'left';
  cardinality: string;
  fanout: string;
  status: string;
  automaticJoinAllowed: boolean;
  staleCertification: boolean;
  certificationFingerprint?: string;
  evidenceExpiresAt?: string;
  validation?: {
    status: string;
    checkedAt: string;
    queryFingerprint: string;
    proofFingerprint?: string;
  };
  identities: string[];
}

export interface GovernedRelationalRegistry {
  snapshotId: string;
  fingerprint: string;
  relations: GovernedRelation[];
  relationships: GovernedRelationship[];
}

export type RelationalAggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';

export interface GovernedRelationalAst {
  kind: 'select';
  fromRelationId: string;
  joins: Array<{ relationshipId: string; relationId: string; joinType: 'inner' | 'left' }>;
  measures: Array<{ columnId: string; aggregate: RelationalAggregate; alias: string }>;
  dimensions: Array<{ columnId: string; alias: string; timeGrain?: string }>;
  filters: Array<{ columnId: string; operator: 'eq' | 'gte' | 'lt'; parameterName: string }>;
  orderBy: Array<{ alias: string; direction: 'asc' | 'desc' }>;
  limit: number;
}

export interface GovernedCompilationReceipt {
  schemaVersion: 1;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  registryFingerprint: string;
  astFingerprint: string;
  sqlFingerprint: string;
  relationIds: string[];
  columnIds: string[];
  relationshipIds: string[];
  parameters: Array<{ name: string; valueFingerprint: string }>;
  outputColumns: string[];
  result?: { rowCount: number; resultFingerprint: string };
}

export type GovernedRelationalCompileResult =
  | {
      status: 'compiled';
      ast: GovernedRelationalAst;
      sql: string;
      parameterValues: Record<string, unknown>;
      receipt: GovernedCompilationReceipt;
    }
  | {
      status: 'blocked';
      code:
        | 'CAPABILITY_MISMATCH'
        | 'SNAPSHOT_MISMATCH'
        | 'MEMBER_UNRESOLVED'
        | 'MEMBER_AMBIGUOUS'
        | 'AGGREGATION_REQUIRED'
        | 'RELATIONSHIP_PROOF_REQUIRED'
        | 'RELATIONSHIP_NOT_EXECUTABLE'
        | 'UNSUPPORTED_TIME_RANGE';
      reason: string;
      candidateIds?: string[];
    };

export interface GovernedAnalyticalGraphCompilationReceipt {
  schemaVersion: 1;
  graphId: string;
  graphFingerprint: string;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  registryFingerprint: string;
  statementFingerprints: Array<{
    nodeId: string;
    astFingerprint: string;
    sqlFingerprint: string;
  }>;
  fingerprint: string;
}

export type GovernedAnalyticalGraphCompileResult =
  | {
      status: 'compiled';
      graph: AnalyticalExecutionGraphV1;
      statements: Array<{
        nodeId: string;
        sql: string;
        parameterValues: Record<string, unknown>;
        ast: GovernedRelationalAst;
        receipt: GovernedCompilationReceipt;
        outputAliases: AnalyticalGraphSourceInvocationNode['outputAliases'];
      }>;
      receipt: GovernedAnalyticalGraphCompilationReceipt;
    }
  | {
      status: 'blocked';
      code:
        | 'EXECUTION_GRAPH_MISMATCH'
        | 'EXECUTION_GRAPH_ROUTE_MISMATCH'
        | 'SNAPSHOT_MISMATCH'
        | 'MEASURE_BINDING_REQUIRED'
        | 'MULTI_VALUE_FILTER_UNSUPPORTED'
        | Extract<GovernedRelationalCompileResult, { status: 'blocked' }>['code'];
      reason: string;
      nodeId?: string;
      candidateIds?: string[];
    };

export function buildGovernedRelationalRegistry(input: {
  snapshotId: string;
  schemaContext: Array<{
    relation: string;
    name?: string;
    columns: Array<{ name: string; type?: string; description?: string }>;
  }>;
  manifest?: DQLManifest;
}): GovernedRelationalRegistry {
  const provenance = Object.values(input.manifest?.dbtProvenance?.nodes ?? {});
  const entities = Object.values(input.manifest?.modeling?.entities ?? {});
  const relations = input.schemaContext.map((table): GovernedRelation => {
    const dbt = provenance.find((node) => node.relation === table.relation || node.name === table.name || node.name === table.relation);
    const entity = dbt ? entities.find((candidate) => candidate.dbtUniqueId === dbt.uniqueId) : undefined;
    const qualifiedId = dbt?.uniqueId ?? `runtime:relation:${table.relation}`;
    return {
      qualifiedId,
      sqlName: table.relation,
      entityId: entity?.qualifiedId ?? entity?.id,
      identities: unique([qualifiedId, table.relation, table.name, dbt?.name, dbt ? `dbt:model:${dbt.name}` : undefined]),
      columns: table.columns.map((column) => ({
        qualifiedId: `dbt:column:${dbt?.name ?? table.name ?? table.relation}.${column.name}`,
        name: column.name,
        type: column.type,
        description: column.description,
        isTime: /(?:date|time|timestamp)/i.test(column.type ?? '') || /(?:^|_)(date|time|timestamp|month|week|year)(?:_|$)/i.test(column.name),
        identities: unique([
          `dbt:column:${dbt?.name ?? table.name ?? table.relation}.${column.name}`,
          `runtime:column:${table.relation}.${column.name}`,
          `warehouse:column:${table.relation}.${column.name}`,
          `${qualifiedId}::column::${column.name}`,
          `${table.relation}.${column.name}`,
        ]),
      })),
    };
  });
  const byEntity = new Map(relations.flatMap((relation) => relation.entityId ? [[relation.entityId, relation] as const] : []));
  const relationships = Object.values(input.manifest?.modeling?.relationships ?? {}).flatMap((relationship): GovernedRelationship[] => {
    const from = byEntity.get(relationship.from);
    const to = byEntity.get(relationship.to);
    if (!from || !to) return [];
    const keys = relationship.keys.flatMap((key) => {
      const fromColumn = findColumnByName(from, key.from);
      const toColumn = findColumnByName(to, key.to);
      return fromColumn && toColumn ? [{ fromColumnId: fromColumn.qualifiedId, toColumnId: toColumn.qualifiedId }] : [];
    });
    if (keys.length !== relationship.keys.length) return [];
    return [{
      qualifiedId: relationship.qualifiedId,
      fromRelationId: from.qualifiedId,
      toRelationId: to.qualifiedId,
      fromEntityId: relationship.from,
      toEntityId: relationship.to,
      keys,
      joinType: relationship.joinTypes?.includes('left') ? 'left' : 'inner',
      cardinality: relationship.cardinality,
      fanout: relationship.fanout,
      status: relationship.status,
      automaticJoinAllowed: relationship.automaticJoinAllowed,
      staleCertification: relationship.staleCertification,
      ...(relationship.certificationFingerprint
        ? { certificationFingerprint: relationship.certificationFingerprint }
        : {}),
      ...(relationship.evidenceExpiresAt ? { evidenceExpiresAt: relationship.evidenceExpiresAt } : {}),
      ...(relationship.validation
        ? {
            validation: {
              status: relationship.validation.status,
              checkedAt: relationship.validation.checkedAt,
              queryFingerprint: relationship.validation.queryFingerprint,
              ...(relationship.validation.proofFingerprint
                ? { proofFingerprint: relationship.validation.proofFingerprint }
                : {}),
            },
          }
        : {}),
      identities: unique([relationship.qualifiedId, relationship.id, relationship.localId]),
    }];
  });
  const payload = { snapshotId: input.snapshotId, relations, relationships };
  return { ...payload, fingerprint: hash(stableStringify(payload)) };
}

/**
 * A registry is mutable project state while a governed plan is immutable. A
 * matching snapshot ID is therefore necessary but not sufficient: the exact
 * certified safety facts selected at freeze time must still match the registry
 * edge about to produce SQL. This prevents a caller from restamping a changed
 * registry snapshot or relaxing an unsafe fanout after the router froze.
 */
function governedRelationshipSafetyForFrozenPlan(
  plan: ResolvedAnalyticalPlan,
  relationship: GovernedRelationship,
): GovernedRelationshipSafetyProofV1 | undefined {
  const registryIdentities = new Set([
    relationship.qualifiedId,
    ...relationship.identities,
  ].map(normalizeAuthorityIdentity).filter(Boolean));
  const pathIds = new Set(plan.relationshipPathIds.map(normalizeAuthorityIdentity).filter(Boolean));
  const matches = (plan.governedRelationshipSafetyProofs ?? []).filter((proof) =>
    registryIdentities.has(normalizeAuthorityIdentity(proof.relationshipId))
    && pathIds.has(normalizeAuthorityIdentity(proof.relationshipPathId))
    && governedRelationshipSafetyProofIsSelfConsistentV1(proof));
  return matches.length === 1 ? matches[0] : undefined;
}

function governedRelationshipMatchesFrozenSafety(
  relationship: GovernedRelationship,
  proof: GovernedRelationshipSafetyProofV1,
  snapshotId: string,
  now: Date,
): boolean {
  const validation = relationship.validation;
  // The proof is immutable, but certification evidence can expire after the
  // router froze the plan and before the compiler emits SQL. Equality with a
  // registry value only proves that both copies are stale in the same way; it
  // is not current execution authority. Expiry is exclusive: at the exact
  // recorded instant the proof is no longer safe to use.
  const evidenceExpiresAt = proof.evidenceExpiresAt === undefined
    ? undefined
    : Date.parse(proof.evidenceExpiresAt);
  return proof.snapshotId === snapshotId
    && relationship.status === proof.status
    && relationship.staleCertification === proof.staleCertification
    && relationship.automaticJoinAllowed === proof.automaticJoinAllowed
    && relationship.fanout === proof.fanout
    && relationship.cardinality === proof.cardinality
    && relationship.certificationFingerprint === proof.certificationFingerprint
    && relationship.evidenceExpiresAt === proof.evidenceExpiresAt
    && normalizeAuthorityIdentity(relationship.fromEntityId ?? '') === normalizeAuthorityIdentity(proof.from)
    && normalizeAuthorityIdentity(relationship.toEntityId ?? '') === normalizeAuthorityIdentity(proof.to)
    && validation?.status === proof.validation.status
    && validation.checkedAt === proof.validation.checkedAt
    && validation.queryFingerprint === proof.validation.queryFingerprint
    && validation.proofFingerprint === proof.validation.proofFingerprint
    && relationshipKeysMatchFrozenSafety(relationship.keys, proof.keys)
    && (evidenceExpiresAt === undefined
      || Number.isFinite(evidenceExpiresAt) && evidenceExpiresAt > now.getTime());
}

function relationshipKeysMatchFrozenSafety(
  registryKeys: readonly { fromColumnId: string; toColumnId: string }[],
  proofKeys: readonly { from: string; to: string }[],
): boolean {
  if (registryKeys.length !== proofKeys.length || registryKeys.length === 0) return false;
  const normalize = (value: string) => value
    .replace(/["`]/g, '')
    .split(/[.:/]/)
    .at(-1)!
    .trim()
    .toLowerCase();
  const registry = registryKeys
    .map((key) => `${normalize(key.fromColumnId)}:${normalize(key.toColumnId)}`)
    .sort();
  const frozen = proofKeys
    .map((key) => `${normalize(key.from)}:${normalize(key.to)}`)
    .sort();
  return registry.every((key, index) => key === frozen[index]);
}

function normalizeAuthorityIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function compileGovernedRelationalPlan(input: {
  plan: ResolvedAnalyticalPlan;
  registry: GovernedRelationalRegistry;
  driver?: string;
  maxRows?: number;
  /** Injectable execution clock so relationship-proof expiry is deterministic. */
  now?: () => Date;
}): GovernedRelationalCompileResult {
  const { plan, registry } = input;
  // Capture time once per compilation. A proof cannot become valid again in
  // the middle of a plan, and this defines expiry-boundary behavior for every
  // relationship used by the emitted SQL.
  const compilationNow = input.now?.() ?? new Date();
  if (plan.capability !== 'governed_relational') {
    return blocked('CAPABILITY_MISMATCH', `Plan capability ${plan.capability} is not governed relational.`);
  }
  if (plan.snapshotId !== registry.snapshotId) {
    return blocked('SNAPSHOT_MISMATCH', `Plan snapshot ${plan.snapshotId} does not match relational registry ${registry.snapshotId}.`);
  }
  const measures = plan.query.measures.map((binding) => bindColumn(binding, registry));
  const dimensions = plan.query.dimensions.map((binding) => bindColumn(binding, registry));
  const filterColumns = plan.query.filters.map((filter) => bindColumn(filter.binding, registry));
  const failed = [...measures, ...dimensions, ...filterColumns].find((binding) => binding.status !== 'resolved');
  if (failed) {
    return blocked(
      failed.status === 'ambiguous' ? 'MEMBER_AMBIGUOUS' : 'MEMBER_UNRESOLVED',
      failed.reason,
      failed.candidateIds,
    );
  }
  const boundMeasures = measures as ResolvedColumn[];
  const boundDimensions = dimensions as ResolvedColumn[];
  const boundFilters = filterColumns as ResolvedColumn[];
  const relationIds = unique([
    ...boundMeasures.map((item) => item.relation.qualifiedId),
    ...boundDimensions.map((item) => item.relation.qualifiedId),
    ...boundFilters.map((item) => item.relation.qualifiedId),
  ]);
  if (relationIds.length === 0) return blocked('MEMBER_UNRESOLVED', 'The plan does not bind any executable relational columns.');
  const base = boundMeasures[0]?.relation ?? boundDimensions[0]?.relation ?? boundFilters[0]!.relation;
  const joins: GovernedRelationalAst['joins'] = [];
  const joined = new Set([base.qualifiedId]);
  while (joined.size < relationIds.length) {
    const relationship = registry.relationships.find((candidate) =>
      plan.relationshipPathIds.some((identity) => candidate.identities.includes(identity))
      && ((joined.has(candidate.fromRelationId) && relationIds.includes(candidate.toRelationId) && !joined.has(candidate.toRelationId))
        || (joined.has(candidate.toRelationId) && relationIds.includes(candidate.fromRelationId) && !joined.has(candidate.fromRelationId))));
    if (!relationship) {
      return blocked('RELATIONSHIP_PROOF_REQUIRED', `No selected relationship proof connects ${[...joined].join(', ')} to ${relationIds.filter((id) => !joined.has(id)).join(', ')}.`);
    }
    const frozenSafety = governedRelationshipSafetyForFrozenPlan(plan, relationship);
    if (!frozenSafety || !governedRelationshipMatchesFrozenSafety(
      relationship,
      frozenSafety,
      plan.snapshotId,
      compilationNow,
    )) {
      return blocked('RELATIONSHIP_NOT_EXECUTABLE', `Relationship ${relationship.qualifiedId} no longer matches the frozen certified safety proof.`);
    }
    if (relationship.status !== 'certified'
      || relationship.staleCertification
      || !relationship.automaticJoinAllowed
      || relationship.fanout !== 'safe') {
      return blocked('RELATIONSHIP_NOT_EXECUTABLE', `Relationship ${relationship.qualifiedId} is not fresh, certified, and automatic-join safe.`);
    }
    const next = joined.has(relationship.fromRelationId) ? relationship.toRelationId : relationship.fromRelationId;
    joins.push({ relationshipId: relationship.qualifiedId, relationId: next, joinType: relationship.joinType });
    joined.add(next);
  }
  const astMeasures: GovernedRelationalAst['measures'] = [];
  for (let index = 0; index < boundMeasures.length; index += 1) {
    const aggregation = normalizeAggregate(plan.query.measures[index]!.aggregation);
    if (!aggregation) {
      return blocked('AGGREGATION_REQUIRED', `Measure ${plan.query.measures[index]!.requested} has no allowlisted aggregation.`);
    }
    astMeasures.push({
      columnId: boundMeasures[index]!.column.qualifiedId,
      aggregate: aggregation,
      alias: safeAlias(plan.query.measures[index]!.requested, `measure_${index + 1}`),
    });
  }
  const astDimensions = boundDimensions.map((binding, index) => ({
    columnId: binding.column.qualifiedId,
    alias: safeAlias(plan.query.dimensions[index]!.requested, `dimension_${index + 1}`),
    ...(binding.column.isTime && plan.query.timeGrain ? { timeGrain: plan.query.timeGrain } : {}),
  }));
  const parameters: Record<string, unknown> = {};
  const filters: GovernedRelationalAst['filters'] = plan.query.filters.map((filter, index) => {
    const parameterName = `p${index + 1}`;
    parameters[parameterName] = filter.value;
    return { columnId: boundFilters[index]!.column.qualifiedId, operator: 'eq' as const, parameterName };
  });
  if (plan.query.timeRange && !plan.query.timeBounds) {
    return blocked('UNSUPPORTED_TIME_RANGE', `Time range "${plan.query.timeRange}" has no typed bounds.`);
  }
  if (plan.query.timeBounds) {
    const frameTimeId = plan.analyticalFrame?.timeContext?.timeDimensionId;
    const exactFrameTime = frameTimeId ? bindQualifiedColumn(frameTimeId, registry) : undefined;
    const time = boundDimensions.find((binding) => binding.column.isTime)
      ?? (exactFrameTime?.status === 'resolved' && exactFrameTime.column.isTime ? exactFrameTime : undefined);
    if (!time) return blocked('MEMBER_UNRESOLVED', 'Typed time bounds require a qualified time dimension.');
    parameters.time_start = plan.query.timeBounds.startInclusive;
    parameters.time_end = plan.query.timeBounds.endExclusive;
    filters.push(
      { columnId: time.column.qualifiedId, operator: 'gte', parameterName: 'time_start' },
      { columnId: time.column.qualifiedId, operator: 'lt', parameterName: 'time_end' },
    );
  }
  const orderAlias = astMeasures[0]?.alias ?? astDimensions[0]?.alias;
  const ast: GovernedRelationalAst = {
    kind: 'select',
    fromRelationId: base.qualifiedId,
    joins,
    measures: astMeasures,
    dimensions: astDimensions,
    filters,
    orderBy: orderAlias && plan.query.order ? [{ alias: orderAlias, direction: plan.query.order }] : [],
    limit: Math.min(Math.max(1, plan.query.limit ?? 100), input.maxRows ?? 10_000),
  };
  const sql = renderGovernedRelationalAst(ast, registry, input.driver);
  const outputColumns = [...ast.dimensions.map((item) => item.alias), ...ast.measures.map((item) => item.alias)];
  const receipt: GovernedCompilationReceipt = {
    schemaVersion: 1,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    snapshotId: plan.snapshotId,
    registryFingerprint: registry.fingerprint,
    astFingerprint: hash(stableStringify(ast)),
    sqlFingerprint: hash(sql),
    relationIds,
    columnIds: unique([...ast.dimensions.map((item) => item.columnId), ...ast.measures.map((item) => item.columnId), ...ast.filters.map((item) => item.columnId)]),
    relationshipIds: ast.joins.map((item) => item.relationshipId),
    parameters: Object.entries(parameters).map(([name, value]) => ({ name, valueFingerprint: hash(stableStringify(value)) })),
    outputColumns,
  };
  return { status: 'compiled', ast, sql, parameterValues: parameters, receipt };
}

/**
 * Compile every governed-relational source node independently. Alignment,
 * arithmetic, and ranking remain typed graph operations and therefore happen
 * only after each period has been safely aggregated at the declared grain.
 *
 * Acceptance: AGT-015, AGT-018, AGT-019.
 */
export function compileGovernedRelationalExecutionGraph(input: {
  graph: AnalyticalExecutionGraphV1;
  plan: ResolvedAnalyticalPlan;
  registry: GovernedRelationalRegistry;
  driver?: string;
  maxRows?: number;
  /** Passed through to every source compilation as one immutable execution instant. */
  now?: () => Date;
}): GovernedAnalyticalGraphCompileResult {
  const { graph, plan, registry } = input;
  const compilationNow = input.now?.() ?? new Date();
  const graphBlocked = (
    code: Extract<GovernedAnalyticalGraphCompileResult, { status: 'blocked' }>['code'],
    reason: string,
    nodeId?: string,
    candidateIds?: string[],
  ): GovernedAnalyticalGraphCompileResult => ({
    status: 'blocked',
    code,
    reason,
    ...(nodeId ? { nodeId } : {}),
    ...(candidateIds?.length ? { candidateIds } : {}),
  });
  if (
    graph.planId !== plan.planId ||
    graph.planFingerprint !== plan.fingerprint ||
    graph.snapshotId !== plan.snapshotId
  ) {
    return graphBlocked('EXECUTION_GRAPH_MISMATCH', 'The executable graph does not bind the supplied immutable plan.');
  }
  if (graph.route !== 'governed_sql') {
    return graphBlocked('EXECUTION_GRAPH_ROUTE_MISMATCH', `Graph route ${graph.route} is not governed SQL.`);
  }
  if (graph.snapshotId !== registry.snapshotId) {
    return graphBlocked(
      'SNAPSHOT_MISMATCH',
      `Graph snapshot ${graph.snapshotId} does not match relational registry ${registry.snapshotId}.`,
    );
  }
  const measureBindings = plan.query.measures.filter(
    (binding) => binding.status === 'resolved' && binding.qualifiedId,
  );
  if (measureBindings.length !== 1) {
    return graphBlocked('MEASURE_BINDING_REQUIRED', 'The governed graph requires exactly one resolved physical measure binding.');
  }
  const measureBinding = measureBindings[0]!;
  const statements: Extract<GovernedAnalyticalGraphCompileResult, { status: 'compiled' }>['statements'] = [];
  const sources = graph.nodes.filter(
    (node): node is AnalyticalGraphSourceInvocationNode => node.kind === 'source_invocation',
  );
  for (const source of sources) {
    if (source.strategy !== 'period_aggregate' || !source.outputAliases.metric) {
      return graphBlocked('EXECUTION_GRAPH_ROUTE_MISMATCH', 'Governed SQL requires period-aggregate source nodes.', source.id);
    }
    if (source.memberFilters.some((filter) => filter.canonicalValues.length !== 1)) {
      return graphBlocked(
        'MULTI_VALUE_FILTER_UNSUPPORTED',
        'The current governed relational operator requires exactly one canonical value per filter.',
        source.id,
      );
    }
    const dimensions: ResolvedPlanMemberBinding[] = source.outputAliases.dimensions.map((dimension) => ({
      requested: dimension.outputId,
      qualifiedId: dimension.dimensionId,
      status: 'resolved',
      candidateIds: [dimension.dimensionId],
    }));
    const filters: ResolvedAnalyticalPlan['query']['filters'] = source.memberFilters.map((filter) => ({
      field: filter.dimensionId,
      value: String(filter.canonicalValues[0]),
      binding: {
        requested: filter.dimensionId,
        qualifiedId: filter.dimensionId,
        status: 'resolved',
        candidateIds: [filter.dimensionId],
      },
    }));
    const periodPlan: ResolvedAnalyticalPlan = {
      ...plan,
      capability: 'governed_relational',
      query: {
        measures: [{
          ...measureBinding,
          requested: source.outputAliases.metric.outputId,
        }],
        dimensions,
        filters,
        ...(source.period
          ? {
              timeBounds: {
                expression: source.period.id,
                startInclusive: source.period.startInclusive,
                endExclusive: source.period.endExclusive,
                timeZone: 'UTC' as const,
              },
            }
          : {}),
        limit: Math.min(Math.max(1, input.maxRows ?? 10_000), 100_000),
      },
      outputContract: {
        measures: [source.outputAliases.metric.outputId],
        dimensions: dimensions.map((dimension) => dimension.requested),
        fields: [
          ...source.outputAliases.dimensions.map((dimension) => dimension.outputId),
          source.outputAliases.metric.outputId,
        ],
        ...(source.period ? { periodIds: [source.period.id] } : {}),
      },
    };
    const compiled = compileGovernedRelationalPlan({
      plan: periodPlan,
      registry,
      driver: input.driver,
      maxRows: input.maxRows,
      now: () => compilationNow,
    });
    if (compiled.status === 'blocked') {
      return graphBlocked(compiled.code, compiled.reason, source.id, compiled.candidateIds);
    }
    statements.push({
      nodeId: source.id,
      sql: compiled.sql,
      parameterValues: compiled.parameterValues,
      ast: compiled.ast,
      receipt: compiled.receipt,
      outputAliases: structuredClone(source.outputAliases),
    });
  }
  const statementFingerprints = statements.map((statement) => ({
    nodeId: statement.nodeId,
    astFingerprint: statement.receipt.astFingerprint,
    sqlFingerprint: statement.receipt.sqlFingerprint,
  }));
  const receiptPayload = {
    schemaVersion: 1 as const,
    graphId: graph.graphId,
    graphFingerprint: graph.fingerprint,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    snapshotId: plan.snapshotId,
    registryFingerprint: registry.fingerprint,
    statementFingerprints,
  };
  return {
    status: 'compiled',
    graph,
    statements,
    receipt: {
      ...receiptPayload,
      fingerprint: hash(stableStringify(receiptPayload)),
    },
  };
}

export function renderGovernedRelationalAst(
  ast: GovernedRelationalAst,
  registry: GovernedRelationalRegistry,
  driver?: string,
): string {
  const dialect = getDialect(driver);
  const relations = new Map(registry.relations.map((relation) => [relation.qualifiedId, relation]));
  const aliases = new Map<string, string>([[ast.fromRelationId, 'r0']]);
  ast.joins.forEach((join, index) => aliases.set(join.relationId, `r${index + 1}`));
  const locateColumn = (columnId: string): { relation: GovernedRelation; column: GovernedRelationColumn } => {
    for (const relation of registry.relations) {
      const column = relation.columns.find((candidate) => candidate.qualifiedId === columnId);
      if (column) return { relation, column };
    }
    throw new Error(`Unknown governed column ${columnId}`);
  };
  const expression = (columnId: string): string => {
    const { relation, column } = locateColumn(columnId);
    return `${aliases.get(relation.qualifiedId)}.${renderPhysicalIdentifier(column.name, driver, dialect.quoteIdentifier.bind(dialect))}`;
  };
  const selections = [
    ...ast.dimensions.map((item) => {
      const raw = expression(item.columnId);
      return `${item.timeGrain ? dialect.dateTrunc(item.timeGrain, raw) : raw} AS ${dialect.quoteIdentifier(item.alias)}`;
    }),
    ...ast.measures.map((item) => {
      const raw = expression(item.columnId);
      const aggregate = item.aggregate === 'count_distinct' ? `COUNT(DISTINCT ${raw})` : `${item.aggregate.toUpperCase()}(${raw})`;
      return `${aggregate} AS ${dialect.quoteIdentifier(item.alias)}`;
    }),
  ];
  let sql = `SELECT\n  ${selections.join(',\n  ')}\nFROM ${renderPhysicalRelation(relations.get(ast.fromRelationId)!.sqlName, driver, dialect.quoteIdentifier.bind(dialect))} AS r0`;
  const joined = new Set([ast.fromRelationId]);
  for (const join of ast.joins) {
    const relationship = registry.relationships.find((candidate) => candidate.qualifiedId === join.relationshipId)!;
    const relation = relations.get(join.relationId)!;
    const conditions = relationship.keys.map((key) => `${expression(key.fromColumnId)} = ${expression(key.toColumnId)}`);
    sql += `\n${join.joinType.toUpperCase()} JOIN ${renderPhysicalRelation(relation.sqlName, driver, dialect.quoteIdentifier.bind(dialect))} AS ${aliases.get(relation.qualifiedId)} ON ${conditions.join(' AND ')}`;
    joined.add(relation.qualifiedId);
  }
  if (ast.filters.length) {
    const operators = { eq: '=', gte: '>=', lt: '<' } as const;
    sql += `\nWHERE ${ast.filters.map((filter) => `${expression(filter.columnId)} ${operators[filter.operator]} :${filter.parameterName}`).join(' AND ')}`;
  }
  if (ast.measures.length && ast.dimensions.length) {
    sql += `\nGROUP BY ${ast.dimensions.map((item) => item.timeGrain ? dialect.dateTrunc(item.timeGrain, expression(item.columnId)) : expression(item.columnId)).join(', ')}`;
  }
  if (ast.orderBy.length) sql += `\nORDER BY ${ast.orderBy.map((item) => `${dialect.quoteIdentifier(item.alias)} ${item.direction.toUpperCase()}`).join(', ')}`;
  if (dialect.limitAtEnd) sql += `\n${dialect.limitClause(ast.limit)}`;
  return sql;
}

export function finalizeGovernedCompilationReceipt(
  receipt: GovernedCompilationReceipt,
  result: { columns: unknown[]; rows: unknown[]; rowCount: number },
): GovernedCompilationReceipt {
  const actual = result.columns.map((column) => typeof column === 'string' ? column : String(column));
  const missing = receipt.outputColumns.filter((column) => !actual.includes(column));
  if (missing.length) throw new Error(`Result contract is missing: ${missing.join(', ')}.`);
  return {
    ...receipt,
    result: {
      rowCount: result.rowCount,
      resultFingerprint: hash(stableStringify({ columns: actual, rows: result.rows, rowCount: result.rowCount })),
    },
  };
}

export function renderGovernedRelationalDqlArtifact(
  compiled: Extract<GovernedRelationalCompileResult, { status: 'compiled' }>,
): DqlArtifactReference {
  const name = `resolved_plan_${compiled.receipt.planId.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(-40)}`;
  const declarations = Object.entries(compiled.parameterValues).map(([parameter, value]) => {
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    return `    ${parameter}: ${type}`;
  });
  const parameterizedSql = compiled.sql.replace(/:([a-zA-Z][a-zA-Z0-9_]*)\b/g, (_match, parameter: string) => `\${${parameter}}`);
  const source = [
    `block "${name}" {`,
    '  type = "custom"',
    '  status = "draft"',
    ...(declarations.length ? ['  params {', ...declarations, '  }'] : []),
    '  query = """',
    ...parameterizedSql.split('\n').map((line) => `    ${line}`),
    '  """',
    '}',
  ].join('\n');
  return {
    kind: 'sql_block',
    name,
    source,
    compiledSql: compiled.sql,
    parameterValues: compiled.parameterValues,
    persistence: 'transient',
    trustState: 'governed',
    limit: compiled.ast.limit,
  };
}

type ResolvedColumn = { status: 'resolved'; relation: GovernedRelation; column: GovernedRelationColumn };
type ColumnBinding = ResolvedColumn | { status: 'missing' | 'ambiguous'; reason: string; candidateIds: string[] };

function bindColumn(binding: ResolvedPlanMemberBinding, registry: GovernedRelationalRegistry): ColumnBinding {
  if (binding.status !== 'resolved' || !binding.qualifiedId) {
    return { status: binding.status === 'ambiguous' ? 'ambiguous' : 'missing', reason: `${binding.requested} is ${binding.status}.`, candidateIds: binding.candidateIds };
  }
  const matches = registry.relations.flatMap((relation) => relation.columns
    .filter((column) => column.qualifiedId === binding.qualifiedId || column.identities.includes(binding.qualifiedId!))
    .map((column) => ({ relation, column })));
  if (matches.length !== 1) {
    return { status: matches.length > 1 ? 'ambiguous' : 'missing', reason: `${binding.qualifiedId} resolves to ${matches.length} columns.`, candidateIds: matches.map((item) => item.column.qualifiedId) };
  }
  return { status: 'resolved', ...matches[0]! };
}

function bindQualifiedColumn(qualifiedId: string, registry: GovernedRelationalRegistry): ColumnBinding {
  return bindColumn(
    {
      requested: qualifiedId,
      qualifiedId,
      status: 'resolved',
      candidateIds: [qualifiedId],
    },
    registry,
  );
}

function normalizeAggregate(value: string | undefined): RelationalAggregate | undefined {
  const normalized = value?.toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'sum' || normalized === 'avg' || normalized === 'min' || normalized === 'max' || normalized === 'count' || normalized === 'count_distinct') return normalized;
  if (normalized === 'average') return 'avg';
  if (normalized === 'distinct_count') return 'count_distinct';
  return undefined;
}

function findColumnByName(relation: GovernedRelation, name: string): GovernedRelationColumn | undefined {
  return relation.columns.find((column) => column.name === name);
}

function blocked(code: Extract<GovernedRelationalCompileResult, { status: 'blocked' }>['code'], reason: string, candidateIds?: string[]): GovernedRelationalCompileResult {
  return { status: 'blocked', code, reason, ...(candidateIds?.length ? { candidateIds } : {}) };
}

function safeAlias(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function isExplicitlyQuotedIdentifier(value: string): boolean {
  return value.length >= 2 && (
    value.startsWith('"') && value.endsWith('"')
    || value.startsWith('`') && value.endsWith('`')
    || value.startsWith('[') && value.endsWith(']')
  );
}

function splitQualifiedRelation(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '`' | ']' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      current += char;
      if (char === quote) {
        // SQL doubles quote characters inside quoted identifiers.
        if (value[index + 1] === quote && quote !== ']') {
          current += value[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char;
      current += char;
      continue;
    }
    if (char === '.') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function renderPhysicalIdentifier(
  value: string,
  driver: string | undefined,
  quote: (value: string) => string,
): string {
  const trimmed = value.trim();
  if (isExplicitlyQuotedIdentifier(trimmed)) return trimmed;
  // dbt manifests commonly contain lowercase logical names for unquoted
  // Snowflake objects. Quoting those names changes their meaning because
  // Snowflake otherwise folds them to uppercase. Preserve normal unquoted
  // physical identifiers and quote only names that actually require it.
  if (
    driver?.toLowerCase() === 'snowflake'
    && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)
    && (trimmed === trimmed.toLowerCase() || trimmed === trimmed.toUpperCase())
  ) {
    return trimmed;
  }
  return quote(trimmed);
}

export function renderPhysicalRelation(
  value: string,
  driver: string | undefined,
  quote: (value: string) => string,
): string {
  return splitQualifiedRelation(value)
    .map((segment) => renderPhysicalIdentifier(segment, driver, quote))
    .join('.');
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
    .sort();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
