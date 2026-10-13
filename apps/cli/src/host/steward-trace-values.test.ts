import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * Ask observability with a host: a steward (`hint.review`) who opens another person's trace to review hints reads it
 * rebuilt from an allowlist (trace-review.ts). Here the answer and its pipeline receipt carry a canary in EVERY place a
 * receipt is known to quote a value: member grounding, intent filters and scopes, the reading and a model reply, AI
 * call replies, proofs, check messages, refusal and tier details, the failure message, unmet obligations, the clause
 * ledger, required-filter text, question words, a Research run's story (its report headline) and investigation, and
 * the answer's rows, parameters, error text, evaluation messages, gap message and DQL filters and compiled SQL. A
 * field the receipt does not have yet is in there too. Not one canary may reach the steward; the asker keeps them all.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, sam };
const CANARY = /CANARY|98765\.43/;
const c = (where: string) => `CANARY-${where}`;

const servers: Server[] = [];
let projectRoot = '';
let base = '';
const runs: Record<string, string> = {};

const call = async (person: string, path: string) => {
  const response = await fetch(`${base}${path}`, { headers: { 'x-test-person': person } });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, text, body: parsed };
};

const filter = (where: string) => ({ ref: 'dimension:customers.customer_name', op: 'eq', values: [c(where)], source: 'question' });
const receipt = {
  version: 1,
  vocabularyFingerprint: 'sha256:vocab',
  intent: {
    version: 1, kind: 'analytics', reading: c('READING'), reply: c('INTENT-REPLY'),
    measures: [{ ref: 'metric:orders.order_total', scope: [filter('SCOPE')], alias: 'order_total' }],
    groupBy: [{ ref: 'entity:customers.customer', role: 'key' }], display: ['dimension:customers.customer_name'],
    filters: [filter('FILTER')], expectedShape: 'ranking', unresolved: [{ clause: c('UNRESOLVED'), options: [], material: true }], provenance: { 'metric:orders.order_total': `q:${c('PROVENANCE')}` },
    time: { ref: 'dimension:orders.ordered_at', grain: 'month', window: { start: '2025-01-01', end: '2026-01-01', expression: c('WINDOW') } },
  },
  reading: c('RECEIPT-READING'),
  dispatches: [{ purpose: 'intent:resolve', ms: 12, reply: c('RESOLVE-REPLY'), label: 'read', attempt: 1 }, { purpose: 'intent:draft', ms: 30, reply: `SELECT * FROM t WHERE name = '${c('DRAFT-REPLY')}'`, label: 'draft', outcome: 'sql' }],
  candidates: [{ tier: 'exploratory', trust: 'review_required', proof: [`applied on the data: customer_name = ${c('CANDIDATE-PROOF')}`], sqlFingerprint: 'sha256:sql', engine: 'duckdb' }],
  checks: [{ id: 'stated_values', label: c('CHECK-LABEL'), passed: true, message: `applies '${c('CHECK-MESSAGE')}'`, attempt: 1 }],
  refusals: [{ tier: 'semantic', code: 'not_semantic', message: c('REFUSAL-MESSAGE'), repairable: false }],
  tiers: [{ round: 1, tier: 'semantic', outcome: 'refused', detail: c('TIER-DETAIL') }, { round: 97, tier: 'exploratory', outcome: 'prepared' }],
  executed: { tier: 'exploratory', sqlFingerprint: 'sha256:sql', rowCount: 1, ms: 4, proofs: [`applied on the data: customer_name = ${c('EXECUTED-PROOF')}`] },
  timings: { resolve: 12, total: 50 },
  reuse: 'none',
  build: { note: c('BUILD') },
  uncovered: [c('UNCOVERED')],
  outOfScope: [{ ref: c('OUT-OF-SCOPE') }],
  coverage: [{ word: c('COVERAGE'), state: 'uncertain' }],
  grounding: [`customer_name: "x" is stored as "${c('GROUNDING')}"`, `discovery: ${c('DISCOVERY')}`],
  failure: { stage: 'execute', reason: 'sql_error', message: c('FAILURE-MESSAGE'), problems: [{ path: 'x', message: c('PROBLEM') }], warehouse: { class: 'sql_error', message: c('WAREHOUSE-MESSAGE') } },
  warehouse: { attempts: 1, failures: 0, executions: 1 },
  lastCompletedPhase: 'execute',
  physicalBindings: [{ relation: '"jaffle_shop"."dev"."customers"', completeness: 'complete', columns: 4, targetFingerprint: 'sha256:t' }],
  unmet: [{ obligation: 'display_label', message: c('UNMET'), refs: ['dimension:customers.customer_name'] }],
  ledger: { clauses: [{ clause: c('LEDGER') }], measures: [], entries: [] },
  context: {
    version: 1, timings: { relevance: 3 },
    enforced: { policies: [], requiredFilters: [`region = '${c('REQUIRED-FILTER')}'`], gaps: [c('GAP')] },
    rendered: { byKind: { metric: 2 }, charsByKind: {}, totalChars: 10, truncated: [], skills: ['skill:x'], hints: ['hint:h1', c('HINT TEXT with space')] },
    used: { joins: [{ source: 'ai', authority: 'none', relations: ['orders', 'customers'], keys: [{ from: 'customer_id', to: 'customer_id' }] }], relations: ['"jaffle_shop"."dev"."orders"'], tier: 'exploratory', engine: 'duckdb' },
  },
  policies: [{ policyId: 'policy:p', field: 'region', effect: 'required_filter' }],
  story: [
    { version: 1, phase: 'report', title: `Revenue fell 98765.43 at ${c('STORY-TITLE')}`, detail: `latest month with data is ${c('STORY-DETAIL')}; coverage 87%`, state: 'done', at: 1 },
    // A Research drill program is named after the member it drills into.
    { version: 1, phase: 'drill', title: 'Drilled in', programId: `drill:${c('DRILL-MEMBER')}:dimension:customers.customer_name`, queryId: `q:${c('DRILL-QUERY')}`, state: 'done', at: 2 },
    { version: 1, phase: 'execute', title: 'Ran it', state: 'done', ms: 4, at: 3 },
  ],
  investigation: { headline: { text: `Revenue fell ${c('HEADLINE')}` }, queries: [{ receipt: { grounding: [c('INVESTIGATION-GROUNDING')] } }] },
  aFieldAddedTomorrow: c('NEW-FIELD'),
};

const answerExecutor = ((input: { request: { question: string } }) => ({
  summary: `Answer to ${input.request.question}`,
  answer: `The largest open claim is ${c('ANSWER-TEXT')}.`,
  status: 'completed',
  trustState: 'review_required',
  stopReason: 'generated_answer',
  askPipelineReceipt: receipt,
  artifacts: [{
    id: 'answer-1', kind: 'answer', title: 'Answer', trustState: 'review_required',
    payload: {
      text: 'ok',
      sql: `SELECT member_name, open_amount AS CANARY_ALIAS FROM claims WHERE adjuster_id = ? AND region IN ('${c('SQL-IN-1')}', '${c('SQL-IN-2')}') AND note = 'it''s ${c('SQL-QUOTED')}' -- ${c('SQL-COMMENT')}\nORDER BY open_amount DESC LIMIT 98765`,
      sqlParams: [c('PARAM')],
      executionError: `Could not convert string '${c('ERROR')}' to INT32`,
      failedStage: 'execute',
      gap: { kind: 'not_retrieved', message: `no stored value matches "${c('GAP-MESSAGE')}"` },
      proof: [`applied on the data: member_name = ${c('PROOF')}`],
      dqlArtifact: { kind: 'semantic', name: 'q', metrics: ['order_total'], dimensions: ['customer_name'], filters: [{ values: [c('DQL-FILTER')] }], compiledSql: `SELECT 1 WHERE x = '${c('COMPILED')}'`, source: c('DQL-SOURCE') },
      result: { columns: ['member_name', 'open_amount'], rows: [{ member_name: c('ROW'), open_amount: 98765.43 }], rowCount: 1 },
    },
  }],
  evaluations: [{ id: 'pipeline-preparation', label: 'Prepared', passed: true, severity: 'info', message: c('EVALUATION') }],
  nextActions: [],
})) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-steward-trace-values-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'steward-trace-values' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    agentRunExecutors: { conversation: answerExecutor, generated_answer: answerExecutor, semantic_answer: answerExecutor, certified_answer: answerExecutor },
    hostHooks: {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      authorize: (principal, action) => ({ allow: action !== 'hint.review' || principal.id === sam.id, reason: 'Only a steward may review.' }),
    },
    captureServer: (created) => { servers.push(created); },
  });
  base = `http://127.0.0.1:${port}`;
  for (const person of ['wes', 'sam']) {
    const response = await fetch(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-person': person },
      body: JSON.stringify({ question: `Which member has the largest open claim for ${person}?` }),
    });
    const body = await response.json() as { run?: { id?: string }; id?: string };
    expect(response.status).toBeLessThan(300);
    runs[person] = String(body.run?.id ?? body.id ?? '');
    expect(runs[person]).not.toBe('');
  }
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

/** Every [key, value] whose key names a fingerprint, anywhere in a body. */
function fingerprints(value: unknown, key = ''): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((item) => fingerprints(item, key));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => fingerprints(item, name));
  return /fingerprint$/i.test(key) ? [[key, value]] : [];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const traceIdOf = async (runId: string) => {
  const listed = (await call('sam', '/api/ask-traces?limit=100')).body as { traces: Array<{ traceId: string; runId: string }> };
  const trace = listed.traces.find((entry) => entry.runId === runId);
  expect(trace).toBeTruthy();
  return trace!.traceId;
};

describe('a steward reading another person\'s trace', () => {
  it('reads how it was answered and not one canary, by run and by id', async () => {
    const traceId = await traceIdOf(runs.wes!);
    for (const path of [`/api/ask-traces/by-run/${encodeURIComponent(runs.wes!)}`, `/api/ask-traces/${traceId}`]) {
      const read = await call('sam', path);
      expect(read.status, path).toBe(200);
      expect(read.text.match(new RegExp(`${CANARY.source}[A-Z0-9-]*`, 'g')) ?? [], path).toEqual([]);
      expect(read.body.valuesWithheld, path).toBe(true);
      // What the hint review still has: stages, tiers and their outcomes and refusal codes, timings, counts, the refs, the
      // tables and joins, the SQL with every literal masked, the columns and the row count.
      const answer = read.body.runtimeAnswerV1;
      // member_name and open_amount are not names this project's vocabulary or the statement reads by qualified name.
      expect(answer).toMatchObject({ status: 'completed', gap: { kind: 'not_retrieved' }, failedStage: 'execute', executionErrorWithheld: true, sqlParamCount: 1, columns: ['column_2', 'column_3'], rowCountBucket: '1', sqlLiteralsMasked: true, dqlArtifact: { kind: 'semantic', name: 'q', metrics: ['order_total'], dimensions: ['customer_name'] } });
      expect(answer.sql).toBe("SELECT member_name, open_amount AS column_1 FROM claims WHERE adjuster_id = ? AND region IN ('?', '?') AND note = '?' --?\nORDER BY open_amount DESC LIMIT ?");
      const v9 = read.body.runtimeReceiptV9;
      expect(v9.tiers).toEqual([{ round: 1, tier: 'semantic', outcome: 'refused' }, { round: 97, tier: 'exploratory', outcome: 'prepared' }]);
      expect(v9.refusals).toEqual([{ tier: 'semantic', code: 'not_semantic', repairable: false }]);
      expect(v9.checks).toEqual([{ id: 'stated_values', label: 'Applies every value the question states', passed: true, attempt: 1 }]);
      expect(v9.executed).toMatchObject({ tier: 'exploratory', rowCountBucket: '1', sqlFingerprint: expect.stringMatching(/^hmac:[0-9a-f]{32}$/) });
      expect(v9.executed.rowCount).toBeUndefined();
      // No unkeyed hash anywhere: every fingerprint is keyed to this trace (hmac:), ids are ids.
      expect(read.text.match(/sha256:[0-9a-f]+/g) ?? [], path).toEqual([]);
      for (const value of [c('ROW'), c('PARAM'), c('FILTER'), String(98765.43)]) expect(read.text, `${path}: a hash of ${value}`).not.toContain(sha(value).slice(0, 12));
      for (const [key, value] of fingerprints(read.body)) expect(value, `${path} ${key}`).toMatch(/^hmac:[0-9a-f]{32}$/);
      expect(v9.dispatches.map((d: { purpose: string; reply?: string }) => [d.purpose, d.reply])).toEqual([['intent:resolve', undefined], ['intent:draft', undefined]]);
      expect(v9.intent).toMatchObject({ kind: 'analytics', measures: [{ ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:customers.customer_name', op: 'eq' }] }], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq' }], time: { ref: 'dimension:orders.ordered_at', grain: 'month' } });
      expect(v9.context.used).toMatchObject({ relations: ['"jaffle_shop"."dev"."orders"'], engine: 'duckdb', joins: [{ relations: ['orders', 'customers'], keys: [{ from: 'customer_id', to: 'customer_id' }] }] });
      expect(v9.context.rendered.hints).toEqual(['hint:h1']);
      expect(v9.context.enforced.requiredFilterCount).toBe(1);
      expect(v9.story).toEqual([{ version: 1, phase: 'report', title: 'Wrote the report', state: 'done', at: 1 }, { version: 1, phase: 'drill', title: 'Drilled in', state: 'done', at: 2 }, { version: 1, phase: 'execute', title: 'Ran on the warehouse', state: 'done', ms: 4, at: 3 }]);
      for (const gone of ['reading', 'grounding', 'ledger', 'investigation', 'uncovered', 'coverage', 'outOfScope', 'build', 'aFieldAddedTomorrow']) expect(v9[gone], gone).toBeUndefined();
      for (const gone of ['runtimeReceiptV5', 'runtimeReceiptV6', 'runtimeReceiptV8', 'runtimeDecisionSummary']) expect(read.body[gone], gone).toBeUndefined();
    }
  });

  it('the list holds none of her values either, and says why it ended in value-free words', async () => {
    const list = await call('sam', '/api/ask-traces?limit=100');
    expect(list.status).toBe(200);
    expect(list.text).not.toMatch(CANARY);
  });
});

describe('the asker reading their own trace', () => {
  it('keeps everything (positive control: every canary is in the run a steward reads)', async () => {
    const read = await call('sam', `/api/ask-traces/by-run/${encodeURIComponent(runs.sam!)}`);
    expect(read.status).toBe(200);
    expect(read.body.valuesWithheld).toBeUndefined();
    expect(read.body?.runtimeAnswerV1).toMatchObject({ rowsSample: [{ member_name: c('ROW'), open_amount: 98765.43 }], sqlParams: [c('PARAM')] });
    for (const where of ['GROUNDING', 'FILTER', 'READING', 'RESOLVE-REPLY', 'EXECUTED-PROOF', 'CHECK-MESSAGE', 'STORY-DETAIL', 'HEADLINE', 'SQL-IN-1', 'PROOF', 'EVALUATION', 'DQL-FILTER', 'COMPILED', 'NEW-FIELD']) expect(read.text, where).toContain(c(where));
  });
});
