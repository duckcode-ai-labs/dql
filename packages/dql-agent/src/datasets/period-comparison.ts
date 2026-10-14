/**
 * App Dataset period-comparison bridge.
 *
 * A TileQuery is authored against a Dataset descriptor, while the existing
 * analytical contracts express one metric across explicit resolved periods.
 * This module is the narrow, deterministic bridge between those two governed
 * shapes. It does not search for a metric, infer a time policy, or compile
 * SQL: callers still resolve the current Dataset catalog and execute each
 * returned period query through their normal target-bound route.
 */

import { createHash } from 'node:crypto';
import {
  datasetMeasureField,
  datasetPhysicalField,
  tileQueryHash,
  tileQueryOutputAliases,
  tileQueryValidationRuns,
  validateTileQuery,
  type AnalyticalQuestionFrameV2,
  type DatasetDescriptor,
  type MetricCapabilityContract,
  type TileQuery,
  type TileQueryComparison,
} from '@zlens/core';
import {
  buildAnalyticalExecutionGraph,
  executeAnalyticalExecutionGraph,
  type AnalyticalExecutionGraphV1,
  type AnalyticalGraphExecutionResult,
  type AnalyticalSourceResult,
} from '../analytical-execution-graph.js';
import { resolveAnalyticalPeriods } from '../analytical-period-resolution.js';
import { solveAnalyticalCompatibility } from '../analytical-compatibility.js';
import type { ResolvedAnalyticalPlan } from '../resolved-analytical-plan.js';

export type DatasetComparisonPlanResult =
  | {
      status: 'ready';
      /** Fully resolved, snapshot-bound analytical frame. */
      frame: AnalyticalQuestionFrameV2;
      capability: MetricCapabilityContract;
      plan: ResolvedAnalyticalPlan;
      graph: AnalyticalExecutionGraphV1;
      metric: {
        name: string;
        qualifiedId: string;
        format?: { kind: 'number' | 'currency' | 'percent'; currency?: string; decimals?: number };
      };
      /** One untruncated, comparison-free query for every resolved period. */
      periodQueries: Array<{
        periodId: string;
        outputAlias: string;
        query: TileQuery;
      }>;
      outputAliases: {
        dimensions: Array<{ field: string; alias: string }>;
        values: Array<{ periodId: string; alias: string }>;
        deltas: Array<{ periodId: string; alias: string }>;
        percentDeltas: Array<{ periodId: string; alias: string }>;
      };
    }
  | {
      status: 'blocked';
      code:
        | 'COMPARISON_REQUIRED'
        | 'COMPARISON_QUERY_UNSUPPORTED'
        | 'COMPARISON_CAPABILITY_UNSUPPORTED'
        | 'COMPARISON_PERIOD_BLOCKED'
        | 'COMPARISON_GRAPH_BLOCKED';
      reason: string;
    };

/**
 * Translate one approved field Dataset query into an immutable analytical
 * frame, resolve its periods, and build the route-neutral execution graph.
 *
 * The capability is a direct projection of this Descriptor's selected measure
 * and fields. It is not a substitute for a semantic metric capability: the
 * semantic runtime still validates the exact selected provider metric before
 * it executes the per-period requests.
 */
export function buildDatasetComparisonPlan(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  snapshotId: string;
  referenceInstant: string;
  maxRows?: number;
}): DatasetComparisonPlanResult {
  const comparison = input.query.comparison;
  if (!comparison) {
    return blocked('COMPARISON_REQUIRED', 'This Dataset query has no declared period comparison.');
  }
  const validation = validateTileQuery(input.descriptor, input.query);
  if (!tileQueryValidationRuns(validation)) {
    return blocked(
      'COMPARISON_QUERY_UNSUPPORTED',
      validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ') || 'This Dataset comparison is not covered by the current source contract.',
    );
  }
  if (input.query.measures.length !== 1) {
    return blocked('COMPARISON_QUERY_UNSUPPORTED', 'A Dataset period comparison currently requires exactly one selected measure so every value, delta, and change has one governed meaning.');
  }
  if (input.query.detail || input.query.orderBy?.length || input.query.limit !== undefined) {
    return blocked('COMPARISON_QUERY_UNSUPPORTED', 'A Dataset period comparison cannot combine bounded detail, ordering, or a row limit before its periods are aligned.');
  }
  if (input.query.dimensions.some((dimension) => sameField(dimension.field, comparison.timeField))) {
    return blocked('COMPARISON_QUERY_UNSUPPORTED', 'Use the comparison periods as the time scope; grouping by the comparison time field is not supported in this first bounded comparison view.');
  }

  const measureSelection = input.query.measures[0]!;
  const measure = datasetMeasureField(input.descriptor, measureSelection.measure);
  const timeField = datasetPhysicalField(input.descriptor, comparison.timeField);
  if (!measure || !timeField || timeField.role !== 'time') {
    return blocked('COMPARISON_QUERY_UNSUPPORTED', 'The selected comparison measure or time field no longer resolves to an approved Dataset field.');
  }

  const capability = datasetComparisonCapability({
    descriptor: input.descriptor,
    measure,
    comparison,
  });
  const frame = datasetComparisonFrame({
    descriptor: input.descriptor,
    query: input.query,
    comparison,
    capability,
  });
  const compatibility = solveAnalyticalCompatibility({
    frame,
    candidates: [{ candidateId: input.descriptor.id, capability }],
  });
  if (compatibility.status !== 'ready') {
    const failures = compatibility.status === 'clarify'
      ? compatibility.failures
      : compatibility.failures;
    return blocked(
      'COMPARISON_CAPABILITY_UNSUPPORTED',
      failures.map((failure) => failure.message).join(' ') || 'The selected Dataset capability cannot execute this comparison.',
    );
  }
  const resolved = resolveAnalyticalPeriods({
    frame: compatibility.frame,
    snapshotId: input.snapshotId,
    referenceInstant: input.referenceInstant,
  });
  if (resolved.status !== 'resolved') {
    return blocked('COMPARISON_PERIOD_BLOCKED', resolved.reason);
  }

  const outputAliases = comparisonOutputAliases({
    query: input.query,
    comparison,
    measureAlias: measureSelection.alias ?? measure.name,
  });
  const resolvedFrame: AnalyticalQuestionFrameV2 = {
    ...resolved.frame,
    requestedOutputs: [
      ...outputAliases.dimensions.map((dimension) => ({ id: dimension.alias, kind: 'dimension' as const })),
      ...outputAliases.values.map((value) => ({
        id: value.alias,
        kind: 'metric_value' as const,
        metricId: capability.metricId,
        periodId: value.periodId,
      })),
      ...outputAliases.deltas.map((delta) => ({
        id: delta.alias,
        kind: 'delta' as const,
        metricId: capability.metricId,
        periodId: delta.periodId,
      })),
      ...outputAliases.percentDeltas.map((delta) => ({
        id: delta.alias,
        kind: 'percent_delta' as const,
        metricId: capability.metricId,
        periodId: delta.periodId,
      })),
    ],
  };
  const plan = datasetComparisonResolvedPlan({
    descriptor: input.descriptor,
    query: input.query,
    frame: resolvedFrame,
    capability,
    snapshotId: input.snapshotId,
  });
  const graphResult = buildAnalyticalExecutionGraph({
    plan,
    capability,
    route: input.descriptor.kind === 'semantic' ? 'semantic' : 'governed_sql',
    ...(input.descriptor.kind === 'semantic' && input.descriptor.execution.adapterId
      ? { adapterId: input.descriptor.execution.adapterId }
      : {}),
    maxRows: input.maxRows,
  });
  if (graphResult.status !== 'ready') {
    return blocked('COMPARISON_GRAPH_BLOCKED', graphResult.reason);
  }

  let periodQueries: Array<{
    periodId: string;
    outputAlias: string;
    query: TileQuery;
  }>;
  try {
    periodQueries = resolvedFrame.timeContext!.periods.map((period) => {
      const output = outputAliases.values.find((candidate) => candidate.periodId === period.id)!;
      return {
        periodId: period.id,
        outputAlias: output.alias,
        query: comparisonPeriodQuery({
          query: input.query,
          comparison,
          period,
          measureAlias: output.alias,
          timeFieldType: timeField.type,
        }),
      };
    });
  } catch (error) {
    return blocked(
      'COMPARISON_PERIOD_BLOCKED',
      error instanceof Error ? error.message : 'The comparison period could not be represented for the selected Dataset time field.',
    );
  }
  return {
    status: 'ready',
    frame: resolvedFrame,
    capability,
    plan,
    graph: graphResult.graph,
    metric: {
      name: measure.name,
      qualifiedId: measure.qualifiedId,
      ...(measure.format ? { format: measure.format } : {}),
    },
    periodQueries,
    outputAliases,
  };
}

/** Execute only against results produced for the graph's exact source nodes. */
export function executeDatasetComparisonPlan(input: {
  plan: Extract<DatasetComparisonPlanResult, { status: 'ready' }>;
  sourceResults: Record<string, AnalyticalSourceResult>;
  percentScale?: number;
}): AnalyticalGraphExecutionResult {
  return executeAnalyticalExecutionGraph({
    graph: input.plan.graph,
    sourceResults: input.sourceResults,
    ...(input.percentScale !== undefined ? { percentScale: input.percentScale } : {}),
  });
}

function datasetComparisonCapability(input: {
  descriptor: DatasetDescriptor;
  measure: NonNullable<ReturnType<typeof datasetMeasureField>>;
  comparison: TileQueryComparison;
}): MetricCapabilityContract {
  const entityId = input.descriptor.grain.entityIds[0] ?? `dataset:${input.descriptor.id}:grain`;
  const timeField = datasetPhysicalField(input.descriptor, input.comparison.timeField);
  if (!timeField?.time) {
    throw new Error('Dataset comparison capability requires a resolved approved time field.');
  }
  const supportedRoles: MetricCapabilityContract['dimensions'][number]['supportedRoles'] = [
    'group_by',
    'filter',
    'display',
    'rank_entity',
  ];
  const dimensions = input.descriptor.fields
    .filter((field): field is NonNullable<ReturnType<typeof datasetPhysicalField>> => field.kind === 'physical' && field.role !== 'time')
    .map((field) => ({
      dimensionId: field.qualifiedId,
      entityId,
      supportedRoles: [...supportedRoles],
      label: field.name,
    }));
  const route = input.descriptor.kind === 'semantic' ? 'semantic' as const : 'governed_sql' as const;
  const operations = input.descriptor.operations.filter((operation): operation is 'filter' | 'group' | 'trend' | 'compare' | 'rank' | 'having' => operation !== 'detail');
  const payload: Omit<MetricCapabilityContract, 'sourceFingerprint'> = {
    metricId: input.measure.metricId ?? input.measure.qualifiedId,
    semanticModelId: input.descriptor.kind === 'semantic' ? input.descriptor.contractRef.id : undefined,
    measureIds: [input.measure.qualifiedId],
    primaryEntityId: entityId,
    defaultResultGrainId: entityId,
    resultGrainIds: [...input.descriptor.grain.entityIds],
    aggregation: input.measure.aggregation,
    additivity: {
      entities: input.measure.additivity.entities,
      time: input.measure.additivity.time,
      ...(input.measure.additivity.nonAdditiveDimensionIds?.length
        ? { nonAdditiveDimensionIds: [...input.measure.additivity.nonAdditiveDimensionIds] }
        : {}),
    },
    dimensions,
    timeDimensions: [{
      dimensionId: timeField.qualifiedId,
      role: input.comparison.timeRole,
      supportedGrains: [...timeField.time.grains],
      defaultFor: ['comparison'],
    }],
    operations,
    supportedOutputKinds: ['dimension', 'metric_value', 'delta', 'percent_delta'],
    executionCapabilities: [{
      route,
      ...(route === 'semantic' && input.descriptor.execution.adapterId ? { adapterId: input.descriptor.execution.adapterId } : {}),
    }],
  };
  return {
    ...payload,
    sourceFingerprint: `sha256:${hash({
      descriptor: input.descriptor.contractRef,
      sourceRevision: input.descriptor.sourceRevision,
      metric: input.measure.qualifiedId,
      time: input.comparison.timeField,
      payload,
    })}`,
  };
}

function datasetComparisonFrame(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  comparison: TileQueryComparison;
  capability: MetricCapabilityContract;
}): AnalyticalQuestionFrameV2 {
  const memberBindings = (input.query.filters ?? []).flatMap((filter) => {
    const field = datasetPhysicalField(input.descriptor, filter.field);
    if (!field || sameField(field.name, input.comparison.timeField)) return [];
    return [{
      dimensionId: field.qualifiedId,
      canonicalValues: [...(filter.values ?? [])],
      source: 'parameter' as const,
      confidence: 'exact' as const,
    }];
  });
  return {
    version: 2,
    interpretedQuestion: `Compare ${input.capability.metricId} across declared Dataset periods.`,
    questionType: 'comparison',
    metricConceptIds: [input.capability.metricId],
    entityGrainIds: [...input.descriptor.grain.entityIds],
    dimensions: input.query.dimensions.map((dimension) => {
      const field = datasetPhysicalField(input.descriptor, dimension.field)!;
      return { dimensionId: field.qualifiedId, role: 'group_by' as const };
    }),
    memberBindings,
    timeContext: {
      timeDimensionId: datasetPhysicalField(input.descriptor, input.comparison.timeField)!.qualifiedId,
      timeRole: input.comparison.timeRole,
      calendarId: input.comparison.calendarId,
      timezone: input.comparison.timezone,
      grain: input.comparison.grain,
      completenessPolicy: input.comparison.completenessPolicy,
      periods: input.comparison.periods.map((period) => ({ ...period })),
    },
    comparison: {
      basePeriodId: input.comparison.basePeriodId,
      comparisonPeriodIds: [...input.comparison.comparisonPeriodIds],
      alignment: input.comparison.alignment,
      outputs: [...input.comparison.outputs],
      zeroDenominatorPolicy: input.comparison.zeroDenominatorPolicy,
    },
    requestedOutputs: [],
    ambiguity: [],
  };
}

function comparisonOutputAliases(input: {
  query: TileQuery;
  comparison: TileQueryComparison;
  measureAlias: string;
}): Extract<DatasetComparisonPlanResult, { status: 'ready' }>['outputAliases'] {
  const dimensions = tileQueryOutputAliases(input.query)
    .filter((output) => output.kind === 'dimension')
    .map((output, index) => ({ field: input.query.dimensions[index]!.field, alias: output.alias }));
  const valueAlias = safeOutputIdentifier(input.measureAlias);
  const values = input.comparison.periods.map((period) => ({
    periodId: period.id,
    alias: `${valueAlias}__${safeOutputIdentifier(period.id)}`,
  }));
  const deltas = input.comparison.outputs.includes('absolute_delta')
    ? input.comparison.comparisonPeriodIds.map((periodId) => ({
      periodId,
      alias: `${valueAlias}__delta__${safeOutputIdentifier(periodId)}`,
    }))
    : [];
  const percentDeltas = input.comparison.outputs.includes('percent_delta')
    ? input.comparison.comparisonPeriodIds.map((periodId) => ({
      periodId,
      alias: `${valueAlias}__percent_delta__${safeOutputIdentifier(periodId)}`,
    }))
    : [];
  return { dimensions, values, deltas, percentDeltas };
}

function comparisonPeriodQuery(input: {
  query: TileQuery;
  comparison: TileQueryComparison;
  period: NonNullable<AnalyticalQuestionFrameV2['timeContext']>['periods'][number];
  measureAlias: string;
  timeFieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp';
}): TileQuery {
  if (!input.period.start || !input.period.end) {
    throw new Error(`Resolved period ${input.period.id} is missing execution bounds.`);
  }
  // DATE fields name civil days, not UTC instants. A local Auckland month can
  // start on the preceding UTC date; binding that instant and then casting it
  // back to DATE would silently include/exclude the wrong calendar rows. Keep
  // the exact instant for TIMESTAMP fields, but bind the declared local date
  // for DATE fields before the typed SQL compiler performs its DATE cast.
  const start = comparisonBoundaryForField(input.period.start, input.timeFieldType, input.comparison.timezone);
  const end = comparisonBoundaryForField(input.period.end, input.timeFieldType, input.comparison.timezone);
  return {
    ...input.query,
    measures: [{ ...input.query.measures[0]!, alias: input.measureAlias }],
    filters: [
      ...(input.query.filters ?? []),
      { field: input.comparison.timeField, op: 'gte', values: [start] },
      { field: input.comparison.timeField, op: 'lt', values: [end] },
    ],
    // Ranking/limits must happen after period alignment. The bridge blocks
    // them above rather than applying a period-local limit that would invent
    // missing comparison rows.
    orderBy: undefined,
    limit: undefined,
    comparison: undefined,
  };
}

function comparisonBoundaryForField(
  instant: string,
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'timestamp',
  timezone: string,
): string {
  if (fieldType !== 'date') return instant;
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Comparison boundary ${instant} is not a valid instant for a DATE Dataset field.`);
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
  } catch {
    throw new Error(`Comparison time zone ${timezone} cannot resolve a DATE Dataset boundary.`);
  }
  const part = (kind: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((candidate) => candidate.type === kind)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) {
    throw new Error(`Comparison time zone ${timezone} returned an incomplete DATE Dataset boundary.`);
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function datasetComparisonResolvedPlan(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  frame: AnalyticalQuestionFrameV2;
  capability: MetricCapabilityContract;
  snapshotId: string;
}): ResolvedAnalyticalPlan {
  const route = input.descriptor.kind === 'semantic' ? 'semantic' as const : 'governed_sql' as const;
  const fingerprint = hash({
    kind: 'app_dataset_period_comparison',
    descriptor: {
      id: input.descriptor.id,
      sourceRevision: input.descriptor.sourceRevision,
      contract: input.descriptor.contractRef,
    },
    query: tileQueryHash(input.query),
    frame: input.frame,
    capability: input.capability.sourceFingerprint,
    snapshotId: input.snapshotId,
  });
  return {
    schemaVersion: 2,
    mode: 'authoritative',
    planId: `app-dataset-comparison:${fingerprint.slice(0, 24)}`,
    fingerprint,
    revision: 0,
    snapshotId: input.snapshotId,
    sourceFingerprint: input.descriptor.sourceRevision,
    question: input.frame.interpretedQuestion,
    interpretedQuestion: input.frame.interpretedQuestion,
    questionType: 'comparison',
    confidence: 'high',
    selectedConceptIds: [input.capability.metricId],
    executionId: input.descriptor.id,
    selectedCapability: input.capability,
    selectedCapabilityFingerprint: input.capability.sourceFingerprint,
    recommendedRoute: route,
    capability: route === 'semantic' ? 'semantic_execution' : 'governed_relational',
    query: { measures: [], dimensions: [], filters: [] },
    entityGrain: input.capability.primaryEntityId,
    sourceRelationIds: [input.descriptor.id],
    relationshipPathIds: [],
    compatibilityProof: [
      {
        candidateId: input.descriptor.id,
        compatibility: 'compatible',
        facts: [
          `dataset:${input.descriptor.id}`,
          `sourceRevision:${input.descriptor.sourceRevision}`,
          `contract:${input.descriptor.contractRef.fingerprint}`,
          `query:${tileQueryHash(input.query)}`,
        ],
      },
    ],
    outputContract: {
      measures: [input.capability.metricId],
      dimensions: input.frame.dimensions.map((dimension) => dimension.dimensionId),
      fields: input.frame.requestedOutputs.map((output) => output.id),
      periodIds: input.frame.timeContext?.periods.map((period) => period.id),
    },
    evidenceIds: [input.descriptor.contractRef.fingerprint],
    rejectedCandidates: [],
    missingInformation: [],
    analyticalFrame: input.frame,
  };
}

function blocked(
  code: Extract<DatasetComparisonPlanResult, { status: 'blocked' }>['code'],
  reason: string,
): Extract<DatasetComparisonPlanResult, { status: 'blocked' }> {
  return { status: 'blocked', code, reason };
}

function sameField(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function safeOutputIdentifier(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]/g, '_');
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
