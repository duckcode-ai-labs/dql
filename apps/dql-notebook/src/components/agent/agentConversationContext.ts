import type { AgentAnswerCascade, AgentConversationDqlArtifact } from '../../llm/types';
import { normalizeDqlArtifactReference } from '@zlens/core/artifacts';

export type ConversationThreadItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'run';
      id: string;
      run: {
        id: string;
        question: string;
        answer?: string;
        summary?: string;
        completedAt?: string;
        artifacts: Array<{ kind: string; ref?: string; payload?: unknown }>;
      };
    };

export interface ConversationStateTurn {
  id: string;
  question: string;
  answerSummary?: string;
  completedAt?: string;
  artifactKind?: string;
  sourceCertifiedBlock?: string;
  route?: string;
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  contextPackId?: string;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  requestedMeasures?: string[];
  answerContract?: unknown;
  dqlArtifact?: AgentConversationDqlArtifact;
  cascade?: AgentAnswerCascade;
  topN?: number;
  result?: {
    columns: string[];
    rowsSample: Record<string, unknown>[];
    dimensionValues?: Record<string, string[]>;
    measureColumns?: string[];
    rowCount?: number;
  };
  sourceSql?: string;
}

export function buildConversationContext(items: ConversationThreadItem[]): Record<string, unknown> | undefined {
  const turns = items
    .filter((item): item is Extract<ConversationThreadItem, { kind: 'run' }> => item.kind === 'run')
    .map(turnFromRunItem)
    .filter((turn): turn is ConversationStateTurn => Boolean(turn))
    .slice(-6);
  if (turns.length === 0) return undefined;

  const activeTurn = [...turns].reverse().find((turn) => turn.result?.columns.length) ?? turns[turns.length - 1]!;
  const activeResult = activeTurn.result;
  const requestedShape = requestedShapeFromContract(activeTurnContract(activeTurn));
  return compactRecord({
    activeSurface: 'notebook',
    conversationStateVersion: 1,
    activeTurnId: activeTurn.id,
    activeTopic: activeTurn.question,
    conversationSummary: summarizeConversationTurns(turns),
    turns,
    sourceAnswerId: activeTurn.id,
    sourceCertifiedBlock: activeTurn.sourceCertifiedBlock,
    sourceQuestion: activeTurn.question,
    sourceAnswerSummary: activeTurn.answerSummary,
    answerContract: activeTurnContract(activeTurn),
    dqlArtifact: activeTurn.dqlArtifact,
    cascade: activeTurn.cascade,
    resultColumns: activeResult?.columns,
    resultRowsSample: activeResult?.rowsSample,
    resultDimensionValues: activeResult?.dimensionValues,
    outputColumns: activeResult?.columns,
    requestedFilters: activeTurn.requestedFilters ?? stringArray(requestedShape?.filters),
    requestedDimensions: activeTurn.requestedDimensions ?? stringArray(requestedShape?.dimensions),
    priorLimit: activeTurn.topN ?? topNFromRequestedShape(requestedShape),
    priorMeasures: activeTurn.requestedMeasures ?? activeResult?.measureColumns,
    contextPackId: activeTurn.contextPackId,
    trustLabel: activeTurn.trustLabel,
    reviewStatus: activeTurn.reviewStatus,
    certification: activeTurn.certification,
    route: activeTurn.route,
    sourceSql: activeTurn.sourceSql,
    updatedAt: activeTurn.completedAt,
  });
}

function turnFromRunItem(item: Extract<ConversationThreadItem, { kind: 'run' }>): ConversationStateTurn | undefined {
  const artifact = item.run.artifacts.find((candidate) => candidate.kind === 'answer')
    ?? item.run.artifacts.find((candidate) => candidate.kind === 'research_run')
    ?? item.run.artifacts[0];
  const payload = artifactPayload(artifact?.payload);
  const result = resultPayloadFromArtifact(payload);
  const resultColumns = resultColumnsFromPayload(result);
  const rows = Array.isArray(result?.rows)
    ? result.rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row))).slice(0, 24)
    : [];
  const answerContract = artifactPayload(payload?.contextPack)?.questionPlan ?? payload?.analysisPlan;
  const requestedShape = requestedShapeFromContract(answerContract);
  const resultDimensionValues = collectResultDimensionValues(resultColumns, rows);
  const measureColumns = priorMeasuresFromContext(requestedShape, resultColumns);
  const sourceCertifiedBlock = stringValue(payload?.sourceCertifiedBlock)
    ?? (artifact?.kind === 'answer' ? stringValue(artifact.ref) : undefined)
    ?? stringValue(artifactPayload(payload?.block)?.name);
  return compactRecord({
    id: item.run.id,
    question: item.run.question,
    answerSummary: item.run.answer ?? item.run.summary,
    completedAt: item.run.completedAt,
    artifactKind: artifact?.kind,
    sourceCertifiedBlock,
    route: stringValue(artifactPayload(payload?.route)?.label) ?? stringValue(artifactPayload(payload?.route)?.tier),
    trustLabel: stringValue(payload?.trustLabel),
    reviewStatus: stringValue(payload?.reviewStatus),
    certification: stringValue(payload?.certification),
    contextPackId: stringValue(payload?.contextPackId),
    requestedFilters: stringArray(requestedShape?.filters),
    requestedDimensions: stringArray(requestedShape?.dimensions),
    requestedMeasures: stringArray(requestedShape?.measures),
    answerContract,
    dqlArtifact: dqlArtifactFromPayload(payload),
    cascade: cascadeFromPayload(payload),
    topN: topNFromRequestedShape(requestedShape),
    result: resultColumns.length > 0 || rows.length > 0
      ? compactRecord({
          columns: resultColumns,
          rowsSample: rows,
          dimensionValues: resultDimensionValues,
          measureColumns,
          rowCount: resultRowCount(result),
        })
      : undefined,
    sourceSql: sourceSqlFromPayload(payload, result),
  }) as ConversationStateTurn | undefined;
}

function activeTurnContract(turn: ConversationStateTurn): unknown {
  return turn.answerContract;
}

function requestedShapeFromContract(value: unknown): Record<string, unknown> | undefined {
  const contract = artifactPayload(value);
  return artifactPayload(contract?.requestedShape);
}

function resultPayloadFromArtifact(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const researchRun = artifactPayload(payload?.researchRun);
  const nestedResult = artifactPayload(payload?.result);
  const candidates = [
    payload?.result,
    payload?.resultPreview,
    researchRun?.resultPreview,
    researchRun?.result,
    nestedResult?.result,
  ];
  return candidates
    .map(artifactPayload)
    .filter((candidate): candidate is Record<string, unknown> =>
      Boolean(candidate && (Array.isArray(candidate.rows) || Array.isArray(candidate.columns)))
    )
    .sort((a, b) => rowCountForResult(b) - rowCountForResult(a))[0];
}

function rowCountForResult(result: Record<string, unknown>): number {
  const rows = Array.isArray(result.rows) ? result.rows.length : 0;
  const rowCount = typeof result.rowCount === 'number' && Number.isFinite(result.rowCount) ? result.rowCount : 0;
  return rows * 100000 + rowCount;
}

function resultRowCount(result: Record<string, unknown> | undefined): number | undefined {
  const raw = result?.rowCount;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return Array.isArray(result?.rows) ? result.rows.length : undefined;
}

function sourceSqlFromPayload(
  payload: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(payload?.proposedSql)
    ?? stringValue(payload?.sql)
    ?? stringValue(result?.sql)
    ?? stringValue(artifactPayload(payload?.query)?.sql)
    ?? stringValue(artifactPayload(payload?.plan)?.sql);
}

function dqlArtifactFromPayload(payload: Record<string, unknown> | undefined): AgentConversationDqlArtifact | undefined {
  const artifact = normalizeDqlArtifactReference(payload?.dqlArtifact);
  return artifact ? {
    ...artifact,
    source: artifact.source.slice(0, 3000),
    filters: artifact.filters
      ?.filter((filter) => filter.values.length > 0)
      .slice(0, 12)
      .map((filter) => ({ ...filter, values: filter.values.slice(0, 12) })),
    orderBy: artifact.orderBy?.slice(0, 8),
  } : undefined;
}

function cascadeFromPayload(payload: Record<string, unknown> | undefined): AgentAnswerCascade | undefined {
  const cascade = artifactPayload(payload?.cascade);
  if (!cascade) return undefined;
  const terminalLane = stringValue(cascade.terminalLane);
  const routeTier = stringValue(cascade.routeTier);
  if (!terminalLane && !routeTier) return undefined;
  return {
    terminalLane,
    routeTier,
    label: stringValue(cascade.label),
    ref: stringValue(cascade.ref),
    artifactKind: stringValue(cascade.artifactKind),
    refusalCode: stringValue(cascade.refusalCode),
    outcome: artifactPayload(cascade.outcome),
  };
}

function summarizeConversationTurns(turns: ConversationStateTurn[]): string | undefined {
  const summaries = turns
    .slice(-3)
    .map((turn) => {
      const columns = turn.result?.columns.slice(0, 5).join(', ');
      const values = turn.result?.dimensionValues
        ? Object.entries(turn.result.dimensionValues)
            .slice(0, 3)
            .map(([key, list]) => `${key}: ${list.slice(0, 3).join(', ')}`)
            .join('; ')
        : '';
      return [
        `Q: ${turn.question}`,
        turn.answerSummary ? `A: ${turn.answerSummary}` : '',
        columns ? `Columns: ${columns}` : '',
        values ? `Values: ${values}` : '',
      ].filter(Boolean).join(' | ');
    })
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join('\n') : undefined;
}

function topNFromRequestedShape(shape: Record<string, unknown> | undefined): number | undefined {
  const topN = artifactPayload(shape?.topN);
  const n = topN?.n;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

function priorMeasuresFromContext(
  shape: Record<string, unknown> | undefined,
  resultColumns: string[],
): string[] | undefined {
  const measures = [
    ...(stringArray(shape?.measures) ?? []),
	    ...resultColumns.filter((column) =>
	      /\b(revenue|sales|amount|total|count|average|avg|sum|spend|cost|margin|profit|value|points?|score|quantity|units?|rate|volume)\b/i.test(
	        column.replace(/_/g, ' '),
	      )
    ),
  ];
  const unique = Array.from(new Set(measures.map((value) => value.trim()).filter(Boolean))).slice(0, 12);
  return unique.length > 0 ? unique : undefined;
}

function artifactPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resultColumnsFromPayload(result: Record<string, unknown> | undefined): string[] {
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const fromColumns = columns.map(columnName).filter((value): value is string => Boolean(value));
  const firstRow = Array.isArray(result?.rows)
    ? result.rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown> | undefined
    : undefined;
  const fromRow = firstRow ? Object.keys(firstRow) : [];
  return Array.from(new Set([...fromColumns, ...fromRow])).slice(0, 32);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  const unique = Array.from(new Set(values)).slice(0, 24);
  return unique.length > 0 ? unique : undefined;
}

function columnName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return stringValue(record.name) ?? stringValue(record.field) ?? stringValue(record.key);
  }
  return undefined;
}

function collectResultDimensionValues(columns: string[], rows: unknown[]): Record<string, string[]> | undefined {
  const dimensionColumns = columns.filter((column) =>
    /\b(category|product|customer|account|user|segment|region|channel|type|name)\b/i.test(column.replace(/_/g, ' '))
  ).slice(0, 12);
  const out: Record<string, string[]> = {};
  for (const column of dimensionColumns) {
    const values: string[] = [];
    for (const row of rows) {
      const record = artifactPayload(row);
      const raw = record?.[column];
      const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (!value || values.includes(value)) continue;
      values.push(value);
      if (values.length >= 24) break;
    }
    if (values.length > 0) out[normalizeContextColumn(column)] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeContextColumn(column: string): string {
  const lower = column.toLowerCase();
  if (lower.includes('category')) return 'category';
  if (lower.includes('product')) return lower.includes('name') ? 'product_name' : 'product';
  if (lower.includes('customer')) return lower.includes('name') ? 'customer_name' : 'customer';
  if (lower.includes('segment')) return 'segment';
  if (lower.includes('region')) return 'region';
  if (lower.includes('channel')) return 'channel';
  return lower.replace(/[^a-z0-9_]+/g, '_');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
