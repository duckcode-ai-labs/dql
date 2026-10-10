import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createScriptedAnalystProvider } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Sandbox gate W1b: the same governed question came back Governed (semantic_answer) through
 * POST /api/agent-runs and "AI-generated answer" (Needs review) through the Ask page.
 *
 * The Ask page opens a thread, then posts the question as a stream with mode "auto", the stakeholder audience,
 * the thinking mode, a connection name and an idempotency key (UnifiedAgentRunPanel.tsx, AnalyticsHome.tsx).
 * The API posts the question alone. Certified-first, then semantic, routing must not depend on any of that:
 * the same question must take the same route and show the same trust either way.
 */
const here = dirname(fileURLToPath(import.meta.url));
const QUESTIONS = [
  { label: 'a certified block', question: 'Who are the top customers by lifetime spend?' },
  { label: 'a certified comparison', question: 'compare food and drink revenue' },
  { label: 'a question made only of a governed metric and a dimension', question: 'product revenue by product name' },
  { label: 'a question no certified block or metric answers', question: 'what is the order count for each customer?' },
];

const executor = {
  executeQuery: async (sql: string) => {
    const columns = [...sql.matchAll(/\sAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((match) => match[1]);
    const names = columns.length ? columns : ['value'];
    const rows = [1, 2, 3].map((index) => Object.fromEntries(names.map((name) => [name, /(revenue|spend|amount|count|total)/i.test(name) ? 1000 - index : `Row ${index}`])));
    return { columns: names, rows, rowCount: rows.length, sql };
  },
} as unknown as QueryExecutor;

interface RunView { route?: string; trustState?: string; status?: string }

let base = '';
let server: Server | undefined;
let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dql-ask-route-parity-'));
  cpSync(resolve(here, '../test/fixtures/jaffle-semantic'), root, { recursive: true });
  rmSync(join(root, '.dql', 'cache'), { recursive: true, force: true });
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    askAnalyticalPlannerProviderFactory: () => createScriptedAnalystProvider('cooperative'),
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server ? server.close(() => done()) : done());
  rmSync(root, { recursive: true, force: true });
});

const view = (run: any): RunView => ({ route: run?.route, trustState: run?.trustState, status: run?.status });

/** What an API caller sends. */
async function askThroughApi(question: string): Promise<RunView> {
  const response = await fetch(`${base}/api/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  expect(response.status).toBe(201);
  return view(((await response.json()) as { run: unknown }).run);
}

/** What the Ask page sends on a new chat: a thread first, then a streamed run with the page's own options. */
async function askThroughBrowser(question: string): Promise<RunView> {
  const created = await fetch(`${base}/api/agent/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ surface: 'ask', title: question }),
  });
  const threadId = ((await created.json()) as { thread: { id: string } }).thread.id;
  const response = await fetch(`${base}/api/agent-runs?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `submission-${threadId}` },
    body: JSON.stringify({
      question,
      requestId: `submission-${threadId}`,
      requestedMode: 'auto',
      audience: 'stakeholder',
      executionTarget: { target: 'connection', connectionName: 'default' },
      workspaceContext: {},
      history: [],
      thinkingMode: 'auto',
      researchResultRowsOptIn: false,
      threadId,
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const complete = text.split('\n\n').find((frame) => frame.startsWith('event: agent-run-complete'));
  expect(complete, text.slice(0, 600)).toBeDefined();
  const data = complete!.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
  return view(JSON.parse(data));
}

describe('the Ask page and the API give the same trust route for the same question', () => {
  it.each(QUESTIONS)('takes the same route for $label', async ({ question }) => {
    const api = await askThroughApi(question);
    const browser = await askThroughBrowser(question);
    expect(browser).toEqual(api);
  }, 90_000);

  it('keeps the same route when a new chat is opened for the same question again', async () => {
    const [{ question }] = QUESTIONS;
    const first = await askThroughBrowser(question);
    const second = await askThroughBrowser(question);
    expect(second).toEqual(first);
  }, 90_000);
});
