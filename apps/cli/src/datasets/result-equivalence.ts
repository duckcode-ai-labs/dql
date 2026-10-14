import { createHash } from 'node:crypto';

import type { ColumnMeta, QueryResult, Row } from '@zlens/connectors';
import type { EquivalenceProofV1 } from '@zlens/core';

export type DatasetEquivalenceFailureCode =
  | 'equivalence_identity_unavailable'
  | 'equivalence_read_scope_unavailable'
  | 'equivalence_execution_failed'
  | 'equivalence_result_incomplete'
  | 'equivalence_identity_drift'
  | 'equivalence_schema_mismatch'
  | 'equivalence_result_mismatch'
  | 'equivalence_lossy_decimal'
  | 'equivalence_lossy_integer'
  | 'equivalence_value_unsupported';

/** The authority both candidate executions must share, never a synthetic snapshot id. */
export interface DatasetEquivalenceReadScope {
  id: string;
  close(): Promise<void>;
}

/**
 * Identity fields that must be known and unchanged before and after both
 * candidate executions. Query fingerprints intentionally remain execution-
 * specific; two equivalent routes have different authored query identities.
 */
export interface DatasetEquivalenceIdentity {
  datasetId: string;
  sourceRevision: string;
  contractFingerprint: string;
  snapshotFingerprint: string;
  targetFingerprint: string;
  personaPolicyFingerprint: string;
  dialect: string;
  adapterFingerprint: string;
  compilerFingerprint: string;
  rowBoundFingerprint: string;
}

export interface DatasetEquivalenceExecution {
  result: QueryResult;
  receiptId: string;
  receiptFingerprint: string;
  /** A bounded response must carry every row it claims to compare. */
  complete: boolean;
  cancelled?: boolean;
}

export interface DatasetEquivalenceExecutionContext {
  readScope: DatasetEquivalenceReadScope;
  cacheMode: 'bypass';
  signal?: AbortSignal;
}

export interface DatasetEquivalenceInput {
  resolveIdentity(): Promise<DatasetEquivalenceIdentity | undefined>;
  openReadScope(): Promise<DatasetEquivalenceReadScope>;
  executeDataset(context: DatasetEquivalenceExecutionContext): Promise<DatasetEquivalenceExecution>;
  executeCandidate(context: DatasetEquivalenceExecutionContext): Promise<DatasetEquivalenceExecution>;
  ordering: 'ordered' | 'multiset';
  signal?: AbortSignal;
  now?: () => Date;
}

export type DatasetEquivalenceResult =
  | { ok: true; proof: EquivalenceProofV1 }
  | { ok: false; code: DatasetEquivalenceFailureCode; message: string };

class DatasetEquivalenceFailure extends Error {
  constructor(readonly code: DatasetEquivalenceFailureCode, message: string) {
    super(message);
    this.name = 'DatasetEquivalenceFailure';
  }
}

/**
 * Compare two guarded App execution paths. This service owns no SQL and does
 * not create a transaction: callers supply a real existing read scope that
 * each executor must use. Any unsupported, unknown, lossy, partial, or stale
 * condition is a refusal instead of a best-effort comparison.
 */
export async function proveDatasetResultEquivalence(input: DatasetEquivalenceInput): Promise<DatasetEquivalenceResult> {
  let scope: DatasetEquivalenceReadScope | undefined;
  try {
    throwIfAborted(input.signal);
    const before = await requiredIdentity(input.resolveIdentity);
    try {
      scope = await input.openReadScope();
    } catch (error) {
      return failure('equivalence_read_scope_unavailable', `ZLens could not open one shared read scope for equivalence: ${messageOf(error)}`);
    }
    throwIfAborted(input.signal);
    const context: DatasetEquivalenceExecutionContext = { readScope: scope, cacheMode: 'bypass', signal: input.signal };
    let dataset: DatasetEquivalenceExecution;
    let candidate: DatasetEquivalenceExecution;
    try {
      [dataset, candidate] = await Promise.all([
        input.executeDataset(context),
        input.executeCandidate(context),
      ]);
    } catch (error) {
      if (input.signal?.aborted) return failure('equivalence_execution_failed', 'The equivalence proof was cancelled before both candidates settled.');
      return failure('equivalence_execution_failed', `ZLens could not execute both candidates in the shared read scope: ${messageOf(error)}`);
    }
    throwIfAborted(input.signal);
    requireComplete(dataset, 'Dataset');
    requireComplete(candidate, 'candidate block or semantic tile');
    const after = await requiredIdentity(input.resolveIdentity);
    if (fingerprintIdentity(before) !== fingerprintIdentity(after)) {
      return failure('equivalence_identity_drift', 'The source, target, policy, or execution contract changed while ZLens was proving equivalence. Run a fresh preview.');
    }
    const comparison = compareResults(dataset.result, candidate.result, input.ordering);
    if (!comparison.equal) return failure(comparison.code, comparison.message);
    const now = (input.now ?? (() => new Date()))().toISOString();
    return {
      ok: true,
      proof: {
        version: 1,
        kind: 'dataset_equivalence_proof',
        datasetReceiptFingerprint: dataset.receiptFingerprint,
        candidateReceiptFingerprint: candidate.receiptFingerprint,
        schemaFingerprint: comparison.schemaFingerprint,
        resultFingerprint: comparison.resultFingerprint,
        executionIdentityFingerprint: fingerprintIdentity(after),
        ordering: input.ordering,
        rowCount: dataset.result.rowCount,
        provedAt: now,
      },
    };
  } catch (error) {
    if (error instanceof DatasetEquivalenceFailure) return failure(error.code, error.message);
    if (input.signal?.aborted) return failure('equivalence_execution_failed', 'The equivalence proof was cancelled.');
    return failure('equivalence_execution_failed', `ZLens could not prove equivalence: ${messageOf(error)}`);
  } finally {
    if (scope) {
      try {
        await scope.close();
      } catch {
        // The caller's scope is private and must clean itself up eventually.
        // A close failure cannot turn a failed proof into an accepted one.
      }
    }
  }
}

function requiredIdentity(resolveIdentity: DatasetEquivalenceInput['resolveIdentity']): Promise<DatasetEquivalenceIdentity> {
  return resolveIdentity().then((identity) => {
    if (!identity || Object.values(identity).some((value) => !value || !value.trim())) {
      throw new DatasetEquivalenceFailure('equivalence_identity_unavailable', 'ZLens cannot prove equivalence because the current source, target, policy, or compiler identity is unavailable.');
    }
    return identity;
  });
}

function requireComplete(execution: DatasetEquivalenceExecution, label: string): void {
  if (!execution.complete || execution.cancelled || execution.result.truncated || execution.result.rowCount !== execution.result.rows.length) {
    throw new DatasetEquivalenceFailure('equivalence_result_incomplete', `The ${label} result was incomplete, truncated, cancelled, or row-capped, so ZLens cannot prove exact equivalence.`);
  }
  if (!execution.receiptId.trim() || !execution.receiptFingerprint.trim()) {
    throw new DatasetEquivalenceFailure('equivalence_result_incomplete', `The ${label} result has no current execution receipt.`);
  }
}

type Comparison =
  | { equal: true; schemaFingerprint: string; resultFingerprint: string }
  | { equal: false; code: DatasetEquivalenceFailureCode; message: string };

function compareResults(left: QueryResult, right: QueryResult, ordering: 'ordered' | 'multiset'): Comparison {
  const leftSchema = canonicalSchema(left.columns);
  const rightSchema = canonicalSchema(right.columns);
  if (leftSchema !== rightSchema) {
    return { equal: false, code: 'equivalence_schema_mismatch', message: 'The Dataset and candidate outputs have different column names, order, or logical types.' };
  }
  let leftRows: string[];
  let rightRows: string[];
  try {
    leftRows = left.rows.map((row) => canonicalRow(row, left.columns));
    rightRows = right.rows.map((row) => canonicalRow(row, right.columns));
  } catch (error) {
    if (error instanceof DatasetEquivalenceFailure) return { equal: false, code: error.code, message: error.message };
    return { equal: false, code: 'equivalence_value_unsupported', message: `ZLens cannot exactly compare the result values: ${messageOf(error)}` };
  }
  if (ordering === 'multiset') {
    leftRows.sort();
    rightRows.sort();
  }
  if (leftRows.length !== rightRows.length || leftRows.some((row, index) => row !== rightRows[index])) {
    return { equal: false, code: 'equivalence_result_mismatch', message: 'The Dataset and candidate result rows are not exactly equivalent.' };
  }
  return {
    equal: true,
    schemaFingerprint: fingerprint(leftSchema),
    resultFingerprint: fingerprint(frame(leftRows)),
  };
}

function canonicalSchema(columns: ColumnMeta[]): string {
  return frame(columns.map((column) => frame([column.name, logicalType(column)])));
}

function canonicalRow(row: Row, columns: ColumnMeta[]): string {
  const expected = new Set(columns.map((column) => column.name));
  if (Object.keys(row).some((key) => !expected.has(key))) {
    throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'A result row contains a value absent from its declared output schema.');
  }
  return frame(columns.map((column) => {
    if (!Object.prototype.hasOwnProperty.call(row, column.name)) {
      throw new DatasetEquivalenceFailure('equivalence_value_unsupported', `A result row is missing declared column ${column.name}.`);
    }
    return canonicalValue(row[column.name], logicalType(column));
  }));
}

function logicalType(column: ColumnMeta): string {
  const driver = column.driverType.trim().toLowerCase();
  if (/decimal|numeric|decfloat/.test(driver)) return 'decimal';
  if (/hugeint|bigint|int8/.test(driver)) return 'bigint';
  if (/smallint|tinyint|integer|\bint\b|int4|int2/.test(driver)) return 'integer';
  if (/double|float|real/.test(driver)) return 'float';
  if (/timestamp|datetime/.test(driver)) return 'timestamp';
  if (/\bdate\b/.test(driver)) return 'date';
  if (/bool/.test(driver)) return 'boolean';
  return column.type;
}

function canonicalValue(value: unknown, type: string): string {
  if (value === null) return 'null';
  if (value === undefined) throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'DQL distinguishes a missing result value from SQL NULL.');
  if (type === 'decimal') {
    if (typeof value === 'number') throw new DatasetEquivalenceFailure('equivalence_lossy_decimal', 'A DECIMAL result arrived as a JavaScript number, so ZLens cannot prove exact decimal equivalence.');
    if (typeof value === 'bigint') return `decimal:${value.toString()}`;
    if (typeof value === 'string' && /^[-+]?(?:\d+\.\d+|\d+|\.\d+)$/.test(value)) return `decimal:${value}`;
    throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'A DECIMAL result did not retain an exact string or bigint representation.');
  }
  if (type === 'bigint' || type === 'integer') {
    if (typeof value === 'bigint') return `integer:${value.toString()}`;
    if (typeof value === 'string' && /^[-+]?\d+$/.test(value)) return `integer:${value}`;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new DatasetEquivalenceFailure('equivalence_lossy_integer', 'An integer result exceeded JavaScript safe-integer precision.');
      return `integer:${value}`;
    }
    throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'An integer result did not retain an exact representation.');
  }
  if (type === 'float' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'A floating result is not a finite JavaScript number.');
    return `number:${Object.is(value, -0) ? '-0' : value.toString()}`;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new DatasetEquivalenceFailure('equivalence_value_unsupported', 'A boolean result did not retain a boolean representation.');
    return value ? 'boolean:true' : 'boolean:false';
  }
  if (type === 'date' || type === 'timestamp') {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) return `${type}:${value.toISOString()}`;
    if (typeof value === 'string') return `${type}:${value}`;
    throw new DatasetEquivalenceFailure('equivalence_value_unsupported', `A ${type} result did not retain a supported exact representation.`);
  }
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'boolean') return value ? 'boolean:true' : 'boolean:false';
  throw new DatasetEquivalenceFailure('equivalence_value_unsupported', `ZLens cannot exactly compare ${typeof value} output values.`);
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprintIdentity(identity: DatasetEquivalenceIdentity): string {
  return fingerprint(frame([
    identity.datasetId,
    identity.sourceRevision,
    identity.contractFingerprint,
    identity.snapshotFingerprint,
    identity.targetFingerprint,
    identity.personaPolicyFingerprint,
    identity.dialect,
    identity.adapterFingerprint,
    identity.compilerFingerprint,
    identity.rowBoundFingerprint,
  ]));
}

function frame(values: string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
}

function failure(code: DatasetEquivalenceFailureCode, message: string): DatasetEquivalenceResult {
  return { ok: false, code, message };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DatasetEquivalenceFailure('equivalence_execution_failed', 'The equivalence proof was cancelled.');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
