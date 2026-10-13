import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer, traceAnswerProjection } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * Ask observability with a host: a steward (`hint.review`) who opens another person's trace to review hints reads how
 * the answer was made (status, SQL, columns, row count) and none of its values: no row sample, no SQL parameter
 * values, no warehouse error text. The asker's own trace, and DQL without a host, keep them.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, sam };

/** Values only a result carries: a member's name and an amount to the cent. */
const NAME = 'CANARY-MEMBER-Ortega';
const AMOUNT = 98765.43;
const PARAM = 'CANARY-BOUND-ADJ-77';
const ERROR = "Could not convert string 'CANARY-ROW-VALUE' to INT32";
const CANARY = /CANARY-|98765\.43/;

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

const answerExecutor = ((input: { request: { question: string } }) => ({
  summary: `Answer to ${input.request.question}`,
  answer: 'The largest open claim is listed below.',
  status: 'completed',
  trustState: 'review_required',
  stopReason: 'generated_answer',
  // The Ask pipeline's receipt: a trace explains the answer (runtimeAnswerV1) only for a run that has one.
  askPipelineReceipt: {
    version: 9, vocabularyFingerprint: 'v', dispatches: [], candidates: [], refusals: [],
    tiers: [{ round: 1, tier: 'relational', outcome: 'prepared' }],
    executed: { tier: 'relational', sqlFingerprint: 'sha256:x', rowCount: 1, ms: 3, proofs: [] },
    timings: {}, reuse: 'none',
  },
  artifacts: [{
    id: 'answer-1', kind: 'answer', title: 'Answer', trustState: 'review_required',
    payload: {
      text: 'ok',
      sql: 'SELECT member_name, open_amount FROM claims WHERE adjuster_id = ? ORDER BY open_amount DESC LIMIT 1',
      sqlParams: [PARAM],
      executionError: ERROR,
      failedStage: 'execute',
      result: { columns: ['member_name', 'open_amount'], rows: [{ member_name: NAME, open_amount: AMOUNT }], rowCount: 1 },
    },
  }],
  evaluations: [],
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

const traceIdOf = async (runId: string) => {
  const listed = (await call('sam', '/api/ask-traces?limit=100')).body as { traces: Array<{ traceId: string; runId: string }> };
  const trace = listed.traces.find((entry) => entry.runId === runId);
  expect(trace).toBeTruthy();
  return trace!.traceId;
};

describe('a steward reading another person\'s trace', () => {
  it('sees how it was answered (SQL, columns, row count, stage) and no value: by run and by id', async () => {
    const traceId = await traceIdOf(runs.wes!);
    for (const path of [`/api/ask-traces/by-run/${encodeURIComponent(runs.wes!)}`, `/api/ask-traces/${traceId}`]) {
      const read = await call('sam', path);
      expect(read.status, path).toBe(200);
      const answer = read.body?.runtimeAnswerV1;
      expect(answer, path).toMatchObject({ sql: expect.stringContaining('FROM claims'), columns: ['member_name', 'open_amount'], rowCount: 1, failedStage: 'execute', sqlParamCount: 1 });
      expect(answer.rowsSample, path).toBeUndefined();
      expect(answer.sqlParams, path).toBeUndefined();
      expect(answer.executionError, path).toBeUndefined();
      expect(read.text, path).not.toMatch(CANARY);
    }
  });

  it('the list holds none of her values either', async () => {
    const list = await call('sam', '/api/ask-traces?limit=100');
    expect(list.status).toBe(200);
    expect(list.text).not.toMatch(CANARY);
  });
});

describe('the asker reading their own trace', () => {
  it('keeps the row sample, the parameters and the error (positive control)', async () => {
    const read = await call('sam', `/api/ask-traces/by-run/${encodeURIComponent(runs.sam!)}`);
    expect(read.status).toBe(200);
    expect(read.body?.runtimeAnswerV1).toMatchObject({ rowsSample: [{ member_name: NAME, open_amount: AMOUNT }], sqlParams: [PARAM], executionError: ERROR });
  });
});

describe('traceAnswerProjection', () => {
  const run = {
    status: 'completed',
    artifacts: [{ kind: 'answer', payload: { sql: 'SELECT 1', sqlParams: [PARAM], executionError: ERROR, result: { columns: ['a'], rows: [{ a: AMOUNT }], rowCount: 1 } } }],
  };
  it('keeps values by default (DQL without a host, the asker)', () => {
    expect(traceAnswerProjection(run)).toMatchObject({ rowsSample: [{ a: AMOUNT }], sqlParams: [PARAM], executionError: ERROR });
  });
  it('drops every value with values: false', () => {
    const projection = traceAnswerProjection(run, { values: false });
    expect(projection).toEqual({ status: 'completed', sql: 'SELECT 1', sqlParamCount: 1, columns: ['a'], rowCount: 1 });
    expect(JSON.stringify(projection)).not.toMatch(CANARY);
  });
});
