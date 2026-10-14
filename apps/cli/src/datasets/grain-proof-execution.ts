import {
  datasetPhysicalField,
  datasetProofFingerprint,
  getDialect,
  type DatasetDescriptor,
} from '@zlens/core';
import type { ConnectionConfig, SQLParamSpec } from '@zlens/connectors';

/**
 * Runtime evidence complements the Git-owned declaration proof. It is made
 * from the complete live Dataset source for this execution, so a warehouse row
 * change cannot inherit a historical uniqueness assertion merely because the
 * DQL text and project snapshot are unchanged.
 */
export interface DatasetGrainRuntimeEvidence {
  version: 1;
  status: 'passed' | 'failed';
  sourceId: string;
  sourceRevision: string;
  declaredProofId?: string;
  sourceSqlFingerprint: string;
  parameterFingerprint: string;
  targetFingerprint: string;
  snapshotId: string;
  keyFields: string[];
  uniqueness: {
    rowCount: number;
    distinctKeyCount: number;
    nullKeyCount: number;
    duplicateKeyCount: number;
  };
  checkedAt: string;
}

export interface CompiledDatasetGrainProbe {
  sql: string;
  sqlParams: SQLParamSpec[];
  variables: Record<string, unknown>;
  sourceSqlFingerprint: string;
  parameterFingerprint: string;
  keyFields: string[];
}

export class DatasetGrainProbeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Compile one aggregate-only uniqueness probe over the source query itself.
 * Grouping is portable across DQL's supported target dialects and avoids lossy
 * concatenation of multi-column keys. The source SQL is never preview rows.
 */
export function compileDatasetGrainProbe(input: {
  descriptor: DatasetDescriptor;
  sourceSql: string;
  sourceSqlParams?: SQLParamSpec[];
  sourceVariables?: Record<string, unknown>;
  parameterValues?: Record<string, unknown>;
  driver: ConnectionConfig['driver'] | string;
}): CompiledDatasetGrainProbe {
  const sourceSql = input.sourceSql.trim().replace(/;\s*$/, '');
  if (!sourceSql) throw new DatasetGrainProbeError('DATASET_GRAIN_SOURCE_EMPTY', 'The Dataset source has no executable SQL for its grain check.');
  const dialect = getDialect(input.driver);
  const quote = (name: string) => dialect.quoteIdentifier(name);
  const keys = input.descriptor.grain.keyFields.map((key) => datasetPhysicalField(input.descriptor, key));
  if (keys.length === 0 || keys.some((field) => !field)) {
    throw new DatasetGrainProbeError('DATASET_GRAIN_KEY_UNRESOLVED', 'The Dataset grain key no longer resolves to approved physical fields.');
  }
  const keyFields = keys.map((field) => field!.name);
  const keyExpressions = keyFields.map((name) => `ds.${quote(name)}`);
  const keyColumns = keyExpressions.map((expression, index) => `${expression} AS ${quote(`__dql_grain_key_${index}`)}`);
  const nullPredicate = keyExpressions.map((expression) => `${expression} IS NULL`).join(' OR ');
  const sourceVariables = { ...(input.sourceVariables ?? {}), ...(input.parameterValues ?? {}) };
  const sourceSqlFingerprint = datasetProofFingerprint({
    sourceSql,
    sqlParams: (input.sourceSqlParams ?? []).map((parameter) => ({ name: parameter.name, position: parameter.position })),
  });
  const parameterFingerprint = datasetProofFingerprint(sourceVariables);
  const sql = [
    `WITH ds AS (${sourceSql}),`,
    'key_groups AS (',
    `  SELECT ${keyColumns.join(', ')}, COUNT(*) AS ${quote('__dql_grain_key_count')}`,
    '  FROM ds',
    `  GROUP BY ${keyExpressions.join(', ')}`,
    ')',
    'SELECT',
    `  (SELECT COUNT(*) FROM ds) AS ${quote('__dql_row_count')},`,
    `  (SELECT COUNT(*) FROM key_groups) AS ${quote('__dql_distinct_key_count')},`,
    `  (SELECT COUNT(*) FROM ds WHERE ${nullPredicate}) AS ${quote('__dql_null_key_count')},`,
    `  (SELECT COUNT(*) FROM key_groups WHERE ${quote('__dql_grain_key_count')} > 1) AS ${quote('__dql_duplicate_key_count')}`,
  ].join('\n');
  return {
    sql,
    sqlParams: [...(input.sourceSqlParams ?? [])],
    variables: sourceVariables,
    sourceSqlFingerprint,
    parameterFingerprint,
    keyFields,
  };
}

/** Turn the single aggregate probe row into durable, run-scoped evidence. */
export function assessDatasetGrainProbe(input: {
  probe: CompiledDatasetGrainProbe;
  result: { rows?: Array<Record<string, unknown>> };
  sourceId: string;
  sourceRevision: string;
  declaredProofId?: string;
  targetFingerprint: string;
  snapshotId: string;
  checkedAt?: string;
}): DatasetGrainRuntimeEvidence {
  const row = input.result.rows?.[0];
  if (!row) throw new DatasetGrainProbeError('DATASET_GRAIN_PROBE_EMPTY', 'The Dataset grain check returned no aggregate result.');
  const uniqueness = {
    rowCount: readProbeCount(row, '__dql_row_count'),
    distinctKeyCount: readProbeCount(row, '__dql_distinct_key_count'),
    nullKeyCount: readProbeCount(row, '__dql_null_key_count'),
    duplicateKeyCount: readProbeCount(row, '__dql_duplicate_key_count'),
  };
  const status = uniqueness.nullKeyCount === 0
    && uniqueness.duplicateKeyCount === 0
    && uniqueness.rowCount === uniqueness.distinctKeyCount
    ? 'passed'
    : 'failed';
  return {
    version: 1,
    status,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    ...(input.declaredProofId ? { declaredProofId: input.declaredProofId } : {}),
    sourceSqlFingerprint: input.probe.sourceSqlFingerprint,
    parameterFingerprint: input.probe.parameterFingerprint,
    targetFingerprint: input.targetFingerprint,
    snapshotId: input.snapshotId,
    keyFields: [...input.probe.keyFields],
    uniqueness,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

export function datasetGrainProbeFailureMessage(evidence: DatasetGrainRuntimeEvidence): string | undefined {
  if (evidence.status === 'passed') return undefined;
  const { rowCount, distinctKeyCount, nullKeyCount, duplicateKeyCount } = evidence.uniqueness;
  return `The current Dataset source does not satisfy its declared grain: ${rowCount} rows, ${distinctKeyCount} distinct keys, ${nullKeyCount} null-key rows, and ${duplicateKeyCount} duplicate key groups. Revalidate the source before running this tile.`;
}

function readProbeCount(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  const count = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DatasetGrainProbeError('DATASET_GRAIN_PROBE_INVALID', `The Dataset grain check returned an invalid ${key} value.`);
  }
  return count;
}
