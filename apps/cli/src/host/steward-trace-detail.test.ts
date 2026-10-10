import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunExecutors } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { askTraceReason, startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * Ask observability with a host: a person who reviews answers (`hint.review`, the steward) opens any person's
 * trace from the list; everyone else opens only their own.
 */
const wes: DqlPrincipal = { id: 'u-wes', kind: 'person', email: 'wes@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const sam: DqlPrincipal = { id: 'u-sam', kind: 'person', email: 'sam@harbor.example', source: 'host' };
const people: Record<string, DqlPrincipal> = { wes, dan, sam };

const servers: Server[] = [];
let projectRoot = '';
let base = '';

const call = async (person: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-person': person },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, text, body: parsed };
};

const answerExecutor = ((input: { request: { question: string } }) => ({
  summary: `Answer to ${input.request.question}`,
  answer: `Answer to ${input.request.question}`,
  status: 'completed',
  trustState: 'governed',
  stopReason: 'governed_semantic_answer',
  artifacts: [{ id: 'answer-1', kind: 'answer', title: 'Governed answer', trustState: 'governed', payload: { text: 'ok', result: { columns: ['q'], rows: [{ q: 1 }], rowCount: 1 } } }],
  evaluations: [],
  nextActions: [],
})) as unknown as NonNullable<AgentRunExecutors['generated_answer']>;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dql-steward-trace-detail-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'steward-traces' }));
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
  expect((await call('wes', 'POST', '/api/agent-runs', { question: 'How many claims did Wes ask about?' })).status).toBeLessThan(300);
  expect((await call('dan', 'POST', '/api/agent-runs', { question: 'How many claims did Dan ask about?' })).status).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

type Listed = { traces: Array<{ traceId: string; runId: string }> };

describe('opening a trace', () => {
  it('lets a steward open another person\'s trace, by id and by run', async () => {
    const wesList = (await call('wes', 'GET', '/api/ask-traces?limit=100')).body as Listed;
    expect(wesList.traces.length).toBeGreaterThan(0);
    const wesTrace = wesList.traces[0]!;
    const byId = await call('sam', 'GET', `/api/ask-traces/${wesTrace.traceId}`);
    expect(byId.status).toBe(200);
    const byRun = await call('sam', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesTrace.runId)}`);
    expect(byRun.status).toBe(200);
  });

  it('keeps another person\'s trace not found for someone who does not review answers', async () => {
    const wesTrace = ((await call('wes', 'GET', '/api/ask-traces?limit=100')).body as Listed).traces[0]!;
    expect((await call('dan', 'GET', `/api/ask-traces/${wesTrace.traceId}`)).status).toBe(404);
    expect((await call('dan', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(wesTrace.runId)}`)).status).toBe(404);
    expect((await call('wes', 'GET', `/api/ask-traces/${wesTrace.traceId}`)).status).toBe(200);
  });
});
