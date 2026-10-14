import { randomUUID } from 'node:crypto';
import {
  semanticExecutionFingerprint,
  type SemanticAdapterIdV1,
  type SemanticExecutionReceiptV1,
  type SemanticRuntimeMemberBindingV1,
  type SemanticTargetBindingV1,
  type WarehouseTargetIdentityV1,
} from '@zlens/core';
import {
  ConnectorQueryError,
  type ConnectionConfig,
  type QueryExecutionOptions,
  type QueryExecutor,
  type QueryResult,
} from '@zlens/connectors';
import type {
  SemanticRuntimeCompileResult,
  SemanticRuntimeTrace,
} from '../semantic-runtime.js';
import { observeWarehouseTargetIdentity } from './connection-identity.js';
import {
  SemanticAdapterDriftError,
  buildSemanticTargetBinding,
  type MetricFlowTargetMetadata,
} from './target-binding.js';


/**
 * Positional execution, or plain execution when the executor has no
 * positional entry point. Compiled semantic SQL carries no parameters, so the
 * two are the same statement; the difference is only whether the executor
 * exposes the bounded-read options. Injected test executors and the simplest
 * connectors expose `executeQuery` alone.
 */
type PositionalExecute = QueryExecutor['executePositional'];
function positionalExecutor(executor: QueryExecutor): PositionalExecute {
  if (typeof (executor as { executePositional?: unknown }).executePositional === 'function') {
    return executor.executePositional.bind(executor);
  }
  return (async (sql: string, _params: unknown[], connection: unknown) => {
    const plain = executor as unknown as { executeQuery: (sql: string, specs?: unknown, values?: unknown, connection?: unknown) => Promise<unknown> };
    return plain.executeQuery(sql, undefined, undefined, connection);
  }) as unknown as PositionalExecute;
}

export class SemanticPhysicalPreflightError extends Error {
  readonly code: 'IDENTIFIER_SCOPE_INVALID' | 'PHYSICAL_PREFLIGHT_FAILED';
  readonly details: {
    adapterId: SemanticAdapterIdV1;
    phase: 'validation';
    queryId?: string;
    sqlState?: string;
    vendorCode?: string;
    line?: number;
    position?: number;
    identifier?: string;
    compiledSql?: string;
    compiledSqlTruncated: boolean;
    compiledSqlFingerprint: string;
    sqlExcerpt?: { startLine: number; endLine: number; text: string };
    targetBinding: SemanticTargetBindingV1;
    safeActions: string[];
  };

  constructor(
    adapterId: SemanticAdapterIdV1,
    error: unknown,
    sql: string,
    targetBinding: SemanticTargetBindingV1,
  ) {
    const connector = error instanceof ConnectorQueryError ? error : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    const identifier = extractInvalidIdentifier(detail);
    const line = connector?.line ?? extractSqlLocation(detail).line;
    const position = connector?.position ?? extractSqlLocation(detail).position;
    const maxSqlChars = 1_000_000;
    const compiledSql = sql.length <= maxSqlChars ? sql : sql.slice(0, maxSqlChars);
    super(
      `The semantic query compiled, but warehouse validation failed: ${detail}`,
      error instanceof Error ? { cause: error } : undefined,
    );
    this.name = 'SemanticPhysicalPreflightError';
    this.code = identifier ? 'IDENTIFIER_SCOPE_INVALID' : 'PHYSICAL_PREFLIGHT_FAILED';
    this.details = {
      adapterId,
      phase: 'validation',
      queryId: connector?.queryId,
      sqlState: connector?.sqlState,
      vendorCode: connector?.vendorCode,
      line,
      position,
      identifier,
      compiledSql,
      compiledSqlTruncated: sql.length > maxSqlChars,
      compiledSqlFingerprint: semanticExecutionFingerprint(sql),
      sqlExcerpt: line ? sqlExcerpt(sql, line) : undefined,
      targetBinding,
      safeActions: ['refresh_snapshot', 'reapply_semantic_runtime', 'open_sql_notebook'],
    };
  }
}

export interface SemanticExecutionGatewayResult {
  compiled: SemanticRuntimeCompileResult;
  preparedSql: string;
  executionTarget: WarehouseTargetIdentityV1;
  targetBinding: SemanticTargetBindingV1;
  result: QueryResult;
  executionReceipt: SemanticExecutionReceiptV1;
  semanticTrace: SemanticRuntimeTrace;
}

export async function executeTargetBoundSemanticQuery(input: {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  projectRoot: string;
  plannedAdapter: SemanticAdapterIdV1;
  metricFlow?: MetricFlowTargetMetadata;
  compile: () => Promise<SemanticRuntimeCompileResult | null>;
  prepareSql?: (sql: string) => { sql: string; connection?: ConnectionConfig };
  rowBound?: number;
  /** Cancels this run only; callers must never interrupt a shared connector. */
  signal?: AbortSignal;
  /**
   * M4 conversion/equivalence callers may run final compiled SQL through one
   * already-open private read scope.  Identity observation and semantic target
   * binding remain owned by this gateway; the callback is intentionally only
   * a final-statement transport and is never exposed to browser input.
   */
  executePrepared?: (input: {
    sql: string;
    connection: ConnectionConfig;
    options: QueryExecutionOptions;
  }) => Promise<QueryResult>;
}): Promise<SemanticExecutionGatewayResult | null> {
  throwIfAborted(input.signal);
  const startedAt = Date.now();
  const executionTarget = await observeWarehouseTargetIdentity(input.executor, input.connection);
  throwIfAborted(input.signal);
  // Target validation intentionally happens before a remote compiler is called.
  buildSemanticTargetBinding({
    projectRoot: input.projectRoot,
    adapterId: input.plannedAdapter,
    executionTarget,
    metricFlow: input.metricFlow,
  });
  const compileStartedAt = Date.now();
  const compiled = await input.compile();
  throwIfAborted(input.signal);
  if (!compiled) return null;
  if (compiled.engine !== input.plannedAdapter) {
    throw new SemanticAdapterDriftError(input.plannedAdapter, compiled.engine);
  }
  const targetBinding = buildSemanticTargetBinding({
    projectRoot: input.projectRoot,
    adapterId: compiled.engine,
    executionTarget,
    metricFlow: input.metricFlow,
  });
  const prepared = input.prepareSql?.(compiled.sql) ?? { sql: compiled.sql, connection: input.connection };
  const preparedConnection = prepared.connection ?? input.connection;
  const validationStartedAt = Date.now();
  await preflightCompiledSql(
    input.executor,
    preparedConnection,
    prepared.sql,
    compiled.engine,
    targetBinding,
    input.signal,
  );
  throwIfAborted(input.signal);
  const executionStartedAt = Date.now();
  const rowBound = Math.max(1, Math.min(input.rowBound ?? 10_000, 100_000));
  const options: QueryExecutionOptions = {
    maxRows: rowBound,
    maxBytes: 16 * 1024 * 1024,
    batchSize: 500,
    deadlineMs: 120_000,
    signal: input.signal,
  };
  const result = input.executePrepared
    ? await input.executePrepared({ sql: prepared.sql, connection: preparedConnection, options })
    : await positionalExecutor(input.executor)(prepared.sql, [], preparedConnection, options);
  throwIfAborted(input.signal);
  const runtimeBindings = runtimeBindingsFromTrace(compiled.semanticTrace);
  const compiledSqlFingerprint = semanticExecutionFingerprint(compiled.sql);
  const executedSqlFingerprint = semanticExecutionFingerprint(prepared.sql);
  const planFingerprint = semanticExecutionFingerprint({
    request: compiled.effectiveRequest,
    adapterId: compiled.engine,
    snapshotId: targetBinding.semanticSnapshot.snapshotId,
  });
  const executablePlanFingerprint = semanticExecutionFingerprint({
    planFingerprint,
    targetBindingFingerprint: targetBinding.bindingFingerprint,
    executedSqlFingerprint,
  });
  const receipt: SemanticExecutionReceiptV1 = {
    version: 1,
    receiptId: `semantic-receipt:${randomUUID()}`,
    runId: `semantic-run:${randomUUID()}`,
    snapshotId: targetBinding.semanticSnapshot.snapshotId,
    planId: `semantic-plan:${planFingerprint.slice(0, 24)}`,
    planFingerprint,
    executablePlanId: `semantic-executable:${executablePlanFingerprint.slice(0, 24)}`,
    executablePlanFingerprint,
    targetBindingFingerprint: targetBinding.bindingFingerprint,
    adapterId: compiled.engine,
    executionTargetFingerprint: executionTarget.identityFingerprint,
    runtimeBindings,
    compiledSqlFingerprint,
    executedSqlFingerprint,
    parameterFingerprint: semanticExecutionFingerprint([]),
    queryId: result.queryId,
    sqlState: result.sqlState,
    vendorCode: result.vendorCode,
    outcome: 'succeeded',
    outputColumns: result.columns.map((column) => column.name),
    rowCount: result.rowCount,
    rowBound,
    resultFingerprint: semanticExecutionFingerprint({
      columns: result.columns.map((column) => column.name),
      rows: result.rows,
      rowCount: result.rowCount,
    }),
    timingsMs: {
      planning: compileStartedAt - startedAt,
      compilation: validationStartedAt - compileStartedAt,
      validation: executionStartedAt - validationStartedAt,
      execution: Date.now() - executionStartedAt,
    },
  };
  return {
    compiled,
    preparedSql: prepared.sql,
    executionTarget,
    targetBinding,
    result,
    executionReceipt: receipt,
    semanticTrace: traceAfterExecution(
      compiled.semanticTrace,
      targetBinding,
      receipt,
      result.queryId,
    ),
  };
}

async function preflightCompiledSql(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  sql: string,
  adapterId: SemanticAdapterIdV1,
  targetBinding: SemanticTargetBindingV1,
  signal?: AbortSignal,
): Promise<void> {
  // Snowflake EXPLAIN resolves relations, columns, aliases and permissions
  // without accepting the result as an analytical execution.
  if (connection.driver !== 'snowflake') return;
  try {
    await positionalExecutor(executor)(
      `EXPLAIN USING TEXT ${sql}`,
      [],
      connection,
      { maxRows: 500, maxBytes: 1024 * 1024, batchSize: 100, deadlineMs: 60_000, signal },
    );
  } catch (error) {
    throw new SemanticPhysicalPreflightError(adapterId, error, sql, targetBinding);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Semantic App run was cancelled.');
}

function extractInvalidIdentifier(message: string): string | undefined {
  return message.match(/\binvalid identifier\s+['"]([^'"]+)['"]/i)?.[1];
}

function extractSqlLocation(message: string): { line?: number; position?: number } {
  const match = message.match(/\bline\s+(\d+)\s+at\s+position\s+(\d+)/i);
  return match
    ? { line: Number(match[1]), position: Number(match[2]) }
    : {};
}

function sqlExcerpt(sql: string, line: number): { startLine: number; endLine: number; text: string } {
  const lines = sql.split(/\r?\n/);
  const boundedLine = Math.max(1, Math.min(line, lines.length));
  const startLine = Math.max(1, boundedLine - 3);
  const endLine = Math.min(lines.length, boundedLine + 3);
  return {
    startLine,
    endLine,
    text: lines.slice(startLine - 1, endLine)
      .map((value, index) => `${String(startLine + index).padStart(4, ' ')} | ${value}`)
      .join('\n'),
  };
}

function runtimeBindingsFromTrace(trace: SemanticRuntimeTrace): SemanticRuntimeMemberBindingV1[] {
  return trace.bindings.map((binding) => ({
    role: binding.role,
    qualifiedId: semanticExecutionFingerprint({
      authoringReference: binding.authoringReference,
      runtimeReference: binding.runtimeReference,
      entityPath: binding.entityPath,
    }),
    authoringReference: binding.authoringReference,
    runtimeReference: binding.runtimeReference,
    entityPath: [...binding.entityPath],
  }));
}

function traceAfterExecution(
  trace: SemanticRuntimeTrace,
  targetBinding: SemanticTargetBindingV1,
  executionReceipt: SemanticExecutionReceiptV1,
  queryId?: string,
): SemanticRuntimeTrace {
  return {
    ...trace,
    targetBinding,
    executionReceipt,
    steps: trace.steps.flatMap((step) => step.id === 'execute_query'
      ? [
          {
            id: 'validate_execution_target' as const,
            label: 'Validate semantic and warehouse targets',
            status: 'completed' as const,
            detail: `Bound ${targetBinding.adapterId} to target ${targetBinding.executionTarget.identityFingerprint.slice(0, 12)}.`,
          },
          {
            id: 'preflight_physical_sql' as const,
            label: 'Preflight compiled physical SQL',
            status: 'completed' as const,
            detail: targetBinding.executionTarget.driver === 'snowflake'
              ? 'Snowflake EXPLAIN resolved physical relations, columns, aliases, and access before execution.'
              : 'The connector does not expose a separate physical preflight; bounded execution retained the target contract.',
          },
          {
            ...step,
            status: 'completed' as const,
            detail: queryId
              ? `Executed on the bound warehouse target · query ${queryId}.`
              : 'Executed on the bound warehouse target.',
          },
        ]
      : [step]),
  };
}

export function semanticExecutionFailureCode(error: unknown): string | undefined {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

export function semanticExecutionFailureDetails(error: unknown): unknown {
  if (
    error
    && typeof error === 'object'
    && 'details' in error
    && (error as { details?: unknown }).details !== undefined
  ) {
    return (error as { details: unknown }).details;
  }
  if (error instanceof ConnectorQueryError) {
    return {
      driver: error.driver,
      queryId: error.queryId,
      sqlState: error.sqlState,
      vendorCode: error.vendorCode,
      line: error.line,
      position: error.position,
      retryable: error.retryable,
    };
  }
  return undefined;
}
