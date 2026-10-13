import type { AskPipelineReceiptV9 } from '@duckcodeailabs/dql-agent';

/**
 * RFC 0010: AN ASK TRACE AS SOMEONE OTHER THAN THE ASKER READS IT.
 *
 * With a host, a person who reviews answers (`hint.review`, a steward or an
 * admin) may open anyone's trace to curate hints. They see how the question
 * was answered, never what the warehouse said: the detail is REBUILT from an
 * allowlist, not stripped field by field. Receipts quote values in many places
 * (member grounding, intent filters, proofs, check messages, model replies,
 * Research headlines, SQL literals), and a field added tomorrow is left out
 * until it is classified here.
 *
 * Kept: the trace store's own records (envelope, spans, candidate decisions,
 * links; identifiers, fingerprints, timings and codes by design), the V4
 * decision summary, and a reduced pipeline receipt and answer: stage and tier
 * names, outcomes and refusal codes, timings and counts, the refs the reading
 * used, the tables and joins, the SQL with every literal masked, columns and
 * the row count. Everything else, including the V5, V6 and V8 receipts, is
 * left out.
 */

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
/** A short code or enum value (`no_certified_block`, `exploratory`, `prepared`). */
const code = (value: unknown): string | undefined => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : undefined);
/** An identifier slot: a ref, a relation or column name, a fingerprint. No spaces, no string quotes. */
const ident = (value: unknown): string | undefined => (typeof value === 'string' && /^[A-Za-z0-9_.:@/$"`[\]-]{1,300}$/.test(value) ? value : undefined);
const idents = (value: unknown): string[] => arr(value).map(ident).filter((item): item is string => Boolean(item));
const defined = <T extends Rec>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
const numbers = (value: unknown): Record<string, number> | undefined => {
  const record = rec(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) if (code(key) && num(item) !== undefined) out[key] = num(item)!;
  return out;
};

// ── SQL ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Engines where `"…"` is always an identifier; on any other (or an unknown) engine it may be a string and is masked. */
const DOUBLE_QUOTE_IDENTIFIER_ENGINES = new Set(['duckdb', 'motherduck', 'postgres', 'postgresql', 'redshift', 'snowflake', 'trino', 'presto', 'athena', 'clickhouse', 'sqlserver', 'mssql', 'fabric', 'synapse', 'oracle']);
/** Engines with `'''…'''` strings (BigQuery). */
const TRIPLE_QUOTE_ENGINES = new Set(['bigquery']);

interface LiteralReading { backslash: boolean; doubleQuoteString: boolean; tripleQuote: boolean }

/** Marks the contents of every string literal, quoted string, dollar-quoted string and comment under one reading of the SQL. */
function markLiterals(sql: string, masked: Uint8Array, reading: LiteralReading): void {
  const n = sql.length;
  const mark = (from: number, to: number) => { for (let k = Math.max(0, from); k < Math.min(n, to); k += 1) masked[k] = 1; };
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      const stop = end < 0 ? n : end;
      mark(i + 2, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end;
      mark(i + 2, stop);
      i = stop + 2;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? n : end;
        mark(i + tag.length, stop);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (c === '`') {
      const end = sql.indexOf('`', i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"' && !reading.doubleQuoteString) {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      if (reading.tripleQuote && sql.startsWith(c.repeat(3), i)) {
        const end = sql.indexOf(c.repeat(3), i + 3);
        const stop = end < 0 ? n : end;
        mark(i + 3, stop);
        i = end < 0 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const ch = sql[j]!;
        if (reading.backslash && ch === '\\') { j += 2; continue; }
        if (ch === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      mark(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
}

const NUMBER = /(?<![A-Za-z0-9_$"`])(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$])/g;

/**
 * A statement with every literal masked: the contents of each string (`'?'`), each number (`?`), each comment.
 * Which quotes and escapes make a string differs by dialect, so the SQL is read every way it could be (with and
 * without backslash escapes; `"…"` as a string unless the engine is known to quote identifiers with it; BigQuery's
 * triple quotes) and whatever is a literal in ANY reading is masked. Reading too much as a literal only hides more.
 */
export function maskSqlLiterals(sql: string, engine?: string): string {
  const name = (engine ?? '').toLowerCase();
  const masked = new Uint8Array(sql.length);
  const doubleQuote = DOUBLE_QUOTE_IDENTIFIER_ENGINES.has(name) ? [false] : [false, true];
  const triple = !name || TRIPLE_QUOTE_ENGINES.has(name) ? [false, true] : [false];
  for (const backslash of [false, true]) for (const doubleQuoteString of doubleQuote) for (const tripleQuote of triple) markLiterals(sql, masked, { backslash, doubleQuoteString, tripleQuote });
  for (const match of sql.matchAll(NUMBER)) {
    const start = match.index ?? 0;
    for (let k = start; k < start + match[0].length; k += 1) masked[k] = 1;
  }
  let out = '';
  for (let k = 0; k < sql.length; k += 1) {
    if (!masked[k]) out += sql[k];
    else if (!masked[k - 1] || k === 0) out += '?';
  }
  return out;
}

// ── The pipeline receipt ───────────────────────────────────────────────────────────────────────────────────

/**
 * How each field of the Ask pipeline's receipt reaches a reviewer: kept as it is (codes, counts, timings only),
 * reduced (rebuilt from an allowlist of its own), or dropped. Every field must be named: a field added to the
 * receipt fails the typecheck until it is classified here (and `trace-review.test.ts` checks a real run's receipt).
 */
export const RECEIPT_V9_FIELDS: Record<keyof AskPipelineReceiptV9, 'keep' | 'reduce' | 'drop'> = {
  version: 'keep',
  vocabularyFingerprint: 'keep',
  intent: 'reduce', // refs, roles, grains and operators; never filter values, the reading or a reply
  reading: 'drop', // the question read back in words: can repeat its values
  dispatches: 'reduce', // what each AI call was for and how long it took; never its reply
  candidates: 'reduce', // tier, trust, SQL fingerprint, engine; never the proofs
  checks: 'reduce', // which check, passed or not; never its message
  refusals: 'reduce', // tier and code; never the verbatim message
  tiers: 'reduce', // round, tier, outcome; never the detail
  executed: 'reduce', // tier, SQL fingerprint, row count, time; never the proofs
  timings: 'keep',
  reuse: 'keep',
  build: 'drop',
  uncovered: 'drop', // question words
  outOfScope: 'drop', // words or refs the question named
  coverage: 'drop', // question words
  grounding: 'drop', // member values matched in the warehouse
  failure: 'reduce', // stage, reason code, the warehouse's failure class; never the message
  warehouse: 'keep',
  lastCompletedPhase: 'keep',
  physicalBindings: 'reduce', // relation, completeness, column count, target fingerprint
  unmet: 'reduce', // the obligation and refs; never the message
  ledger: 'drop', // the question's clauses in words
  context: 'reduce', // counts, timings, ids; the tables and joins used; never required-filter text
  policies: 'reduce',
  story: 'reduce', // phase, state, timings; titles replaced by the phase's own words, never details
  investigation: 'drop', // a Research run's queries, each with its own receipt, and its report
};

const STORY_TITLES: Record<string, string> = {
  context: 'Gathered the project context', read: 'Read the question', search: 'Searched the project', tier: 'Tried a governed tier',
  join: 'Chose the joins', schema: 'Wrote SQL from the tables', execute: 'Ran on the warehouse', frame: 'Framed the change',
  check: 'Checked the data', analyze: 'Analysed it', drill: 'Drilled in', verdict: 'Weighed the evidence', report: 'Wrote the report',
};

const CHECK_LABELS: Record<string, string> = {
  catalog_columns: 'Uses only tables and columns the project lists',
  stated_values: 'Applies every value the question states',
  required_filters: 'Applies the required filters',
  join_fanout: 'Joins do not count rows more than once',
  certified_joins: 'Joins certified tables on their certified keys',
  read_only: 'Is one read-only statement',
};

function reducedIntent(value: unknown): Rec | undefined {
  const intent = rec(value);
  if (!intent) return undefined;
  const predicate = (item: unknown) => { const p = rec(item); return p && ident(p.ref) ? defined({ ref: ident(p.ref), op: code(p.op), on: code(p.on) }) : undefined; };
  const measures = arr(intent.measures).map(rec).filter((item): item is Rec => Boolean(item)).map((measure) => defined({
    ref: ident(measure.ref), aggregation: code(measure.aggregation), alias: ident(measure.alias),
    scope: arr(measure.scope).map(predicate).filter(Boolean),
  }));
  const time = rec(intent.time);
  const ordering = rec(intent.ordering);
  return defined({
    version: num(intent.version),
    kind: code(intent.kind),
    measures,
    groupBy: arr(intent.groupBy).map(rec).filter((item): item is Rec => Boolean(item)).map((group) => defined({ ref: ident(group.ref), role: code(group.role), grain: code(group.grain) })),
    display: idents(intent.display),
    filters: arr(intent.filters).map(predicate).filter(Boolean),
    ...(ordering ? { ordering: defined({ ref: ident(ordering.ref), direction: code(ordering.direction) }) } : {}),
    ...(time ? { time: defined({ ref: ident(time.ref), grain: code(time.grain) }) } : {}),
    limit: num(intent.limit),
    expectedShape: code(intent.expectedShape),
    population: code(intent.population),
  });
}

function reducedContext(value: unknown): Rec | undefined {
  const context = rec(value);
  if (!context) return undefined;
  const admitted = rec(context.admitted);
  const rendered = rec(context.rendered);
  const selected = rec(context.selected);
  const enforced = rec(context.enforced);
  const used = rec(context.used);
  const retrieved = rec(context.retrieved);
  const envelope = rec(context.envelope);
  return defined({
    version: num(context.version),
    timings: numbers(context.timings),
    packId: ident(context.packId),
    snapshotId: ident(context.snapshotId),
    ...(envelope ? { envelope: defined({ activeDomain: ident(envelope.activeDomain), source: code(envelope.source), confidence: code(envelope.confidence) }) } : {}),
    ...(retrieved ? { retrieved: defined({ lanes: numbers(retrieved.lanes), fused: num(retrieved.fused) }) } : {}),
    ...(admitted ? { admitted: defined({ byKind: numbers(admitted.byKind), dropped: numbers(admitted.dropped), unindexed: numbers(admitted.unindexed) }) } : {}),
    ...(rendered ? { rendered: defined({ byKind: numbers(rendered.byKind), totalChars: num(rendered.totalChars), skills: idents(rendered.skills), hints: idents(rendered.hints) }) } : {}),
    ...(selected ? { selected: defined({ refs: idents(selected.refs), byKind: numbers(selected.byKind) }) } : {}),
    ...(enforced ? {
      enforced: {
        policies: arr(enforced.policies).map(rec).filter((item): item is Rec => Boolean(item)).map((item) => defined({ policyId: ident(item.policyId), field: ident(item.field), effect: code(item.effect) })),
        requiredFilterCount: arr(enforced.requiredFilters).length,
      },
    } : {}),
    suggestedDomain: ident(context.suggestedDomain),
    ...(used ? {
      used: defined({
        relations: idents(used.relations),
        tier: code(used.tier),
        engine: code(used.engine),
        joins: arr(used.joins).map(rec).filter((join): join is Rec => Boolean(join)).map((join) => defined({
          source: ident(join.source), relationshipId: ident(join.relationshipId), name: ident(join.name), authority: code(join.authority), scope: code(join.scope),
          relations: idents(join.relations),
          keys: arr(join.keys).map(rec).filter((key): key is Rec => Boolean(key)).map((key) => defined({ from: ident(key.from), to: ident(key.to) })),
        })),
      }),
    } : {}),
  });
}

/** The pipeline receipt with only structural, value-free fields (RECEIPT_V9_FIELDS). Unknown fields are left out. */
export function reviewerReceiptV9(value: unknown): Rec | undefined {
  const receipt = rec(value);
  if (!receipt) return undefined;
  const out: Rec = {};
  const executed = rec(receipt.executed);
  const failure = rec(receipt.failure);
  for (const [field, how] of Object.entries(RECEIPT_V9_FIELDS) as Array<[keyof AskPipelineReceiptV9, string]>) {
    if (how === 'drop' || receipt[field] === undefined) continue;
    const item = receipt[field];
    switch (field) {
      case 'version': out.version = num(item); break;
      case 'vocabularyFingerprint': out.vocabularyFingerprint = ident(item); break;
      case 'timings': out.timings = numbers(item); break;
      case 'reuse': out.reuse = code(item); break;
      case 'lastCompletedPhase': out.lastCompletedPhase = code(item); break;
      case 'warehouse': { const w = rec(item); if (w) out.warehouse = defined({ attempts: num(w.attempts), failures: num(w.failures), executions: num(w.executions) }); break; }
      case 'intent': out.intent = reducedIntent(item); break;
      case 'dispatches':
        out.dispatches = arr(item).map(rec).filter((call): call is Rec => Boolean(call)).map((call) => defined({
          purpose: code(call.purpose), ms: num(call.ms), promptChars: num(call.promptChars), at: num(call.at), attempt: num(call.attempt), label: code(call.label), outcome: code(call.outcome),
        }));
        break;
      case 'candidates':
        out.candidates = arr(item).map(rec).filter((c): c is Rec => Boolean(c)).map((c) => defined({ tier: code(c.tier), trust: code(c.trust), sqlFingerprint: ident(c.sqlFingerprint), engine: code(c.engine) }));
        break;
      case 'checks':
        out.checks = arr(item).map(rec).filter((c): c is Rec => Boolean(c)).map((c) => defined({ id: code(c.id), label: CHECK_LABELS[String(c.id)] ?? 'Check', passed: bool(c.passed), attempt: num(c.attempt) }));
        break;
      case 'refusals':
        out.refusals = arr(item).map(rec).filter((r): r is Rec => Boolean(r)).map((r) => defined({ tier: code(r.tier), code: code(r.code), repairable: bool(r.repairable) }));
        break;
      case 'tiers':
        out.tiers = arr(item).map(rec).filter((t): t is Rec => Boolean(t)).map((t) => defined({ round: num(t.round), tier: code(t.tier), outcome: code(t.outcome) }));
        break;
      case 'executed':
        if (executed) out.executed = defined({ tier: code(executed.tier), sqlFingerprint: ident(executed.sqlFingerprint), rowCount: num(executed.rowCount), ms: num(executed.ms), proofs: [] });
        break;
      case 'failure':
        if (failure) out.failure = defined({ stage: code(failure.stage), reason: code(failure.reason), ...(rec(failure.warehouse) ? { warehouse: defined({ class: code(rec(failure.warehouse)!.class) }) } : {}) });
        break;
      case 'physicalBindings':
        out.physicalBindings = arr(item).map(rec).filter((b): b is Rec => Boolean(b)).map((b) => defined({ relation: ident(b.relation), completeness: code(b.completeness), columns: num(b.columns), targetFingerprint: ident(b.targetFingerprint) }));
        break;
      case 'unmet':
        out.unmet = arr(item).map(rec).filter((u): u is Rec => Boolean(u)).map((u) => defined({ obligation: code(u.obligation), refs: idents(u.refs) }));
        break;
      case 'context': out.context = reducedContext(item); break;
      case 'policies':
        out.policies = arr(item).map(rec).filter((p): p is Rec => Boolean(p)).map((p) => defined({ policyId: ident(p.policyId), field: ident(p.field), effect: code(p.effect) }));
        break;
      case 'story':
        out.story = arr(item).map(rec).filter((s): s is Rec => Boolean(s) && typeof s!.at === 'number').map((s) => defined({
          version: num(s.version), phase: code(s.phase), title: STORY_TITLES[String(s.phase)] ?? 'A step', state: code(s.state), ms: num(s.ms), at: num(s.at), programId: ident(s.programId), queryId: ident(s.queryId),
        }));
        break;
      default: break;
    }
  }
  return defined(out);
}

// ── The answer and the whole detail ────────────────────────────────────────────────────────────────────────

/** The answer a trace explains (runtimeAnswerV1), reduced: how the turn ended, the SQL with its literals masked, columns, row count. */
export function reviewerAnswer(value: unknown, engine?: string): Rec | undefined {
  const answer = rec(value);
  if (!answer) return undefined;
  const gap = rec(answer.gap);
  const dql = rec(answer.dqlArtifact);
  const columns = arr(answer.columns).map((column) => (typeof column === 'string' ? column : rec(column)?.name)).map(ident).filter((name): name is string => Boolean(name));
  return defined({
    status: code(answer.status),
    ...(gap ? { gap: defined({ kind: code(gap.kind) }) } : {}),
    failedStage: code(answer.failedStage),
    ...(typeof answer.executionError === 'string' ? { executionErrorWithheld: true } : {}),
    certifiedBlockRef: ident(answer.certifiedBlockRef),
    ...(typeof answer.sql === 'string' ? { sql: maskSqlLiterals(answer.sql, engine), sqlLiteralsMasked: true } : {}),
    ...(Array.isArray(answer.sqlParams) ? { sqlParamCount: answer.sqlParams.length } : {}),
    ...(dql ? { dqlArtifact: defined({ kind: code(dql.kind), name: ident(dql.name), metrics: idents(dql.metrics), dimensions: idents(dql.dimensions) }) } : {}),
    columns,
    rowCount: num(answer.rowCount),
    ...(Array.isArray(answer.evaluations) ? {
      evaluations: answer.evaluations.map(rec).filter((e): e is Rec => Boolean(e)).map((e) => defined({ id: code(e.id), passed: bool(e.passed) })),
    } : {}),
  });
}

/** The trace detail's own top-level fields a reviewer gets; anything else (V5, V6 and V8 receipts, new fields) is left out. */
export const REVIEWER_TRACE_FIELDS = ['envelope', 'spans', 'candidateDecisions', 'links', 'decisionSummary', 'runtimeReceiptV9', 'runtimeAnswerV1', 'runtimeMode'] as const;

/** The trace detail as a reviewer who is not the asker reads it: rebuilt from REVIEWER_TRACE_FIELDS, with `valuesWithheld: true`. */
export function traceDetailForReviewer(detail: Rec): Rec {
  const receipt = rec(detail.runtimeReceiptV9);
  const context = rec(receipt?.context);
  const engine = code(rec(context?.used)?.engine) ?? arr(receipt?.candidates).map((c) => code(rec(c)?.engine)).find(Boolean);
  const out: Rec = { valuesWithheld: true };
  for (const field of REVIEWER_TRACE_FIELDS) {
    if (detail[field] === undefined) continue;
    if (field === 'runtimeReceiptV9') out[field] = reviewerReceiptV9(detail[field]);
    else if (field === 'runtimeAnswerV1') out[field] = reviewerAnswer(detail[field], engine);
    else if (field === 'runtimeMode') out[field] = code(detail[field]);
    else out[field] = detail[field];
  }
  return defined(out);
}
