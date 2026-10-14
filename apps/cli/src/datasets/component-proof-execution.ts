/**
 * Server-owned, run-scoped authority for rolling an aggregate Dataset up from
 * its native rows. This is deliberately separate from DatasetGrainProofV1:
 * unique output rows do not prove that a COUNT(DISTINCT raw key) belongs to
 * one and only one native source bucket.
 */

import {
  datasetAggregateComponentRequirements,
  datasetProofFingerprint,
  type AggregationSafetyProofV1,
  type DatasetAggregateComponentProofV1,
  type DatasetDescriptor,
  tileQueryMeasureScope,
  type TileQuery,
} from '@zlens/core';
import {
  DatasetAggregateComponentSourceError,
  type CompiledDatasetAggregateDistinctProbe,
  compileDatasetAggregateDistinctProbe,
  componentSourceForAlias,
  parseDatasetAggregateComponentSource,
  type ParsedDatasetAggregateSource,
  type ParsedDatasetAggregateSourceComponent,
} from '@zlens/core/datasets/component-proof.node';
import type { DuckDBConsistentReadScope, QueryResult, SQLParamSpec } from '@zlens/connectors';
import type { DatasetBlockProofMaterial } from '@zlens/agent';
import type { DatasetGrainRuntimeEvidence } from './grain-proof-execution.js';

export class DatasetAggregateComponentProofError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly proof?: DatasetAggregateComponentProofV1,
  ) {
    super(message);
    this.name = 'DatasetAggregateComponentProofError';
  }
}

export interface DatasetAggregateComponentPreparedExecution {
  result: { rows: Array<Record<string, unknown>> };
}

export interface DatasetAggregateComponentProofPreparation {
  componentProof: DatasetAggregateComponentProofV1;
  aggregationSafety: AggregationSafetyProofV1;
  source: ParsedDatasetAggregateSource;
}

export interface DatasetAggregateComponentProofInspection {
  source: ParsedDatasetAggregateSource;
  components: ParsedDatasetAggregateSourceComponent[];
  requiresDistinctScope: boolean;
}

/**
 * Material the dashboard runtime resolved itself before opening a scoped
 * DuckDB connection. Browser input never reaches this function.
 */
export interface PrepareDatasetAggregateComponentProofInput {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  /** Complete source SQL after the normal execution-preparation boundary. */
  sourceSql: string;
  sourceSqlParams?: SQLParamSpec[];
  sourceVariables?: Record<string, unknown>;
  sourceId: string;
  sourceRevision: string;
  contractFingerprint: string;
  targetFingerprint: string;
  proofMaterial: DatasetBlockProofMaterial;
  grainEvidence: DatasetGrainRuntimeEvidence;
  /** Required only for a data-dependent COUNT(DISTINCT) component. */
  scope?: DuckDBConsistentReadScope;
  /** Reuse the server's first structural parse before it chooses a scope. */
  inspection?: DatasetAggregateComponentProofInspection;
  driver: string;
  signal?: AbortSignal;
  /** Executes a probe through the host preparation boundary and the scope. */
  executeProbe?(input: {
    sql: string;
    subject: string;
    sqlParams: SQLParamSpec[];
    variables: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<DatasetAggregateComponentPreparedExecution>;
  /**
   * Optional run-owned dedupe owned by the dashboard runtime. It receives the
   * fully compiled, redacted probe identity and must execute it through the
   * already-pinned read scope. A repeated tile may reuse this result, but a
   * later dashboard run must supply a fresh callback.
   */
  checkDistinctComponent?(input: {
    probe: CompiledDatasetAggregateDistinctProbe;
    signal?: AbortSignal;
  }): Promise<{ overlapDetected: boolean }>;
}

/**
 * Produce ephemeral positive component authority within an already-open
 * same-target read scope. A returned proof never changes Dataset lifecycle,
 * trust, certification, or the persisted grain proof registry.
 */
export async function prepareDatasetAggregateComponentProof(
  input: PrepareDatasetAggregateComponentProofInput,
): Promise<DatasetAggregateComponentProofPreparation> {
  throwIfAborted(input.signal);
  if (input.grainEvidence.status !== 'passed') {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_GRAIN_REQUIRED',
      'Run the complete-source Dataset grain check successfully before validating aggregate components.',
    );
  }
  const inspection = input.inspection ?? inspectDatasetAggregateComponentProof({
    descriptor: input.descriptor,
    query: input.query,
    sourceSql: input.sourceSql,
    driver: input.driver,
  });
  const { source, components } = inspection;
  if (inspection.requiresDistinctScope && !input.scope) {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_SNAPSHOT_UNSUPPORTED',
      'This aggregate Dataset selection includes a COUNT(DISTINCT) component and requires a current scoped read on the active target.',
    );
  }
  if (inspection.requiresDistinctScope && input.scope) {
    await assertNativeDuckDbRelation(input.scope, source, input.signal);
  }

  const checkedDistinctComponents: string[] = [];
  let overlapDetected = false;
  for (const component of components) {
    if (component.sourceAggregate !== 'count_distinct') continue;
    throwIfAborted(input.signal);
    const probe = compileDatasetAggregateDistinctProbe({ source, component: component.alias });
    let overlap = false;
    try {
      if (input.checkDistinctComponent) {
        overlap = (await input.checkDistinctComponent({ probe, signal: input.signal })).overlapDetected;
      } else if (input.executeProbe) {
        const execution = await input.executeProbe({
          sql: probe.sql,
          subject: `App Dataset distinct-component check for ${component.alias}`,
          sqlParams: [...(input.sourceSqlParams ?? [])],
          variables: { ...(input.sourceVariables ?? {}) },
          signal: input.signal,
        });
        overlap = execution.result.rows.length > 0;
      } else {
        throw new DatasetAggregateComponentProofError(
          'DATASET_AGGREGATE_COMPONENT_SNAPSHOT_UNSUPPORTED',
          'This aggregate Dataset selection requires a scoped executor for COUNT(DISTINCT) component evidence.',
        );
      }
    } catch (error) {
      if (input.signal?.aborted) {
        throw new DatasetAggregateComponentProofError(
          'DATASET_AGGREGATE_COMPONENT_CANCELLED',
          'The aggregate component check was cancelled before it completed.',
        );
      }
      throw new DatasetAggregateComponentProofError(
        'DATASET_AGGREGATE_COMPONENT_PROBE_FAILED',
        `The aggregate component check for ${component.alias} could not complete on the current source target: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    checkedDistinctComponents.push(component.alias);
    if (overlap) overlapDetected = true;
  }

  const binding = {
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    contractFingerprint: input.contractFingerprint,
    sourceSqlFingerprint: source.sourceSqlFingerprint,
    parameterFingerprint: input.grainEvidence.parameterFingerprint,
    targetFingerprint: input.targetFingerprint,
    snapshotId: input.proofMaterial.scope.snapshotId,
    snapshotFingerprint: input.proofMaterial.scope.snapshotFingerprint,
    ...(input.scope ? {
      readScopeId: input.scope.id,
      readScopeContextFingerprint: input.scope.context.fingerprint,
    } : {}),
    groupingFingerprint: source.groupingFingerprint,
    timeBucketFingerprint: source.timeBucketFingerprint,
    timeGrain: input.descriptor.grain.timeGrain ?? '',
  };
  const proofComponents = components.map((component) => ({
    alias: component.alias,
    targetOperation: 'sum' as const,
    sourceAggregate: component.sourceAggregate,
    sourceExpressionFingerprint: component.sourceExpressionFingerprint,
    ...(component.countedKeyFingerprint ? { countedKeyFingerprint: component.countedKeyFingerprint } : {}),
  })).sort((left, right) => left.alias.localeCompare(right.alias));
  const probeFingerprint = datasetProofFingerprint({
    binding,
    components: proofComponents,
    checkedDistinctComponents: [...checkedDistinctComponents].sort(),
  });
  const status = overlapDetected ? 'unsafe_overlap' as const : 'passed' as const;
  const componentProof: DatasetAggregateComponentProofV1 = {
    version: 1,
    status,
    binding,
    components: proofComponents,
    evidence: {
      checkedAt: new Date().toISOString(),
      probeFingerprint,
      method: inspection.requiresDistinctScope ? 'distinct_membership_scope' : 'direct_sum_mapping',
      checkedDistinctComponents: [...checkedDistinctComponents].sort(),
      ...(overlapDetected ? { overlapDetected: true } : {}),
    },
    fingerprint: datasetProofFingerprint({ version: 1, status, binding, components: proofComponents, probeFingerprint }),
  };
  if (overlapDetected) {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_OVERLAP',
      'A COUNT(DISTINCT) component uses a raw key in more than one native source bucket. This Dataset cannot roll that component up until the source grain or component contract is reviewed.',
      componentProof,
    );
  }

  return {
    componentProof,
    aggregationSafety: datasetAggregationSafetyProof({
      descriptor: input.descriptor,
      query: input.query,
      source,
      componentProof,
    }),
    source,
  };
}

/**
 * Validate direct source-to-component mapping before choosing a warehouse
 * scope. SUM-only selections can use this structural evidence on any normal
 * connector; only COUNT(DISTINCT) requires the DuckDB scoped membership probe.
 */
export function inspectDatasetAggregateComponentProof(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  sourceSql: string;
  driver: string;
}): DatasetAggregateComponentProofInspection {
  const requirements = datasetAggregateComponentRequirements(input.descriptor, tileQueryMeasureScope(input.descriptor, input.query));
  if (!requirements.supported) {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_UNSUPPORTED',
      requirements.diagnostics.map((diagnostic) => diagnostic.message).join(' ') || 'This aggregate Dataset selection has no complete approved component definition.',
    );
  }
  let source: ParsedDatasetAggregateSource;
  try {
    source = parseDatasetAggregateComponentSource({
      descriptor: input.descriptor,
      sourceSql: input.sourceSql,
      driver: input.driver,
    });
  } catch (error) {
    throw sourceShapeError(error);
  }
  const components = requirements.requirements.map((requirement) => {
    const component = componentSourceForAlias(source, requirement.component);
    if (!component) {
      throw new DatasetAggregateComponentProofError(
        'DATASET_AGGREGATE_COMPONENT_SOURCE_UNRESOLVED',
        `The approved Dataset component ${requirement.component} does not map to a direct aggregate output in the current source SQL.`,
      );
    }
    return component;
  });
  return {
    source,
    components,
    requiresDistinctScope: components.some((component) => component.sourceAggregate === 'count_distinct'),
  };
}

function datasetAggregationSafetyProof(input: {
  descriptor: DatasetDescriptor;
  query: TileQuery;
  source: ParsedDatasetAggregateSource;
  componentProof: DatasetAggregateComponentProofV1;
}): AggregationSafetyProofV1 {
  const metricIds = input.query.measures.map((selection) => selection.measure).sort();
  const nativeGrain = [...input.descriptor.grain.keyFields].sort();
  const requestedGrain = input.query.dimensions
    .map((dimension) => `${dimension.field}${dimension.timeGrain ? `:${dimension.timeGrain}` : ''}`)
    .sort();
  return {
    version: 1,
    status: 'safe',
    metricIds,
    metricProvenanceFingerprints: metricIds.map((metricId) => datasetProofFingerprint({
      contract: input.descriptor.contractRef.fingerprint,
      metricId,
    })),
    nativeGrain,
    requestedGrain,
    additivity: 'additive',
    joinCardinalities: [],
    fanout: 'proven_absent',
    rounding: 'none',
    issueCodes: [],
    correctionCodes: ['dataset_component_full_source_probe'],
    sqlFingerprint: input.source.sourceSqlFingerprint,
    planFingerprint: datasetProofFingerprint({
      query: input.query,
      components: input.componentProof.components.map((component) => component.alias),
    }),
    evidenceFingerprint: input.componentProof.fingerprint,
  };
}

async function assertNativeDuckDbRelation(
  scope: DuckDBConsistentReadScope,
  source: ParsedDatasetAggregateSource,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const schema = source.relation.schema ?? scope.context.schema;
  if (!schema) {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_SNAPSHOT_UNSUPPORTED',
      'The active DuckDB source schema could not be copied into the aggregate component read scope.',
    );
  }
  const tableResult = await scope.execute(
    'SELECT table_type FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [schema, source.relation.table],
    { signal },
  );
  const tableType = typeof tableResult.rows[0]?.table_type === 'string'
    ? tableResult.rows[0].table_type.toUpperCase()
    : '';
  if (tableType !== 'BASE TABLE') {
    throw new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_SOURCE_SHAPE_UNSUPPORTED',
      `Aggregate component evidence requires a native base table; ${schema}.${source.relation.table} is not an eligible base table in the active read scope.`,
    );
  }
  const columns = await scope.execute(
    'SELECT column_name, column_default FROM duckdb_columns() WHERE schema_name = ? AND table_name = ?',
    [schema, source.relation.table],
    { signal },
  );
  const byName = new Map(columns.rows.map((row) => [String(row.column_name ?? '').toLowerCase(), row]));
  for (const column of source.relation.referencedColumns) {
    const metadata = byName.get(column.toLowerCase());
    if (!metadata) {
      throw new DatasetAggregateComponentProofError(
        'DATASET_AGGREGATE_COMPONENT_SOURCE_COLUMN_UNRESOLVED',
        `Aggregate component evidence cannot resolve referenced source column ${column} on ${schema}.${source.relation.table}.`,
      );
    }
    // DuckDB exposes a generated virtual column through column_default. A
    // normal default can be stored, but this bounded proof cannot prove that
    // an arbitrary default/expression is materialized and deterministic, so
    // it refuses all non-null defaults rather than treating a numeric type as
    // physical storage authority.
    if (metadata.column_default !== null && metadata.column_default !== undefined && String(metadata.column_default).trim()) {
      throw new DatasetAggregateComponentProofError(
        'DATASET_AGGREGATE_COMPONENT_GENERATED_COLUMN_UNSUPPORTED',
        `Aggregate component evidence cannot use ${column} because its current DuckDB metadata exposes a generated or computed default expression.`,
      );
    }
  }
}

function sourceShapeError(error: unknown): DatasetAggregateComponentProofError {
  if (error instanceof DatasetAggregateComponentSourceError) {
    return new DatasetAggregateComponentProofError(
      'DATASET_AGGREGATE_COMPONENT_SOURCE_SHAPE_UNSUPPORTED',
      error.message,
    );
  }
  return new DatasetAggregateComponentProofError(
    'DATASET_AGGREGATE_COMPONENT_SOURCE_SHAPE_UNSUPPORTED',
    error instanceof Error ? error.message : String(error),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DatasetAggregateComponentProofError(
    'DATASET_AGGREGATE_COMPONENT_CANCELLED',
    signal.reason instanceof Error ? signal.reason.message : 'The aggregate component check was cancelled.',
  );
}
