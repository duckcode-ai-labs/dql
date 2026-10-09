import { createHash } from 'node:crypto';
import type {
  ProviderEgressCategory,
  ProviderDispatchPhaseV1,
  ProviderEgressPurpose,
  ProviderEgressReceiptV1,
} from '@duckcodeailabs/dql-core';

export const PROVIDER_RESULT_ROW_REDACTION_POLICY_ID = 'research-result-rows-v1';
export const PROVIDER_ZERO_RESULT_ROWS_POLICY_ID = 'no-result-rows-v1';
/** @deprecated Ordinary Ask rows are permanently disabled; retained for receipt compatibility. */
export const ASK_NARRATION_RESULT_ROW_POLICY_ID = 'ask-narration-rows-v1';

/** Hard ceiling on rows an explicitly opted-in Research narration may release. */
export const MAX_RESEARCH_NARRATION_RESULT_ROWS = 20;
/** @deprecated Use `MAX_RESEARCH_NARRATION_RESULT_ROWS`; ordinary Ask has a zero row budget. */
export const MAX_ASK_NARRATION_RESULT_ROWS = MAX_RESEARCH_NARRATION_RESULT_ROWS;

/**
 * A receipt policy is a privacy authority, not a formatting preference. Only
 * the resolver may mint `research_run_opt_in`; older/manual policies default
 * to `none` and therefore cannot release rows accidentally.
 */
export type ProviderResultRowEgressAuthorityV1 = 'none' | 'research_run_opt_in';

/**
 * How many executed result rows may cross the provider boundary, and under whose
 * authority.
 *
 * Result rows stay host-local by default. A model may see a bounded, redacted
 * sample only for an explicit Research run whose one-run consent was accepted
 * by the server. Project configuration can narrow that Research allowance,
 * but it cannot grant ordinary Ask (or unconsented Research) an exception.
 */
export interface ProviderResultRowEgressPolicy {
  /** Rows released to an explicitly opted-in Research narration dispatch. */
  maxNarrationRows: number;
  /** Rows released to tool observations inside a generation loop. */
  maxToolRows: number;
  /** Who decided: the shipped default, project config, or an explicit request opt-in. */
  source: 'default' | 'project_config' | 'request_opt_in';
  /** Recorded on every receipt so an auditor can tell which rule applied. */
  policyId: string;
  /** Additive: absent legacy/manual policies are treated as `none`. */
  resultRowAuthority?: ProviderResultRowEgressAuthorityV1;
}

export const DEFAULT_ASK_ROW_EGRESS_POLICY: ProviderResultRowEgressPolicy = Object.freeze({
  maxNarrationRows: 0,
  maxToolRows: 0,
  source: 'default',
  policyId: PROVIDER_ZERO_RESULT_ROWS_POLICY_ID,
  resultRowAuthority: 'none',
});

export const ZERO_ROW_EGRESS_POLICY: ProviderResultRowEgressPolicy = Object.freeze({
  maxNarrationRows: 0,
  maxToolRows: 0,
  source: 'project_config',
  policyId: PROVIDER_ZERO_RESULT_ROWS_POLICY_ID,
  resultRowAuthority: 'none',
});

export const RESEARCH_ROW_EGRESS_POLICY: ProviderResultRowEgressPolicy = Object.freeze({
  maxNarrationRows: MAX_RESEARCH_NARRATION_RESULT_ROWS,
  maxToolRows: 200,
  source: 'request_opt_in',
  policyId: PROVIDER_RESULT_ROW_REDACTION_POLICY_ID,
  resultRowAuthority: 'research_run_opt_in',
});

/**
 * Resolve the row-egress policy for one run. The only path that may release
 * result rows is an explicit Research request with its one-run opt-in. A
 * project ceiling can narrow that request but can never grant rows to ordinary
 * Ask or to Research without consent.
 */
export function resolveProviderResultRowEgressPolicy(input: {
  projectSetting?: { mode?: 'bounded_sample' | 'disabled'; maxNarrationRows?: number };
  /** Server-normalized requested mode. Omitted/unknown modes are denied. */
  requestedMode?: string;
  researchOptIn?: boolean;
}): ProviderResultRowEgressPolicy {
  if (input.projectSetting?.mode === 'disabled') return ZERO_ROW_EGRESS_POLICY;
  if (input.requestedMode !== 'research' || input.researchOptIn !== true) {
    return DEFAULT_ASK_ROW_EGRESS_POLICY;
  }
  const configured = input.projectSetting?.maxNarrationRows;
  const maxNarrationRows = typeof configured === 'number' && Number.isFinite(configured)
    ? Math.max(0, Math.min(MAX_RESEARCH_NARRATION_RESULT_ROWS, Math.trunc(configured)))
    : MAX_RESEARCH_NARRATION_RESULT_ROWS;
  // A zero ceiling from config is the kill-switch by another name: report it as
  // such so receipts carry the honest policy id.
  if (maxNarrationRows === 0) return ZERO_ROW_EGRESS_POLICY;
  return { ...RESEARCH_ROW_EGRESS_POLICY, maxNarrationRows };
}

export interface ProviderPayloadGuardPolicy {
  allowResultRows: boolean;
  maxResultRows: number;
  /** Optional host caps used by Ask V2's local bounded-row transport. */
  maxResultColumns?: number;
  maxResultCells?: number;
  purpose: ProviderEgressPurpose;
}

export interface ProviderPayloadRowShape {
  resultRowCount: number;
  columnCount: number;
}

export interface BoundedProviderResultRows {
  value: unknown;
  shape: ProviderPayloadRowShape;
  exhausted: boolean;
}

/**
 * Process-local provenance marker for metadata arrays/objects assembled by a
 * trusted DQL serializer. The marker cannot be supplied by JSON, a provider,
 * or warehouse data and deliberately does not depend on field names.
 */
const providerMetadata = new WeakSet<object>();

export function markProviderMetadata<T extends object>(value: T): T {
  providerMetadata.add(value);
  return value;
}

export function markProviderMetadataArray<T>(value: T[]): T[] {
  providerMetadata.add(value);
  return value;
}

const RESULT_ROW_CONTAINER_KEYS = new Set([
  'rows', 'row', 'rowsample', 'rowssample', 'rowsample', 'resultrows', 'records', 'recordsample',
]);
const TYPED_METADATA_ARRAY_KEYS = new Set([
  'tables', 'columns', 'resultcolumns', 'outputcolumns',
  'measures', 'priormeasures', 'measurecolumns', 'metrics', 'dimensions', 'filters', 'values',
  'skills', 'turns', 'recentturns', 'recalledturns', 'drafts', 'components', 'tags', 'outputs',
  'keys', 'relationships', 'candidates', 'objects', 'citations', 'lineage', 'sourerefs', 'sourcerefs',
  'preferredmetrics', 'preferredblocks', 'preferreddimensions', 'requiredfilters', 'examples',
  'vocabulary', 'selectedconceptids', 'resultgrainids', 'tabledependencies', 'workloadidentityimpersonationpath',
]);
const TYPED_METADATA_MAP_KEYS = new Set(['dimensionvalues', 'resultdimensionvalues', 'membervalues']);
const TYPED_CONTEXT_PATH_SEGMENTS = new Set([
  'allowedsqlcontext', 'contextpack', 'conversationsnapshot', 'dqlartifact',
  'followup', 'memorycontext', 'projectsnapshot', 'questionplan', 'requestedshape', 'result',
  'semanticlayer', 'serversnapshot', 'turn', 'turns',
  'recentturns', 'recalledturns', 'objects', 'relations', 'sourceblocksql', 'schema', 'tables',
  'columns', 'drafts', 'components', 'outputs', 'relationships', 'candidates', 'lineage',
]);

/**
 * Clone one governed context immediately before prompt/transport construction.
 * Result-row containers and unclassified arrays are stripped; only arrays in a
 * typed metadata field receive process-local provenance. JSON cannot forge the
 * marker because every input value is cloned before marking.
 */
export function prepareProviderContextForDispatch(value: unknown): unknown {
  return prepareProviderContextValue(value, '', '', [], 0, new Set<object>());
}

function prepareProviderContextValue(
  value: unknown,
  key: string,
  parentKey: string,
  path: string[],
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 12 || seen.has(value as object)) return undefined;
  const normalizedKey = normalizePayloadKey(key);
  const normalizedParent = normalizePayloadKey(parentKey);
  if (Array.isArray(value)) {
    if (providerMetadata.has(value)) return value;
    if (RESULT_ROW_CONTAINER_KEYS.has(normalizedKey)) return markProviderMetadataArray([]);
    const typed = isTrustedGovernedContextArray(path, normalizedKey, normalizedParent);
    if (!typed) return markProviderMetadataArray([]);
    seen.add(value);
    const cloned = value.map((item) => prepareProviderContextValue(item, '', key, [...path, '*'], depth + 1, seen));
    return markProviderMetadataArray(cloned);
  }
  seen.add(value as object);
  const entries = Object.entries(value as Record<string, unknown>).map(([nestedKey, nested]) => [
    nestedKey,
    prepareProviderContextValue(nested, nestedKey, key, [...path, normalizePayloadKey(nestedKey)], depth + 1, seen),
  ] as const);
  return Object.fromEntries(entries);
}

/** Validate and mark runtime-acquired schema at its server-owned construction site. */
export function prepareServerOwnedProviderSchemaContext(value: unknown): unknown[] {
  if (!Array.isArray(value)) return markProviderMetadataArray([]);
  const tables = value.flatMap((candidate) => {
    if (!isPlainRecord(candidate)) return [];
    const relation = cleanProviderSchemaString(candidate.relation ?? candidate.table ?? candidate.name);
    if (!relation || !Array.isArray(candidate.columns)) return [];
    const columns = candidate.columns.flatMap((column) => {
      if (!isPlainRecord(column)) return [];
      const name = cleanProviderSchemaString(column.name);
      const type = cleanProviderSchemaString(column.type);
      return name && type ? [{ name, type }] : [];
    });
    if (columns.length === 0) return [];
    return [{ relation, columns: markProviderMetadataArray(columns) }];
  });
  return markProviderMetadataArray(tables);
}

function cleanProviderSchemaString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean && clean.length <= 512 ? clean : undefined;
}

function isTrustedGovernedContextArray(path: string[], key: string, parentKey: string): boolean {
  if (path.length === 1 && TYPED_METADATA_ARRAY_KEYS.has(key)) return true;
  if (TYPED_METADATA_MAP_KEYS.has(parentKey)) {
    return path.slice(0, -1).every((segment) => segment === '*' || TYPED_CONTEXT_PATH_SEGMENTS.has(segment)
      || TYPED_METADATA_MAP_KEYS.has(segment));
  }
  if (!TYPED_METADATA_ARRAY_KEYS.has(key)) return false;
  return path.slice(0, -1).every((segment) => segment === '*' || TYPED_CONTEXT_PATH_SEGMENTS.has(segment)
    || TYPED_METADATA_ARRAY_KEYS.has(segment) || TYPED_METADATA_MAP_KEYS.has(segment));
}

/**
 * Clone an exact provider-native request envelope at the physical dispatch
 * boundary. Unlike governed-context normalization, this trusts arrays only at
 * provider wire paths with validated item shapes; a matching leaf name inside
 * arbitrary context never grants provenance.
 */
export function prepareProviderWireEnvelopeForDispatch(
  provider: string,
  value: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw Object.assign(new Error(`${provider}: provider dispatch envelope must be an object`), {
      code: 'PROVIDER_WIRE_ENVELOPE_INVALID',
    });
  }
  return prepareProviderWireValue(provider, value, [], 0, new Set<object>()) as Record<string, unknown>;
}

function prepareProviderWireValue(
  provider: string,
  value: unknown,
  path: string[],
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 20 || seen.has(value as object)) {
    throw Object.assign(new Error(`${provider}: provider wire envelope is cyclic or too deeply nested`), {
      code: 'PROVIDER_WIRE_ENVELOPE_INVALID',
    });
  }
  if (Array.isArray(value)) {
    if (!isTrustedProviderWireArray(path, value)) return markProviderMetadataArray([]);
    seen.add(value);
    return markProviderMetadataArray(value.map((item) => (
      prepareProviderWireValue(provider, item, [...path, '*'], depth + 1, seen)
    )));
  }
  seen.add(value as object);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    prepareProviderWireValue(provider, nested, [...path, normalizePayloadKey(key)], depth + 1, seen),
  ]));
}

function isTrustedProviderWireArray(path: string[], value: unknown[]): boolean {
  const joined = path.join('.');
  if (joined === 'messages') return value.every(isProviderMessage);
  if (joined === 'contents') return value.every(isGeminiContent);
  if (joined === 'tools') return value.every(isProviderTool);
  if (joined === 'input') return value.every(isProviderInputItem);
  if (joined === 'system') return value.every((item) => isProviderContentBlock(item) || isConverseTextBlock(item));
  if (joined === 'include') return value.every((item) => typeof item === 'string');
  if (/^(?:messages|input)\.\*\.content$/.test(joined)) {
    return value.every((item) => isProviderContentBlock(item) || isConverseContentBlock(item));
  }
  if (joined === 'toolconfig.tools') return value.every(isConverseToolSpec);
  if (joined === 'inferenceconfig.stopsequences') return value.every((item) => typeof item === 'string');
  if (/^messages\.\*\.content\.\*\.toolresult\.content$/.test(joined)) {
    return value.every((item) => isConverseTextBlock(item) || (isPlainRecord(item) && 'json' in item));
  }
  if (/^contents\.\*\.parts$/.test(joined)) return value.every(isGeminiPart);
  if (/^(?:messages|input)\.\*\.toolcalls$/.test(joined)) return value.every(isProviderToolCall);
  if (/^(?:messages|input)\.\*\.content\.\*\.content$/.test(joined)) return value.every(isProviderContentBlock);
  if (isProviderToolSchemaPath(path)) {
    if (path.includes('examples') || path.includes('enum')) return value.every(isJsonSchemaExampleValue);
    return isValidProviderToolSchemaArray(path.at(-1) ?? '', value);
  }
  return false;
}

function isProviderToolSchemaPath(path: string[]): boolean {
  const joined = path.join('.');
  return /^tools\.\*\.(?:function\.parameters|inputschema)(?:\.|$)/.test(joined)
    || /^toolconfig\.tools\.\*\.toolspec\.inputschema\.json(?:\.|$)/.test(joined);
}

// Bedrock Converse wire shapes: blocks carry their kind as the key, not a `type`.
function isConverseTextBlock(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.text === 'string';
}

function isConverseContentBlock(value: unknown): boolean {
  return isConverseTextBlock(value) || (isPlainRecord(value) && (
    isPlainRecord(value.toolUse) || isPlainRecord(value.toolResult) || isPlainRecord(value.reasoningContent)
  ));
}

function isConverseToolSpec(value: unknown): boolean {
  return isPlainRecord(value) && isPlainRecord(value.toolSpec);
}

function isValidProviderToolSchemaArray(keyword: string, value: unknown[]): boolean {
  if (keyword === 'required') return value.every((item) => typeof item === 'string' && item.length > 0);
  if (keyword === 'anyof' || keyword === 'oneof' || keyword === 'allof' || keyword === 'prefixitems') {
    return value.every(isPlainRecord);
  }
  if (keyword === 'items') return value.every(isPlainRecord);
  if (keyword === 'enum' || keyword === 'examples') return value.every(isJsonSchemaExampleValue);
  return false;
}

function isJsonSchemaExampleValue(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonSchemaExampleValue);
  return isPlainRecord(value) && Object.values(value).every(isJsonSchemaExampleValue);
}

function isProviderMessage(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.role === 'string'
    && (typeof value.content === 'string' || Array.isArray(value.content) || value.content === null);
}

function isGeminiContent(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.role === 'string' && Array.isArray(value.parts);
}

function isGeminiPart(value: unknown): boolean {
  return isPlainRecord(value) && (typeof value.text === 'string' || isPlainRecord(value.functionCall) || isPlainRecord(value.functionResponse));
}

function isProviderTool(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return typeof value.type === 'string' || typeof value.name === 'string' || isPlainRecord(value.function);
}

function isProviderToolCall(value: unknown): boolean {
  return isPlainRecord(value) && (typeof value.type === 'string' || typeof value.id === 'string' || isPlainRecord(value.function));
}

function isProviderContentBlock(value: unknown): boolean {
  return typeof value === 'string' || (isPlainRecord(value) && typeof value.type === 'string');
}

function isProviderInputItem(value: unknown): boolean {
  return typeof value === 'string' || (isPlainRecord(value) && (
    typeof value.role === 'string' || typeof value.type === 'string'
  ));
}

function normalizePayloadKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Inspect a provider-bound payload recursively. Detection is structural rather
 * than dependent on a `rows` field, so a nested or renamed result cannot bypass
 * the guard. Known schema/catalog descriptor arrays remain metadata.
 */
export function inspectProviderPayloadRowShape(value: unknown): ProviderPayloadRowShape {
  return inspectProviderPayload(value).shape;
}

function inspectProviderPayload(value: unknown): {
  shape: ProviderPayloadRowShape;
  unsafeContainerCount: number;
  traversalComplete: boolean;
} {
  const seen = new Set<object>();
  let resultRowCount = 0;
  let columnCount = 0;
  let unsafeContainerCount = 0;
  let traversalComplete = true;
  const visit = (candidate: unknown, depth: number): void => {
    if (candidate === null || candidate === undefined) return;
    if (depth > 12) {
      traversalComplete = false;
      return;
    }
    if (Array.isArray(candidate)) {
      if (providerMetadata.has(candidate)) return;
      // Every unmarked array is a row container, primitives included: a list
      // of strings can be a column of member values. A PRODUCER that returns
      // vocabulary (cards, admitted ids, reason codes) marks its output as
      // provider metadata; the Ask V2 lane does so for every tool it exposes.
      unsafeContainerCount += 1;
      resultRowCount += candidate.length;
      columnCount = Math.max(columnCount, resultRowColumnCount(candidate));
      return;
    }
    if (typeof candidate !== 'object') return;
    if (providerMetadata.has(candidate)) return;
    if (seen.has(candidate)) {
      traversalComplete = false;
      return;
    }
    seen.add(candidate);
    for (const nested of Object.values(candidate as Record<string, unknown>)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return {
    shape: { resultRowCount, columnCount },
    unsafeContainerCount,
    traversalComplete,
  };
}

/** Throw before any row-shaped payload reaches a provider. */
export function assertProviderPayloadAllowed(
  value: unknown,
  policy: ProviderPayloadGuardPolicy,
): ProviderPayloadRowShape {
  const inspected = inspectProviderPayload(value);
  const shape = inspected.shape;
  if (!inspected.traversalComplete) {
    throw Object.assign(new Error('Provider egress could not completely inspect a cyclic or excessively deep payload.'), {
      code: 'PROVIDER_PAYLOAD_INSPECTION_INCOMPLETE',
    });
  }
  if (inspected.unsafeContainerCount === 0) return shape;
  if (!policy.allowResultRows) {
    throw Object.assign(new Error('Provider egress blocked a row-shaped result payload.'), {
      code: 'PROVIDER_RESULT_ROWS_BLOCKED',
    });
  }
  if (shape.resultRowCount > policy.maxResultRows) {
    throw Object.assign(new Error(`Provider egress blocked ${shape.resultRowCount} result rows; the per-run limit is ${policy.maxResultRows}.`), {
      code: 'PROVIDER_RESULT_ROWS_LIMIT_EXCEEDED',
    });
  }
  if (typeof policy.maxResultColumns === 'number' && shape.columnCount > policy.maxResultColumns) {
    throw Object.assign(new Error(`Provider egress blocked ${shape.columnCount} result columns; the per-run limit is ${policy.maxResultColumns}.`), {
      code: 'PROVIDER_RESULT_COLUMNS_LIMIT_EXCEEDED',
    });
  }
  if (typeof policy.maxResultCells === 'number' && shape.resultRowCount * shape.columnCount > policy.maxResultCells) {
    throw Object.assign(new Error(`Provider egress blocked a result payload exceeding ${policy.maxResultCells} cells.`), {
      code: 'PROVIDER_RESULT_CELLS_LIMIT_EXCEEDED',
    });
  }
  return shape;
}

/** Remove row-shaped arrays while preserving surrounding metadata. */
export function stripProviderResultRows(value: unknown, depth = 0): unknown {
  return stripProviderValue(value, depth, new Set<object>());
}

/** Bound every untrusted row container against one shared remaining allowance. */
export function boundProviderResultRows(
  value: unknown,
  maxRows: number,
  maxColumns = Number.MAX_SAFE_INTEGER,
  maxCells = Number.MAX_SAFE_INTEGER,
): BoundedProviderResultRows {
  let remaining = Math.max(0, Math.floor(maxRows));
  let remainingCells = Math.max(0, Math.floor(maxCells));
  let resultRowCount = 0;
  let columnCount = 0;
  let exhausted = false;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    if (candidate === null || candidate === undefined || typeof candidate !== 'object') return candidate;
    if (depth > 12 || seen.has(candidate as object)) {
      exhausted = true;
      return undefined;
    }
    if (Array.isArray(candidate)) {
      if (providerMetadata.has(candidate)) return candidate;
      const kept: unknown[] = [];
      for (const row of candidate) {
        if (remaining <= 0 || remainingCells <= 0) { exhausted = true; break; }
        const boundedRow = boundProviderResultRowColumns(row, maxColumns, remainingCells);
        if (boundedRow.cellCount === 0) { exhausted = true; break; }
        kept.push(boundedRow.value);
        remaining -= 1;
        remainingCells -= boundedRow.cellCount;
        columnCount = Math.max(columnCount, boundedRow.columnCount);
        if (boundedRow.truncated) exhausted = true;
      }
      resultRowCount += kept.length;
      if (kept.length < candidate.length) exhausted = true;
      return kept;
    }
    seen.add(candidate as object);
    const bounded = Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([key, nested]) => [
      key,
      visit(nested, depth + 1),
    ]));
    if (depth === 0 && exhausted) {
      bounded.providerEgressNotice = {
        code: 'PROVIDER_RESULT_ROWS_CUMULATIVE_LIMIT',
        message: 'The per-run result egress allowance is exhausted; no additional rows were disclosed.',
      };
    }
    return bounded;
  };
  return { value: visit(value, 0), shape: { resultRowCount, columnCount }, exhausted };
}

function boundProviderResultRowColumns(row: unknown, maxColumns: number, remainingCells: number): {
  value: unknown;
  cellCount: number;
  columnCount: number;
  truncated: boolean;
} {
  const limit = Math.max(0, Math.min(maxColumns, remainingCells));
  if (Array.isArray(row)) {
    const value = row.slice(0, limit);
    return { value, cellCount: value.length, columnCount: value.length, truncated: value.length < row.length };
  }
  if (isPlainRecord(row)) {
    const entries = Object.entries(row).slice(0, limit);
    return {
      value: Object.fromEntries(entries),
      cellCount: entries.length,
      columnCount: entries.length,
      truncated: entries.length < Object.keys(row).length,
    };
  }
  return limit > 0
    ? { value: row, cellCount: 1, columnCount: 1, truncated: false }
    : { value: undefined, cellCount: 0, columnCount: 0, truncated: true };
}

function stripProviderValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    if (providerMetadata.has(value)) return value;
    return [];
  }
  if (!isPlainRecord(value)) return value;
  if (providerMetadata.has(value)) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    stripProviderValue(nested, depth + 1, seen),
  ]));
}

/** Redact and bound explicitly opted-in Research rows before prompt/tool use. */
export function redactProviderResultRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  return rows.slice(0, Math.max(0, limit)).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, redactProviderCell(key, value)]),
  ));
}

export function createProviderEgressReceipt(input: {
  purpose: ProviderEgressPurpose;
  provider: string;
  permittedCategories: ProviderEgressCategory[];
  optIn: boolean;
  payload: unknown;
  resultRowCount?: number;
  cumulativeResultRowCount?: number;
  columnCount?: number;
  redactionPolicyId?: string;
}): ProviderEgressReceiptV1 {
  const inspected = inspectProviderPayload(input.payload);
  return {
    version: 1,
    purpose: input.purpose,
    provider: input.provider,
    permittedCategories: [...input.permittedCategories],
    // Counts always come from the payload actually fingerprinted. Optional
    // caller projections remain accepted for wire compatibility but cannot
    // override inspected evidence.
    resultRowCount: inspected.shape.resultRowCount,
    ...(typeof input.cumulativeResultRowCount === 'number'
      ? { cumulativeResultRowCount: Math.max(inspected.shape.resultRowCount, input.cumulativeResultRowCount) }
      : {}),
    columnCount: inspected.shape.columnCount,
    redactionPolicyId: input.redactionPolicyId
      ?? (input.optIn ? PROVIDER_RESULT_ROW_REDACTION_POLICY_ID : PROVIDER_ZERO_RESULT_ROWS_POLICY_ID),
    optIn: input.optIn,
    payloadFingerprint: `sha256:${createHash('sha256').update(stableJson(input.payload)).digest('hex')}`,
  };
}

/**
 * Content-free receipt for one exact provider-native HTTP envelope. Tool
 * results are strings in the OpenAI/Claude wire formats, so their row shape is
 * carried from the recursive pre-serialization inspection that produced those
 * strings. Any still-structural row array in the envelope wins over that
 * projection and can never be hidden with a caller-supplied zero.
 */
export function createProviderDispatchEgressReceipt(input: {
  purpose: ProviderEgressPurpose;
  dispatchPhase?: ProviderDispatchPhaseV1;
  provider: string;
  model?: string;
  operation?: 'generate' | 'generate_with_tools' | 'generate_stream';
  attemptIndex?: number;
  retryOfAttemptIndex?: number;
  options?: ProviderEgressReceiptV1['options'];
  permittedCategories: ProviderEgressCategory[];
  optIn: boolean;
  envelope: unknown;
  serializedResultShape?: ProviderPayloadRowShape;
  cumulativeResultRowCount?: number;
  redactionPolicyId?: string;
}): ProviderEgressReceiptV1 {
  const inspected = inspectProviderPayload(input.envelope);
  const serialized = input.serializedResultShape ?? { resultRowCount: 0, columnCount: 0 };
  return {
    version: 1,
    purpose: input.purpose,
    ...(input.dispatchPhase ? { dispatchPhase: input.dispatchPhase } : {}),
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.attemptIndex !== undefined ? { attemptIndex: input.attemptIndex } : {}),
    ...(input.retryOfAttemptIndex !== undefined ? { retryOfAttemptIndex: input.retryOfAttemptIndex } : {}),
    ...(input.options ? { options: { ...input.options } } : {}),
    permittedCategories: [...input.permittedCategories],
    resultRowCount: Math.max(inspected.shape.resultRowCount, serialized.resultRowCount),
    ...(typeof input.cumulativeResultRowCount === 'number'
      ? { cumulativeResultRowCount: Math.max(inspected.shape.resultRowCount, serialized.resultRowCount, input.cumulativeResultRowCount) }
      : {}),
    columnCount: Math.max(inspected.shape.columnCount, serialized.columnCount),
    redactionPolicyId: input.redactionPolicyId
      ?? (input.optIn ? PROVIDER_RESULT_ROW_REDACTION_POLICY_ID : PROVIDER_ZERO_RESULT_ROWS_POLICY_ID),
    optIn: input.optIn,
    payloadFingerprint: providerPayloadFingerprint(input.envelope),
  };
}

export function providerPayloadFingerprint(payload: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(payload)).digest('hex')}`;
}

function resultRowColumnCount(rows: unknown[]): number {
  const first = rows[0];
  return Array.isArray(first)
    ? first.length
    : isPlainRecord(first)
      ? Object.keys(first).length
      : rows.length > 0 ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function redactProviderCell(key: string, value: unknown): unknown {
  if (/(?:^|_)(?:name|email|phone|address|ssn|secret|token|credential|password)(?:$|_)/i.test(key)) return '[REDACTED]';
  if (typeof value !== 'string') return value;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return '[REDACTED]';
  if (/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{12,}\b/i.test(value)) return '[REDACTED]';
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!isPlainRecord(candidate)) return candidate;
    return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, normalize(candidate[key])]));
  };
  try {
    return JSON.stringify(normalize(value)) ?? 'null';
  } catch {
    return String(value);
  }
}
