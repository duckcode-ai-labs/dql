import { createHash } from 'node:crypto';

/**
 * What a host may keep about one answer when someone asks for it to be
 * checked or certified (RFC 0010 HH-10): the question, the SQL that answered
 * it, the tables it read and the fingerprints and trace that identify it.
 * Never result values, the written answer or rows.
 */
export interface DqlAnswerFacts {
  runId: string;
  question: string;
  status: string;
  trustState: string;
  route: string;
  askedAt: string;
  sql?: string;
  sqlOrigin?: 'executed' | 'failed' | 'proposed' | 'compiled';
  sqlFingerprint?: string;
  tables: string[];
  traceId?: string;
  source?: { kind: string; name: string };
  /** The same identifiers the answer's audit event carries, so a host can find others who got this answer. */
  sqlSha256: string[];
  sources: string[];
}

type AnyRecord = Record<string, unknown>;
const record = (value: unknown): AnyRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** The SQL behind an answer, in the order the Ask screen shows it. */
export function answerSql(run: { artifacts?: unknown[] }): { sql: string; origin: NonNullable<DqlAnswerFacts['sqlOrigin']> } | undefined {
  for (const artifact of run.artifacts ?? []) {
    const payload = record(record(artifact)?.payload) ?? {};
    const result = record(payload.result);
    const researchRun = record(payload.researchRun);
    const dqlArtifact = record(payload.dqlArtifact);
    const executed = text(result?.sql);
    if (executed) return { sql: executed, origin: 'executed' };
    const failed = text(payload.executionError) ? text(payload.sql) : undefined;
    if (failed) return { sql: failed, origin: 'failed' };
    const proposed = text(payload.proposedSql) ?? text(researchRun?.generatedSql) ?? text(researchRun?.reviewedSql);
    if (proposed) return { sql: proposed, origin: 'proposed' };
    const compiled = text(payload.sql) ?? text(payload.sqlPreview) ?? text(dqlArtifact?.compiledSql);
    if (compiled) return { sql: compiled, origin: 'compiled' };
  }
  return undefined;
}

const IDENTIFIER = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const RELATION = new RegExp(String.raw`\b(?:from|join)\s+(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER}){0,2})`, 'gi');

/** Tables a statement reads, best effort, without the names of its own CTEs. */
export function tablesRead(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const ctes = new Set<string>();
  for (const match of withoutComments.matchAll(new RegExp(String.raw`(?:with|,)\s*(?:recursive\s+)?(${IDENTIFIER})\s*(?:\([^)]*\)\s*)?as\s*\(`, 'gi'))) {
    ctes.add(unquote(match[1]).toLowerCase());
  }
  const tables = new Set<string>();
  for (const match of withoutComments.matchAll(RELATION)) {
    const name = match[1].split(/\s*\.\s*/).map(unquote).join('.');
    if (!ctes.has(name.toLowerCase()) && !/^(select|lateral|unnest)$/i.test(name)) tables.add(name);
  }
  return [...tables].sort();
}

function unquote(part: string): string {
  return part.replace(/^["`[]|["`\]]$/g, '');
}

/** SQL hashes and source ids of a run, computed exactly as its audit event does (observability.ts). */
export function answerIdentities(run: { artifacts?: unknown[] }): { sqlSha256: string[]; sources: string[] } {
  const sql = new Set<string>();
  const sources = new Set<string>();
  for (const artifact of run.artifacts ?? []) {
    const item = record(artifact) ?? {};
    const payload = record(item.payload) ?? {};
    for (const key of ['sql', 'executedSql', 'proposedSql']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) sql.add(createHash('sha256').update(value).digest('hex'));
    }
    for (const value of [item.sourceId, payload.sourceId, payload.blockId, payload.datasetId]) {
      if (typeof value === 'string' && value) sources.add(value);
    }
  }
  return { sqlSha256: [...sql].sort(), sources: [...sources].sort() };
}

export function answerFactsFromRun(run: AnyRecord): DqlAnswerFacts {
  const sql = answerSql(run as { artifacts?: unknown[] });
  const receipt = record(run.diagnosticReceiptV9);
  const executed = record(receipt?.executed);
  const trace = record(run.traceReference);
  const selected = record(run.selectedObject);
  const sourceName = text(selected?.title) ?? text(selected?.id) ?? text(selected?.path);
  return {
    runId: String(run.id),
    question: String(run.question ?? ''),
    status: String(run.status ?? ''),
    trustState: String(run.trustState ?? ''),
    route: String(run.route ?? ''),
    askedAt: String(run.startedAt ?? ''),
    ...(sql ? { sql: sql.sql, sqlOrigin: sql.origin } : {}),
    ...(text(executed?.sqlFingerprint)
      ? { sqlFingerprint: text(executed?.sqlFingerprint)! }
      : sql ? { sqlFingerprint: `sha256:${createHash('sha256').update(sql.sql).digest('hex')}` } : {}),
    tables: sql ? tablesRead(sql.sql) : [],
    ...(text(trace?.traceId) ? { traceId: text(trace?.traceId)! } : {}),
    ...(sourceName ? { source: { kind: String(selected?.kind ?? 'object'), name: sourceName } } : {}),
    ...answerIdentities(run as { artifacts?: unknown[] }),
  };
}

/**
 * HH-10 follow-up: an answer's own values, for its owner, when a host asks
 * for them (`GET /api/host/answers/:runId?values=1`) — e.g. to show the
 * person the figures in Slack. The first table the answer holds (at most
 * `limit` rows) and its written answer; nothing when the host withheld the
 * figures from this person (HH-14).
 */
export function answerValuesFromRun(run: Record<string, unknown>, limit = 500): { answer: string | null; result: { columns: string[]; rows: unknown[]; rowCount: number; truncated: boolean } | null; figuresWithheld: boolean } {
  if (run.figuresWithheld === true) return { answer: null, result: null, figuresWithheld: true };
  const answer = typeof run.answer === 'string' && run.answer ? run.answer : null;
  for (const artifact of Array.isArray(run.artifacts) ? run.artifacts : []) {
    const payload = record(record(artifact)?.payload) ?? {};
    const result = record(payload.result);
    if (result && Array.isArray(result.rows)) {
      const columns = (Array.isArray(result.columns) ? result.columns : []).map((column) => (typeof column === 'string' ? column : text(record(column)?.name) ?? '')).filter(Boolean);
      const rows = result.rows as unknown[];
      return { answer, result: { columns, rows: rows.slice(0, limit), rowCount: rows.length, truncated: rows.length > limit }, figuresWithheld: false };
    }
  }
  return { answer, result: null, figuresWithheld: false };
}
