import { createHash } from 'node:crypto';
import {
  analyticalRepairTrustTransition,
  type AnalyticalFailureCode,
  type AnalyticalFailurePhase,
  type AnalyticalFailureRecoverability,
  type AnalyticalFailureV1,
  type AnalyticalRepairChange,
  type AnalyticalRepairTrustTransition,
  type AnalyticalTrustState,
} from '@duckcodeailabs/dql-core';

/**
 * Stable diagnostics and immutable repair derivations for RFC 0005.
 * Acceptance: API-007, SEC-004.
 */

export interface AnalyticalFailedBindingInput {
  qualifiedId?: string;
  role?: string;
  reasonCode?: string;
}

export interface CreateAnalyticalFailureInput {
  error?: unknown;
  code?: AnalyticalFailureCode;
  phase: AnalyticalFailurePhase;
  snapshotId: string;
  runId?: string;
  planFingerprint?: string;
  dqlSource?: string;
  dqlFingerprint?: string;
  compiledSql?: string;
  sqlFingerprint?: string;
  failedBindings?: AnalyticalFailedBindingInput[];
}

export type AnalyticalRepairAction =
  | 'retry_same_plan'
  | 'parameter_rerun'
  | 'refresh_snapshot'
  | 'edit_dql'
  | 'open_sql_notebook'
  | 'change_authorized_connection'
  | 'request_access'
  | 'save_draft_block';

export interface AnalyticalFailedRunV1 {
  version: 1;
  runId: string;
  snapshotId: string;
  route: 'certified' | 'semantic' | 'governed_sql' | 'generated_sql';
  trustState: AnalyticalTrustState;
  planFingerprint: string;
  dqlSource?: string;
  dqlFingerprint?: string;
  compiledSql?: string;
  sqlFingerprint?: string;
  failure: AnalyticalFailureV1;
}

export interface AnalyticalRepairRequestV1 {
  version: 1;
  action: AnalyticalRepairAction;
  parameterValues?: Record<string, unknown>;
  dqlSource?: string;
  sqlText?: string;
  refreshedSnapshotId?: string;
  authorizedConnectionFingerprint?: string;
  governedValidationPassed?: boolean;
}

export interface AnalyticalRepairDerivationV1 {
  version: 1;
  derivationId: string;
  sourceRunId: string;
  derivedRunId: string;
  action: AnalyticalRepairAction;
  change: AnalyticalRepairChange;
  snapshotId: string;
  planFingerprint: string;
  sourceFailureId: string;
  sourceDqlFingerprint?: string;
  sourceSqlFingerprint?: string;
  derivedDqlSource?: string;
  derivedDqlFingerprint?: string;
  notebookSqlText?: string;
  derivedSqlFingerprint?: string;
  parameterFingerprint?: string;
  authorizedConnectionFingerprint?: string;
  trustTransition: AnalyticalRepairTrustTransition;
  requiresRecompile: boolean;
  requiresExecution: boolean;
  routeLocked: true;
  permissionsExpanded: false;
}

export type AnalyticalRepairDerivationResult =
  | { status: 'ready'; derivation: AnalyticalRepairDerivationV1 }
  | {
      status: 'blocked';
      code:
        | 'ACTION_NOT_ALLOWED'
        | 'PERMISSION_FAILURE_TERMINAL'
        | 'REPAIR_INPUT_REQUIRED'
        | 'SOURCE_FINGERPRINT_MISMATCH';
      reason: string;
    };

const ERROR_CODE_ALIASES: Record<string, AnalyticalFailureCode> = {
  '42P01': 'RELATION_NOT_FOUND',
  '42P10': 'AMBIGUOUS_COLUMN',
  '42702': 'AMBIGUOUS_COLUMN',
  '42703': 'COLUMN_NOT_FOUND',
  '42501': 'PERMISSION_DENIED',
  EACCES: 'PERMISSION_DENIED',
  ER_ACCESS_DENIED_ERROR: 'PERMISSION_DENIED',
  COLUMN_NOT_FOUND: 'COLUMN_NOT_FOUND',
  RELATION_NOT_FOUND: 'RELATION_NOT_FOUND',
  TABLE_NOT_FOUND: 'RELATION_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ACCESS_DENIED: 'PERMISSION_DENIED',
  AMBIGUOUS_COLUMN: 'AMBIGUOUS_COLUMN',
  DIALECT_ERROR: 'DIALECT_ERROR',
  SYNTAX_ERROR: 'DIALECT_ERROR',
  SNAPSHOT_DRIFT: 'SNAPSHOT_DRIFT',
  SOURCE_CHANGED: 'SNAPSHOT_DRIFT',
  TIMEOUT: 'TIMEOUT',
  ETIMEDOUT: 'TIMEOUT',
  RESULT_CONTRACT_MISMATCH: 'RESULT_CONTRACT_MISMATCH',
  COMPILATION_FAILED: 'COMPILATION_FAILED',
  POLICY_DENIED: 'POLICY_DENIED',
  // A host's row policy refused the statement (RFC 0010 HH-3, HH-17): no repair can change that.
  ROW_POLICY_REFUSED: 'POLICY_DENIED',
};

const SAFE_FAILURES: Record<AnalyticalFailureCode, {
  message: string;
  recoverability: AnalyticalFailureRecoverability;
  safeActions: string[];
}> = {
  COLUMN_NOT_FOUND: {
    message: 'A governed column required by the selected plan is unavailable.',
    recoverability: 'refresh_snapshot',
    safeActions: ['refresh_snapshot', 'edit_dql', 'open_sql_notebook'],
  },
  RELATION_NOT_FOUND: {
    message: 'A governed relation required by the selected plan is unavailable.',
    recoverability: 'refresh_snapshot',
    // A missing warehouse catalog/relation can be stale project metadata, but
    // can also mean the active connection points at a different database (for
    // example a new in-memory DuckDB target). Suggest the approved target
    // choice first without reopening the frozen plan or guessing a relation.
    safeActions: ['change_authorized_connection', 'refresh_snapshot', 'edit_dql', 'open_sql_notebook'],
  },
  PERMISSION_DENIED: {
    message: 'The selected governed route was denied by the active warehouse permissions.',
    recoverability: 'request_access',
    safeActions: ['request_access', 'change_authorized_connection'],
  },
  AMBIGUOUS_COLUMN: {
    message: 'The compiled statement contains a column reference the warehouse cannot resolve uniquely.',
    recoverability: 'edit_dql',
    safeActions: ['edit_dql', 'open_sql_notebook'],
  },
  DIALECT_ERROR: {
    message: 'The selected route could not compile or execute in the configured warehouse dialect.',
    recoverability: 'edit_dql',
    safeActions: ['edit_dql', 'open_sql_notebook'],
  },
  SNAPSHOT_DRIFT: {
    message: 'The executable plan no longer matches the active project snapshot.',
    recoverability: 'refresh_snapshot',
    safeActions: ['refresh_snapshot'],
  },
  TIMEOUT: {
    message: 'The selected route exceeded its bounded execution time.',
    recoverability: 'retry_same',
    safeActions: ['retry_same_plan'],
  },
  RESULT_CONTRACT_MISMATCH: {
    message: 'The result did not satisfy the selected plan output contract.',
    recoverability: 'edit_dql',
    safeActions: ['edit_dql', 'open_sql_notebook'],
  },
  COMPILATION_FAILED: {
    message: 'The selected route could not compile its immutable analytical plan.',
    recoverability: 'edit_dql',
    safeActions: ['edit_dql', 'open_sql_notebook'],
  },
  POLICY_DENIED: {
    message: 'Workspace policy does not authorize this analytical operation.',
    recoverability: 'none',
    safeActions: [],
  },
};

const ACTION_TO_CHANGE: Record<AnalyticalRepairAction, AnalyticalRepairChange> = {
  retry_same_plan: 'parameter_only',
  parameter_rerun: 'parameter_only',
  refresh_snapshot: 'snapshot_refresh',
  edit_dql: 'dql_source',
  open_sql_notebook: 'sql_text',
  change_authorized_connection: 'connection_change',
  request_access: 'connection_change',
  save_draft_block: 'reviewed_draft_promotion',
};

/** Classify an adapter/compiler error without exposing its raw text. */
export function classifyAnalyticalFailure(error: unknown, fallback: AnalyticalFailureCode = 'COMPILATION_FAILED'): AnalyticalFailureCode {
  const record = objectRecord(error);
  const structured = [record?.code, record?.sqlState, record?.sqlstate, record?.name]
    .find((candidate) => typeof candidate === 'string') as string | undefined;
  if (structured) {
    const code = ERROR_CODE_ALIASES[structured.trim().toUpperCase()];
    if (code) return code;
  }

  const text = errorText(error).toLowerCase();
  if (/permission denied|access denied|not authorized|insufficient privilege|forbidden/.test(text)) return 'PERMISSION_DENIED';
  if (/ambiguous (column|field)|column reference .* ambiguous/.test(text)) return 'AMBIGUOUS_COLUMN';
  if (/column .* (does not exist|not found|unknown)|unknown column|invalid identifier/.test(text)) return 'COLUMN_NOT_FOUND';
  if (/(catalog|relation|table|view) .* (does not exist|not found|unknown)|unknown table/.test(text)) return 'RELATION_NOT_FOUND';
  if (/snapshot .* (changed|stale|mismatch)|source changed|schema drift/.test(text)) return 'SNAPSHOT_DRIFT';
  if (/timed? ?out|deadline exceeded|query timeout/.test(text)) return 'TIMEOUT';
  if (/result contract|missing output|unexpected output|row bound|decimal value required/.test(text)) return 'RESULT_CONTRACT_MISMATCH';
  if (/syntax error|parse error|parser error|unsupported dialect|dialect/.test(text)) return 'DIALECT_ERROR';
  if (/policy denied|policy violation|blocked by policy/.test(text)) return 'POLICY_DENIED';
  return fallback;
}

/** Redacted producer text for the inspector, or undefined when there was nothing to say. */
function analyticalFailureDiagnostic(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const text = redactAnalyticalDiagnostic(error).trim();
  return text && text !== 'undefined' && text !== 'null' ? text : undefined;
}

/** Create the one redacted failure envelope returned by every analytical surface. */
export function createAnalyticalFailure(input: CreateAnalyticalFailureInput): AnalyticalFailureV1 {
  const code = input.code ?? classifyAnalyticalFailure(input.error, fallbackCodeForPhase(input.phase));
  const safe = SAFE_FAILURES[code];
  const planFingerprint = cleanFingerprint(input.planFingerprint);
  const dqlFingerprint = cleanFingerprint(input.dqlFingerprint) ?? fingerprintText(input.dqlSource);
  const sqlFingerprint = cleanFingerprint(input.sqlFingerprint) ?? fingerprintText(input.compiledSql);
  const snapshotId = input.snapshotId.trim() || 'snapshot-unavailable';
  const failedBindings = normalizeFailedBindings(input.failedBindings, code);
  const runId = input.runId?.trim() || stableId('analytical-run', {
    snapshotId,
    planFingerprint,
    dqlFingerprint,
    sqlFingerprint,
  });
  const failureId = stableId('analytical-failure', {
    runId,
    code,
    phase: input.phase,
    failedBindings,
    planFingerprint,
    dqlFingerprint,
    sqlFingerprint,
  });
  return {
    version: 1,
    runId,
    failureId,
    code,
    phase: input.phase,
    message: safe.message,
    // The safe headline stays the user-facing copy; the producer's own words go
    // to the inspector so the true cause is recoverable. Without this, every
    // unclassified failure collapsed into one indistinguishable sentence.
    ...(analyticalFailureDiagnostic(input.error) ? { diagnostic: analyticalFailureDiagnostic(input.error) } : {}),
    recoverability: safe.recoverability,
    failedBindings,
    snapshotId,
    ...(planFingerprint ? { planFingerprint } : {}),
    ...(dqlFingerprint ? { dqlFingerprint } : {}),
    ...(sqlFingerprint ? { sqlFingerprint } : {}),
    safeActions: [...safe.safeActions],
  };
}

/**
 * Derive a repair from an immutable failed run. This function never retrieves,
 * reroutes, executes, mutates the source run, or expands permissions.
 */
export function deriveAnalyticalRepair(
  source: AnalyticalFailedRunV1,
  request: AnalyticalRepairRequestV1,
): AnalyticalRepairDerivationResult {
  if (request.version !== 1 || source.version !== 1) {
    return { status: 'blocked', code: 'REPAIR_INPUT_REQUIRED', reason: 'Only v1 analytical repair inputs are supported.' };
  }
  const actionAllowed = source.failure.safeActions.includes(request.action)
    || (
      request.action === 'parameter_rerun'
      && source.route === 'certified'
      && source.failure.safeActions.includes('retry_same_plan')
    );
  if (!actionAllowed) {
    return { status: 'blocked', code: 'ACTION_NOT_ALLOWED', reason: 'The requested action is not allowed for this stable failure.' };
  }
  if (
    source.failure.code === 'PERMISSION_DENIED'
    && request.action !== 'request_access'
    && request.action !== 'change_authorized_connection'
  ) {
    return {
      status: 'blocked',
      code: 'PERMISSION_FAILURE_TERMINAL',
      reason: 'Permission denial is terminal for the selected route.',
    };
  }

  const change = ACTION_TO_CHANGE[request.action];
  const inputGap = validateRepairInput(source, request);
  if (inputGap) return { status: 'blocked', code: 'REPAIR_INPUT_REQUIRED', reason: inputGap };
  if (source.dqlSource && source.dqlFingerprint && fingerprintText(source.dqlSource) !== source.dqlFingerprint) {
    return { status: 'blocked', code: 'SOURCE_FINGERPRINT_MISMATCH', reason: 'The immutable source DQL fingerprint does not match its retained text.' };
  }
  if (source.compiledSql && source.sqlFingerprint && fingerprintText(source.compiledSql) !== source.sqlFingerprint) {
    return { status: 'blocked', code: 'SOURCE_FINGERPRINT_MISMATCH', reason: 'The immutable source SQL fingerprint does not match its retained text.' };
  }

  const snapshotId = request.refreshedSnapshotId?.trim() || source.snapshotId;
  const derivedDqlSource = request.action === 'edit_dql' ? request.dqlSource!.trim() : source.dqlSource;
  const notebookSqlText = request.action === 'open_sql_notebook'
    ? (request.sqlText ?? source.compiledSql)!.trim()
    : undefined;
  const derivedDqlFingerprint = fingerprintText(derivedDqlSource);
  const derivedSqlFingerprint = fingerprintText(notebookSqlText);
  const parameterFingerprint = request.parameterValues ? fingerprintValue(request.parameterValues) : undefined;
  const authorizedConnectionFingerprint = cleanFingerprint(request.authorizedConnectionFingerprint);
  const trustTransition = analyticalRepairTrustTransition({
    previous: source.trustState,
    change,
    governedValidationPassed: request.governedValidationPassed,
  });
  const derivationIdentity = {
    sourceRunId: source.runId,
    sourceFailureId: source.failure.failureId,
    action: request.action,
    snapshotId,
    planFingerprint: source.planFingerprint,
    derivedDqlFingerprint,
    derivedSqlFingerprint,
    parameterFingerprint,
    authorizedConnectionFingerprint,
    trustTransition,
  };
  const derivationId = stableId('analytical-derivation', derivationIdentity);
  return {
    status: 'ready',
    derivation: {
      version: 1,
      derivationId,
      sourceRunId: source.runId,
      derivedRunId: stableId('analytical-run', derivationIdentity),
      action: request.action,
      change,
      snapshotId,
      planFingerprint: source.planFingerprint,
      sourceFailureId: source.failure.failureId,
      ...(source.dqlFingerprint ? { sourceDqlFingerprint: source.dqlFingerprint } : {}),
      ...(source.sqlFingerprint ? { sourceSqlFingerprint: source.sqlFingerprint } : {}),
      ...(derivedDqlSource ? { derivedDqlSource } : {}),
      ...(derivedDqlFingerprint ? { derivedDqlFingerprint } : {}),
      ...(notebookSqlText ? { notebookSqlText } : {}),
      ...(derivedSqlFingerprint ? { derivedSqlFingerprint } : {}),
      ...(parameterFingerprint ? { parameterFingerprint } : {}),
      ...(authorizedConnectionFingerprint ? { authorizedConnectionFingerprint } : {}),
      trustTransition,
      requiresRecompile: request.action === 'edit_dql' || request.action === 'refresh_snapshot',
      requiresExecution: request.action !== 'request_access' && request.action !== 'open_sql_notebook' && request.action !== 'save_draft_block',
      routeLocked: true,
      permissionsExpanded: false,
    },
  };
}

/** Redact untrusted diagnostics before logs or traces display them. */
export function redactAnalyticalDiagnostic(value: unknown): string {
  return errorText(value)
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|sqlserver):\/\/[^\s]+/gi, '[REDACTED_CONNECTION]')
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?/gi, '[REDACTED_TOKEN]')
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/'(?:''|[^'])*'/g, "'[REDACTED_VALUE]'")
    .slice(0, 512);
}

function validateRepairInput(source: AnalyticalFailedRunV1, request: AnalyticalRepairRequestV1): string | undefined {
  if (request.action === 'parameter_rerun' && !request.parameterValues) return 'A parameter rerun requires explicit parameter values.';
  if (request.action === 'edit_dql' && !request.dqlSource?.trim()) return 'A DQL repair requires derived DQL source.';
  if (request.action === 'open_sql_notebook' && !request.sqlText?.trim() && !source.compiledSql?.trim()) {
    return 'Opening SQL in Notebook requires retained or explicit SQL text.';
  }
  if (request.action === 'refresh_snapshot' && !request.refreshedSnapshotId?.trim()) return 'Snapshot repair requires the refreshed snapshot identity.';
  if (request.action === 'change_authorized_connection' && !cleanFingerprint(request.authorizedConnectionFingerprint)) {
    return 'Connection repair requires a redacted authorized connection fingerprint.';
  }
  return undefined;
}

function normalizeFailedBindings(bindings: AnalyticalFailedBindingInput[] | undefined, code: AnalyticalFailureCode): AnalyticalFailureV1['failedBindings'] {
  const normalized = (bindings ?? []).map((binding) => ({
    ...(binding.qualifiedId?.trim() ? { qualifiedId: binding.qualifiedId.trim() } : {}),
    ...(binding.role?.trim() ? { role: binding.role.trim() } : {}),
    reasonCode: binding.reasonCode?.trim() || code,
  }));
  return normalized.sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function fallbackCodeForPhase(phase: AnalyticalFailurePhase): AnalyticalFailureCode {
  if (phase === 'result_validation') return 'RESULT_CONTRACT_MISMATCH';
  return 'COMPILATION_FAILED';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  const record = objectRecord(error);
  if (typeof record?.message === 'string') return record.message;
  return 'Analytical operation failed.';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function cleanFingerprint(value: string | undefined): string | undefined {
  const clean = value?.trim().toLowerCase();
  return clean && /^[a-f0-9]{64}$/.test(clean) ? clean : undefined;
}

function fingerprintText(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? createHash('sha256').update(clean).digest('hex') : undefined;
}

function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${fingerprintValue(value).slice(0, 24)}`;
}

function stableSerialize(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}
