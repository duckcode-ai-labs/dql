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
/** A run stopped before it finished, for a person whose needs-review figures the host withholds. */
export const WITHHELD_STOPPED = 'This run was stopped before it finished. What it found needs review before its figures are shown.';

/** Trust labels whose figures HH-14 never withholds (an answer an expert certified, or one from approved metrics). */
const SHOWN_TRUST = new Set(['certified', 'governed', 'grounded']);

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
  for (const [key, value] of Object.entries(run)) if (!key.startsWith('diagnosticReceipt') && !WITHHELD_STATE.has(key)) kept[key] = value;
  const note = run.status === 'cancelled' ? WITHHELD_STOPPED : WITHHELD_ANSWER;
  return {
    ...(kept as unknown as AgentRun),
    summary: note,
    answer: note,
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

/** A run's fields that repeat what it found (the accepted answer text, each task's outcome summary): left out when its figures are withheld. */
const WITHHELD_STATE = new Set(['businessAnswer', 'analyticalTaskOutcomes']);
/** A run in progress also leaves out its working checkpoint, which a reader by id never needs. */
const WITHHELD_PROGRESS_STATE = new Set([...WITHHELD_STATE, 'askAnalystState']);

/**
 * A run in progress, read by id by a person whose needs-review figures the host withholds: its trust is not known
 * until it ends, so nothing that could hold a figure is passed on (as on the stream, eventWithoutFigures).
 */
export function progressWithoutFigures<T extends { steps?: AgentRun['steps']; artifacts?: AgentRun['artifacts']; events?: AgentRun['events']; evaluations?: AgentRun['evaluations'] }>(progress: T): T {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(progress)) if (!WITHHELD_PROGRESS_STATE.has(key)) kept[key] = value;
  return {
    ...(kept as T),
    steps: (progress.steps ?? []).map((step) => {
      const { summary: _summary, ...rest } = step;
      return { ...rest, evaluations: [], artifacts: (step.artifacts ?? []).map(artifactWithoutFigures) };
    }),
    artifacts: (progress.artifacts ?? []).map(artifactWithoutFigures),
    events: (progress.events ?? []).map((event) => eventWithoutFigures(event as Parameters<typeof eventWithoutFigures>[0])) as unknown as AgentRun['events'],
    evaluations: [],
  };
}

function artifactWithoutFigures(artifact: AgentRun['artifacts'][number]): AgentRun['artifacts'][number] {
  const payload = payloadWithoutFigures(artifact.payload);
  const { payloadRef: _ref, payload: _payload, ...rest } = artifact;
  return { ...rest, ...(payload ? { payload } : {}) };
}

/**
 * An AI pin (an answer pinned to an App page, with its stored rows) as a person the host keeps needs-review figures
 * from reads it: a certified pin as it is; any other (AI-written) pin with its question, SQL and result shape only.
 */
export function pinForReader<T extends { certification?: string; answer?: string; result?: unknown }>(pin: T, withheld: boolean): T | (Omit<T, 'evidence' | 'citations' | 'followUps'> & { figuresWithheld: true }) {
  if (!withheld || pin.certification === 'certified') return pin;
  const { evidence: _evidence, citations: _citations, followUps: _followUps, ...rest } = pin as T & { evidence?: unknown; citations?: unknown; followUps?: unknown };
  const shape = previewWithoutFigures(pin.result);
  return { ...rest, answer: WITHHELD_ANSWER, result: shape ?? { columns: [], rowCount: 0, rows: [] }, figuresWithheld: true } as Omit<T, 'evidence' | 'citations' | 'followUps'> & { figuresWithheld: true };
}

/** A result preview without its values: its column names and row count only (rows: []). */
export function previewWithoutFigures(preview: unknown): { columns: string[]; rowCount: number; rows: [] } | undefined {
  const shape = shapeOf(preview);
  return shape ? { columns: shape.columns, rowCount: shape.rowCount, rows: [] } : undefined;
}

/** The fields of a streamed run event that say what happened, never what was found. */
interface StreamedRunEvent {
  id: string;
  runId: string;
  type: string;
  at: string;
  message: string;
  route?: unknown;
  status?: unknown;
  trustState?: unknown;
  payload?: unknown;
}

/**
 * A streamed run event for a person whose needs-review figures the host withholds, sent while the run goes (its
 * trust is not known until the end): its kind, route, status and trust only. Its wording and its payload (an
 * `artifact.created` event carries the whole answer, text and rows) are left out.
 */
export function eventWithoutFigures<T extends StreamedRunEvent>(event: T): T {
  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    at: event.at,
    message: '',
    ...(event.route !== undefined ? { route: event.route } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.trustState !== undefined ? { trustState: event.trustState } : {}),
  } as T;
}

/**
 * The host's answer (HH-14) as DQL reads it: only a clear `show` shows needs-review figures. Anything else — an
 * error, `withhold_review`, or an answer that is not one of the two (undefined, a typo, another type) — withholds.
 */
export function figuresRuleFrom(answer: unknown): 'show' | 'withhold_review' {
  return answer === 'show' ? 'show' : 'withhold_review';
}

/**
 * A run as a person reads it under the host's rule (HH-14, the one decision): unchanged when figures are shown or
 * the run is certified or governed; withheld whole (withholdRunFigures) when it is a needs-review answer or holds a
 * result that is not certified or governed; any other run (stopped, interrupted, blocked, a clarification) keeps
 * its own words but none of its workings (events, evaluations, step notes), which can quote what it read.
 */
export function runForPerson(rule: 'show' | 'withhold_review' | undefined, run: AgentRun): AgentRun {
  if (rule !== 'withhold_review') return run;
  if (shouldWithhold(rule, run)) return withholdRunFigures(run);
  if (SHOWN_TRUST.has(run.trustState) && run.status !== 'cancelled') return run;
  return {
    ...run,
    steps: (run.steps ?? []).map((step) => {
      const { summary: _summary, ...rest } = step;
      return { ...rest, evaluations: [], artifacts: (step.artifacts ?? []).map(artifactWithoutFigures) };
    }),
    events: (run.events ?? []).map((event) => eventWithoutFigures(event as Parameters<typeof eventWithoutFigures>[0])) as unknown as AgentRun['events'],
    evaluations: [],
  };
}

/**
 * Whether a run's figures are withheld under the host's rule for this person: a needs-review answer; and any run
 * whose trust was not settled as certified or governed (stopped, interrupted, blocked) that still holds a result
 * that is not. A certified or governed answer keeps its figures; a clarification or a refusal with no result
 * keeps its words.
 */
export function shouldWithhold(rule: 'show' | 'withhold_review' | undefined, run: Pick<AgentRun, 'trustState'> & Partial<Pick<AgentRun, 'status' | 'artifacts' | 'steps'>>): boolean {
  if (rule !== 'withhold_review') return false;
  if (run.trustState === 'review_required') return true;
  if (SHOWN_TRUST.has(run.trustState) && run.status !== 'cancelled') return false;
  const artifacts = [...(run.artifacts ?? []), ...(run.steps ?? []).flatMap((step) => step.artifacts ?? [])];
  return artifacts.some((artifact) => !SHOWN_TRUST.has(artifact.trustState) && holdsResult(artifact.payload));
}

/** Payload keys whose text is an answer written from what was found. */
const ANSWER_TEXT = ['text', 'answer', 'summary', 'narrative', 'markdown'];

/** Whether an artifact's payload holds a result: rows (at any depth), or an answer's text. A failure's own record does not. */
function holdsResult(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (shapeOf(payload)) return true;
  const record = payload as Record<string, unknown>;
  return ANSWER_TEXT.some((key) => typeof record[key] === 'string' && (record[key] as string).trim() !== '');
}
