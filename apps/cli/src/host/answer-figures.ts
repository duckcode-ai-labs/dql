import type { AgentRun } from '@duckcodeailabs/dql-agent';

/**
 * RFC 0010 HH-14: A HOST CAN KEEP A NEEDS-REVIEW ANSWER'S FIGURES FROM A
 * PERSON (say, a stakeholder) until someone checks it. The run such a person
 * gets — and the one DQL stores for them — is rebuilt from an allowlist: what
 * the answer is, how it was made and what it read, never a value. Answer text,
 * result rows, step details, events, evaluations and receipts (which can quote
 * samples) are all left out.
 */
export const WITHHELD_ANSWER = 'This answer needs review before its figures are shown. Ask an analyst to check it, or ask for a certified answer.';

/** Payload keys that say how an answer was made, never what it found. */
const KEEP_STRING = new Set(['sql', 'executedSql', 'proposedSql', 'sqlPreview', 'compiledSql', 'generatedSql', 'reviewedSql', 'sqlFingerprint', 'sourceId', 'blockId', 'datasetId', 'source', 'sourcePath', 'dialect', 'engine', 'tier', 'route', 'kind', 'name', 'ref', 'persistence', 'trustState']);
/** Nested records whose SQL keys matter to the host's answer facts (RFC 0010 HH-10). */
const KEEP_NESTED = ['dqlArtifact', 'researchRun'];
const KEEP_LIST = new Set(['sources', 'tables', 'relations']);

function columnNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map((column) => (typeof column === 'string' ? column : column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string' ? (column as { name: string }).name : '')).filter(Boolean) : [];
}

/** The first table-shaped result in a payload: its column names and row count, not its rows. */
function shapeOf(value: unknown, depth = 0): { columns: string[]; rowCount: number } | null {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.rows)) return { columns: columnNames(record.columns), rowCount: typeof record.rowCount === 'number' ? record.rowCount : record.rows.length };
  for (const item of Object.values(record)) {
    const found = shapeOf(item, depth + 1);
    if (found) return found;
  }
  return null;
}

export function payloadWithoutFigures(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (KEEP_STRING.has(key) && typeof value === 'string') out[key] = value;
    else if (KEEP_LIST.has(key) && Array.isArray(value)) out[key] = value.filter((item) => typeof item === 'string');
  }
  for (const key of KEEP_NESTED) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const kept = Object.fromEntries(Object.entries(nested as Record<string, unknown>).filter(([name, value]) => KEEP_STRING.has(name) && typeof value === 'string'));
      if (Object.keys(kept).length) out[key] = kept;
    }
  }
  const shape = shapeOf(record);
  const result = record.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : undefined;
  if (shape || result) {
    out.result = {
      ...(shape ? { columns: shape.columns, rowCount: shape.rowCount } : {}),
      rows: [],
      ...(typeof result?.sql === 'string' ? { sql: result.sql } : {}),
      ...(typeof result?.sqlFingerprint === 'string' ? { sqlFingerprint: result.sqlFingerprint } : {}),
    };
  }
  return out;
}

/** The run a person gets when the host withholds a needs-review answer's figures from them. */
export function withholdRunFigures(run: AgentRun): AgentRun {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(run)) if (!key.startsWith('diagnosticReceipt')) kept[key] = value;
  return {
    ...(kept as unknown as AgentRun),
    summary: WITHHELD_ANSWER,
    answer: WITHHELD_ANSWER,
    figuresWithheld: true,
    steps: (run.steps ?? []).map((step) => {
      const { summary: _summary, ...rest } = step;
      return { ...rest, evaluations: [], artifacts: (step.artifacts ?? []).map(artifactWithoutFigures) };
    }),
    events: [],
    evaluations: [],
    artifacts: (run.artifacts ?? []).map(artifactWithoutFigures),
  };
}

function artifactWithoutFigures(artifact: AgentRun['artifacts'][number]): AgentRun['artifacts'][number] {
  const payload = payloadWithoutFigures(artifact.payload);
  const { payloadRef: _ref, payload: _payload, ...rest } = artifact;
  return { ...rest, ...(payload ? { payload } : {}) };
}

/** Whether a finished run's figures are withheld under the host's rule for this person. */
export function shouldWithhold(rule: 'show' | 'withhold_review' | undefined, run: Pick<AgentRun, 'trustState'>): boolean {
  return rule === 'withhold_review' && run.trustState === 'review_required';
}
