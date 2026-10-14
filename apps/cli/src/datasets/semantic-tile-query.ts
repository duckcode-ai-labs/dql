import {
  datasetMeasureField,
  datasetPhysicalField,
  datasetQueryRequiresAggregateComponentEvidence,
  tileQueryIsTopNIntent,
  tileQueryValidationRuns,
  validateTileQuery,
  type AnalyticalQuestionFrameV2,
  type DatasetDescriptor,
  type MetricCapabilityContract,
  type TileQuery,
  type TileQueryFilter,
  type TileQueryValidation,
} from '@zlens/core';
import {
  solveAnalyticalCompatibility,
  type AnalyticalCompatibilityResult,
} from '@zlens/agent';
import type { SemanticRuntimeQueryRequest } from '../semantic-runtime.js';

export class SemanticDatasetTileQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SemanticDatasetTileQueryError';
  }
}

export interface SemanticDatasetTilePlan {
  request: SemanticRuntimeQueryRequest;
  /**
   * Stable contract identities that authorised `request`. Provider member
   * references are separate because an adapter may need `orders.revenue`,
   * while the persisted App and receipt retain the immutable model/metric and
   * field identities that were approved.
   */
  governedRequest: {
    metrics: Array<{ metricId: string; measureId: string; semanticReference: string }>;
    dimensions: Array<{ fieldId: string; semanticReference: string; role: 'group_by' | 'time_axis' }>;
    filters: Array<{ fieldId: string; semanticReference: string; op: TileQueryFilter['op']; values: unknown[] }>;
    having: Array<{ metricId: string; measureId: string; semanticReference: string; op: TileQueryFilter['op']; values: unknown[] }>;
  };
  compatibility: Extract<AnalyticalCompatibilityResult, { status: 'ready' }>;
  appliedFilters: TileQueryFilter[];
  /** The Dataset-contract outcome this plan executed under (C8). */
  validation: Pick<TileQueryValidation, 'outcome' | 'adaptations'>;
}

/**
 * Build one explicit semantic runtime request from a model-scoped Dataset.
 * This is deliberately outside Ask: field selections are already explicit,
 * but every selected metric still passes the shared analytical compatibility
 * solver before the semantic runtime can compile it.
 */
export function planSemanticDatasetTileQuery(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  metricCapabilities: Readonly<Record<string, MetricCapabilityContract>>;
  parameters?: Record<string, unknown>;
  title?: string;
}): SemanticDatasetTilePlan {
  if (input.descriptor.kind !== 'semantic') {
    throw new SemanticDatasetTileQueryError('SEMANTIC_DATASET_REQUIRED', 'This field tile is not backed by a semantic Dataset.');
  }
  const validation = validateTileQuery(input.descriptor, input.query);
  if (!tileQueryValidationRuns(validation)) {
    throw new SemanticDatasetTileQueryError(
      validation.outcome === 'needs_review' ? 'SEMANTIC_DATASET_QUERY_REVIEW_REQUIRED' : 'SEMANTIC_DATASET_QUERY_REJECTED',
      validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ') || 'The semantic field selection is not covered by this Dataset contract.',
    );
  }
  if (datasetQueryRequiresAggregateComponentEvidence(input.descriptor, input.query)) {
    throw new SemanticDatasetTileQueryError(
      'SEMANTIC_DATASET_COMPONENT_EVIDENCE_REQUIRED',
      `Aggregate Dataset ${input.descriptor.label} needs current component evidence before this rollup can run.`,
    );
  }
  if (input.query.detail) {
    throw new SemanticDatasetTileQueryError('SEMANTIC_DETAIL_UNSUPPORTED', 'Semantic Datasets require an explicit approved detail contract before they can emit row detail.');
  }
  const selectedMeasures = input.query.measures.map((selection) => {
    const measure = datasetMeasureField(input.descriptor, selection.measure);
    if (!measure?.metricId) {
      throw new SemanticDatasetTileQueryError('SEMANTIC_MEASURE_DRIFT', `Selected measure ${selection.measure} no longer has an exact semantic metric identity.`);
    }
    const capability = input.metricCapabilities[measure.metricId];
    if (!capability || capability.metricId !== measure.metricId) {
      throw new SemanticDatasetTileQueryError('SEMANTIC_MEASURE_CAPABILITY_MISSING', `Selected measure ${measure.name} no longer has its approved metric capability.`);
    }
    if (capability.semanticModelId !== input.descriptor.contractRef.id) {
      throw new SemanticDatasetTileQueryError('SEMANTIC_MODEL_DRIFT', `Selected measure ${measure.name} no longer belongs to ${input.descriptor.contractRef.id}.`);
    }
    const semanticExecutions = capability.executionCapabilities.filter((candidate) => candidate.route === 'semantic');
    if (semanticExecutions.length === 0) {
      throw new SemanticDatasetTileQueryError('SEMANTIC_EXECUTION_UNAVAILABLE', `Selected measure ${measure.name} has no approved semantic execution route.`);
    }
    // This narrows an immutable capability to the source's semantic route; it
    // never adds a route or operation the metric did not declare.
    return { selection, measure, capability: { ...capability, executionCapabilities: semanticExecutions } };
  });
  const entityIds = Array.from(new Set(selectedMeasures.map((selection) => selection.capability.primaryEntityId)));
  if (entityIds.length !== 1) {
    throw new SemanticDatasetTileQueryError('SEMANTIC_MULTI_METRIC_INCOMPATIBLE', 'Selected semantic measures do not share one primary entity grain.');
  }
  const having = (input.query.having ?? []).map((filter) => {
    const selected = selectedMeasures.find(({ measure }) => (
      measure.name.toLowerCase() === filter.field.toLowerCase()
      || measure.qualifiedId.toLowerCase() === filter.field.toLowerCase()
    ));
    if (!selected) {
      throw new SemanticDatasetTileQueryError(
        'SEMANTIC_HAVING_FIELD_INVALID',
        `Having filter ${filter.field} must name one selected logical semantic measure.`,
      );
    }
    if (!isSemanticHavingOperator(filter.op)) {
      throw new SemanticDatasetTileQueryError(
        'SEMANTIC_HAVING_OPERATOR_UNSUPPORTED',
        `Semantic total filters do not support ${filter.op}. Use an exact numeric comparison instead.`,
      );
    }
    return {
      metric: semanticMeasureReference(selected.measure),
      operator: filter.op,
      values: (filter.values ?? []).map(semanticFilterValue),
      governed: {
        metricId: selected.capability.metricId,
        measureId: selected.measure.qualifiedId,
        semanticReference: semanticMeasureReference(selected.measure),
        op: filter.op,
        values: [...(filter.values ?? [])],
      },
    };
  });

  const selectedDimensions = input.query.dimensions.map((selection) => {
    const field = datasetPhysicalField(input.descriptor, selection.field);
    if (!field) throw new SemanticDatasetTileQueryError('SEMANTIC_FIELD_DRIFT', `Selected field ${selection.field} no longer resolves.`);
    return { selection, field };
  });
  const timeDimensions = selectedDimensions.filter((selection) => selection.selection.timeGrain);
  if (timeDimensions.length > 1) {
    throw new SemanticDatasetTileQueryError('SEMANTIC_TIME_AMBIGUOUS', 'Select one semantic time field per tile.');
  }
  const filters = input.query.filters ?? [];
  const memberBindings = filters.flatMap((filter) => {
    const field = datasetPhysicalField(input.descriptor, filter.field);
    if (!field) throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_FIELD_DRIFT', `Filter field ${filter.field} no longer resolves.`);
    if (field.role === 'time') return [];
    return [{
      dimensionId: field.qualifiedId,
      canonicalValues: [...(filter.values ?? [])],
      source: 'parameter' as const,
      confidence: 'exact' as const,
    }];
  });
  for (const filter of filters) {
    const field = datasetPhysicalField(input.descriptor, filter.field);
    if (field?.role !== 'time') continue;
    if (!selectedMeasures.every((selection) => selection.capability.timeDimensions.some((time) => time.dimensionId === field.qualifiedId))) {
      throw new SemanticDatasetTileQueryError('SEMANTIC_TIME_FILTER_UNSUPPORTED', `${field.name} is not an approved semantic time field for every selected measure.`);
    }
  }

  const limit = resolveSemanticTileLimit(input.query.limit, input.parameters);
  const ranking = semanticRanking(input.descriptor, input.query, selectedDimensions, selectedMeasures, limit);
  const dimensionBindings: AnalyticalQuestionFrameV2['dimensions'] = [];
  for (const { selection, field } of selectedDimensions) {
    dimensionBindings.push({
      dimensionId: field.qualifiedId,
      role: selection.timeGrain ? 'time_axis' : 'group_by',
    });
  }
  for (const binding of memberBindings) {
    dimensionBindings.push({ dimensionId: binding.dimensionId, role: 'filter' });
  }
  if (ranking) {
    dimensionBindings.push({ dimensionId: ranking.entityDimensionId, role: 'rank_entity' });
  }
  const selectedTimeDimension = timeDimensions[0];
  const frame: AnalyticalQuestionFrameV2 = {
    version: 2,
    interpretedQuestion: input.title?.trim() || input.descriptor.label,
    questionType: timeDimensions.length > 0 ? 'trend' : ranking ? 'ranking' : 'scalar',
    metricConceptIds: selectedMeasures.map((selection) => selection.capability.metricId),
    entityGrainIds: entityIds,
    dimensions: dimensionBindings,
    memberBindings,
    ...(selectedTimeDimension ? {
      timeContext: {
        timeDimensionId: selectedTimeDimension.field.qualifiedId,
        grain: selectedTimeDimension.selection.timeGrain,
        periods: [],
      },
    } : {}),
    ...(ranking ? { ranking } : {}),
    requestedOutputs: [
      ...selectedDimensions.map(({ field }) => ({ id: field.qualifiedId, kind: 'dimension' as const })),
      ...selectedMeasures.map(({ capability }) => ({ id: capability.metricId, kind: 'metric_value' as const, metricId: capability.metricId })),
      ...(ranking ? [{ id: `rank:${ranking.entityDimensionId}`, kind: 'rank' as const, metricId: ranking.byMetricId }] : []),
    ],
    ambiguity: [],
  };
  const compatibility = solveAnalyticalCompatibility({
    frame,
    candidates: selectedMeasures.map(({ capability }) => ({ candidateId: capability.metricId, capability })),
  });
  if (compatibility.status !== 'ready' || compatibility.route !== 'semantic') {
    const reasons = compatibility.status === 'ready'
      ? [`The selected Dataset source requires ${compatibility.route}, not semantic execution.`]
      : compatibility.failures.map((failure) => failure.message);
    throw new SemanticDatasetTileQueryError('SEMANTIC_COMPATIBILITY_REJECTED', reasons.join(' ') || 'The selected semantic field combination is not approved.');
  }
  const authoredOrderBy = input.query.orderBy?.map((order) => semanticOrderBy(input.descriptor, input.query, selectedDimensions, selectedMeasures, order.alias, order.direction));
  const stableTieOrderBy = tileQueryIsTopNIntent(input.query)
    ? semanticStableTieOrderBy(selectedDimensions, input.query.orderBy ?? [])
    : [];
  const request: SemanticRuntimeQueryRequest = {
    metrics: selectedMeasures.map(({ measure }) => semanticMeasureReference(measure)),
    dimensions: selectedDimensions.filter(({ selection }) => !selection.timeGrain).map(({ field }) => semanticFieldReference(field)),
    ...(filters.length ? { filters: filters.flatMap((filter) => semanticRuntimeFilters(input.descriptor, filter)) } : {}),
    ...(having.length ? { having: having.map(({ governed: _governed, ...filter }) => filter) } : {}),
    ...(timeDimensions[0] ? {
      timeDimension: { name: semanticFieldReference(timeDimensions[0].field), granularity: timeDimensions[0].selection.timeGrain! },
    } : {}),
    ...(authoredOrderBy?.length || stableTieOrderBy.length ? {
      orderBy: [...(authoredOrderBy ?? []), ...stableTieOrderBy],
    } : {}),
    ...(limit ? { limit } : {}),
  };
  return {
    request,
    validation: { outcome: validation.outcome, adaptations: validation.adaptations },
    governedRequest: {
      metrics: selectedMeasures.map(({ measure, capability }) => ({
        metricId: capability.metricId,
        measureId: measure.qualifiedId,
        semanticReference: semanticMeasureReference(measure),
      })),
      dimensions: selectedDimensions.map(({ selection, field }) => ({
        fieldId: field.qualifiedId,
        semanticReference: semanticFieldReference(field),
        role: selection.timeGrain ? 'time_axis' : 'group_by',
      })),
      filters: filters.map((filter) => {
        const field = datasetPhysicalField(input.descriptor, filter.field);
        // Core validation and the runtime lowering above have resolved this
        // field. Keep a defensive gate so a forged request cannot create
        // receipt evidence for an unbound field.
        if (!field) {
          throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_FIELD_DRIFT', `Filter field ${filter.field} no longer resolves.`);
        }
        return {
          fieldId: field.qualifiedId,
          semanticReference: semanticFieldReference(field),
          op: filter.op,
          values: [...(filter.values ?? [])],
        };
      }),
      having: having.map(({ governed }) => governed),
    },
    compatibility,
    appliedFilters: filters,
  };
}

function resolveSemanticTileLimit(limit: TileQuery['limit'], parameters: Record<string, unknown> | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const value = typeof limit === 'number' ? limit : parameters?.[limit.param];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new SemanticDatasetTileQueryError('SEMANTIC_LIMIT_INVALID', 'Tile limit must resolve to an integer from 1 through 10,000.');
  }
  return value;
}

function semanticRanking(
  descriptor: DatasetDescriptor,
  query: TileQuery,
  dimensions: Array<{ selection: TileQuery['dimensions'][number]; field: NonNullable<ReturnType<typeof datasetPhysicalField>> }>,
  measures: Array<{ selection: TileQuery['measures'][number]; measure: NonNullable<ReturnType<typeof datasetMeasureField>>; capability: MetricCapabilityContract }>,
  limit: number | undefined,
): AnalyticalQuestionFrameV2['ranking'] | undefined {
  // A cap or ordinary presentation sort is not a Top-N request. The semantic
  // frame gets ranking intent only for an entity grouping with a bounded,
  // measure-first output sort. This lets chronological trends, dimension-sorted
  // tables, and scalar safety limits use their normal semantic contracts.
  if (limit === undefined) return undefined;
  const entity = dimensions.find(({ field }) => field.role !== 'time')?.field;
  const order = query.orderBy?.[0];
  const orderedMeasure = order ? semanticMeasureForOutputAlias(measures, order.alias) : undefined;
  if (!entity || !orderedMeasure) return undefined;
  return {
    entityDimensionId: entity.qualifiedId,
    byMetricId: orderedMeasure.capability.metricId,
    direction: order?.direction ?? 'desc',
    limit: limit ?? 100,
    tiePolicy: 'stable_secondary_key',
  };
}

function semanticRuntimeFilters(descriptor: DatasetDescriptor, filter: TileQueryFilter): NonNullable<SemanticRuntimeQueryRequest['filters']> {
  const field = datasetPhysicalField(descriptor, filter.field);
  if (!field) throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_FIELD_DRIFT', `Filter field ${filter.field} no longer resolves.`);
  const semanticReference = semanticFieldReference(field);
  // Dashboard ranges remain one declared field filter, but semantic providers
  // accept their safe structured bounds individually. Keep the values bound to
  // the exact Dataset dimension; do not drop a date control because a provider
  // lacks a `between` shorthand.
  if (filter.op === 'between') {
    const values = filter.values ?? [];
    if (values.length !== 2) throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_VALUE_INVALID', 'Semantic Dataset range filters require exactly two values.');
    return [
      { dimension: semanticReference, operator: 'gte', values: [semanticFilterValue(values[0])] },
      { dimension: semanticReference, operator: 'lte', values: [semanticFilterValue(values[1])] },
    ];
  }
  const operator = filter.op === 'eq' ? 'equals' : filter.op === 'neq' ? 'not_equals' : filter.op;
  // MetricFlow does not accept contains or between through its safe structured
  // filter API. Refuse instead of allowing a provider to silently drop a
  // dashboard filter.
  if (operator === 'contains') {
    throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_OPERATOR_UNSUPPORTED', `Semantic Dataset filters do not support ${filter.op} in M1.`);
  }
  return [{ dimension: semanticReference, operator, values: (filter.values ?? []).map(semanticFilterValue) }];
}

function semanticFilterValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new SemanticDatasetTileQueryError('SEMANTIC_FILTER_VALUE_INVALID', 'Semantic Dataset filter values must be scalar strings, numbers, booleans, or dates.');
}

function isSemanticHavingOperator(
  operator: TileQueryFilter['op'],
): operator is NonNullable<SemanticRuntimeQueryRequest['having']>[number]['operator'] {
  return operator === 'eq'
    || operator === 'neq'
    || operator === 'in'
    || operator === 'not_in'
    || operator === 'gt'
    || operator === 'gte'
    || operator === 'lt'
    || operator === 'lte'
    || operator === 'between';
}

function semanticOrderBy(
  descriptor: DatasetDescriptor,
  query: TileQuery,
  dimensions: Array<{ selection: TileQuery['dimensions'][number]; field: NonNullable<ReturnType<typeof datasetPhysicalField>> }>,
  measures: Array<{ selection: TileQuery['measures'][number]; measure: NonNullable<ReturnType<typeof datasetMeasureField>>; capability: MetricCapabilityContract }>,
  alias: string,
  direction: 'asc' | 'desc',
): { name: string; direction: 'asc' | 'desc' } {
  const measure = semanticMeasureForOutputAlias(measures, alias);
  if (measure) return { name: semanticMeasureReference(measure.measure), direction };
  const normalizedAlias = alias.toLowerCase();
  const dimension = dimensions.find(({ selection, field }) => outputAliasForDimension(selection, field).toLowerCase() === normalizedAlias);
  if (dimension) return { name: semanticFieldReference(dimension.field), direction };
  // Core validation normally catches this before planning. Keep an explicit
  // fail-closed branch for callers constructed outside Dashboard parsing.
  throw new SemanticDatasetTileQueryError('SEMANTIC_ORDER_FIELD_INVALID', `Order field ${alias} is not selected by this semantic tile.`);
}

/**
 * Keep Top-N ties deterministic without turning ordinary table/trend order
 * into ranking. These exact adapter references come from the selected,
 * already-authorized fields; they are never derived from a display label.
 */
function semanticStableTieOrderBy(
  dimensions: Array<{ selection: TileQuery['dimensions'][number]; field: NonNullable<ReturnType<typeof datasetPhysicalField>> }>,
  authoredOrderBy: NonNullable<TileQuery['orderBy']>,
): Array<{ name: string; direction: 'asc' }> {
  const authoredAliases = new Set(authoredOrderBy.map((order) => order.alias.toLowerCase()));
  const seenReferences = new Set<string>();
  const stable: Array<{ name: string; direction: 'asc' }> = [];
  for (const { selection, field } of dimensions) {
    if (authoredAliases.has(outputAliasForDimension(selection, field).toLowerCase())) continue;
    const reference = semanticFieldReference(field);
    if (seenReferences.has(reference)) continue;
    seenReferences.add(reference);
    stable.push({ name: reference, direction: 'asc' });
  }
  return stable;
}

function semanticMeasureForOutputAlias(
  measures: Array<{ selection: TileQuery['measures'][number]; measure: NonNullable<ReturnType<typeof datasetMeasureField>>; capability: MetricCapabilityContract }>,
  alias: string,
): { selection: TileQuery['measures'][number]; measure: NonNullable<ReturnType<typeof datasetMeasureField>>; capability: MetricCapabilityContract } | undefined {
  const normalizedAlias = alias.toLowerCase();
  return measures.find(({ selection, measure }) => (selection.alias ?? measure.name).toLowerCase() === normalizedAlias);
}

function outputAliasForDimension(
  selection: TileQuery['dimensions'][number],
  field: NonNullable<ReturnType<typeof datasetPhysicalField>>,
): string {
  return selection.alias ?? (selection.timeGrain ? `${field.name}_${selection.timeGrain}` : field.name);
}

/**
 * A Dataset field's canonical qualifiedId is never SQL or a provider member
 * name. Semantic source discovery persists the exact member reference that
 * its immutable metric capability approved, and a stale descriptor without
 * that bridge must be refreshed instead of being guessed from a final path
 * segment or display name.
 */
function semanticFieldReference(field: NonNullable<ReturnType<typeof datasetPhysicalField>>): string {
  const reference = field.semanticReference?.trim();
  if (!reference) {
    throw new SemanticDatasetTileQueryError(
      'SEMANTIC_FIELD_REFERENCE_MISSING',
      `Selected semantic field ${field.name} has no approved provider reference. Refresh the Dataset source before running it.`,
    );
  }
  return reference;
}

function semanticMeasureReference(measure: NonNullable<ReturnType<typeof datasetMeasureField>>): string {
  const reference = measure.semanticReference?.trim();
  if (!reference) {
    throw new SemanticDatasetTileQueryError(
      'SEMANTIC_MEASURE_REFERENCE_MISSING',
      `Selected semantic measure ${measure.name} has no approved provider reference. Refresh the Dataset source before running it.`,
    );
  }
  return reference;
}
