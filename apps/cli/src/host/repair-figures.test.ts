import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticalFailure } from '@duckcodeailabs/dql-agent';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { saveProviderSettings } from '../settings/provider-settings.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-14 on the repair route: an answer repaired after a failed run is review-required, so a person the host
 * keeps needs-review figures from gets the repaired run without its values, and DQL stores it that way, as it does an
 * Ask answer. With figures shown, the repaired rows are there (the control).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const FIGURE = 4242424;

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function repairAs(rule: 'show' | 'withhold_review'): Promise<{ status: number; text: string; body: any; stored: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-repair-figures-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'sk-repair-figures', baseUrl: 'https://repair-figures.example.test/v1', model: 'repair-test' });
  const failedSql = 'SELECT order_id FROM main.orders WHERE order_id >= $1';
  const repairedSql = 'SELECT order_id FROM "main"."orders" WHERE order_id >= $1';
  const sourceDql = `block "Orders" {
  type = "custom"
  params { min_order_id: number = 1 }
  parameterPolicy { min_order_id = "dynamic" }
  query = """SELECT order_id FROM main.orders WHERE order_id >= \${min_order_id}"""
}`;
  const failure = createAnalyticalFailure({ code: 'DIALECT_ERROR', phase: 'execution', snapshotId: 'snapshot-repair-figures', runId: 'failed-repair-figures', planFingerprint: 'd'.repeat(64), dqlSource: sourceDql, compiledSql: failedSql });
  const failedAnswer = () => ({
    summary: 'The query could not be completed.', status: 'blocked' as const, trustState: 'blocked' as const, stopReason: 'blocked' as const,
    artifacts: [{
      id: 'answer:failed', kind: 'answer' as const, title: 'Failed analytical run', trustState: 'blocked' as const,
      payload: {
        kind: 'no_answer', analyticalFailure: failure,
        resolvedAnalyticalPlan: { fingerprint: failure.planFingerprint, recommendedRoute: 'generated_answer' },
        dqlArtifact: { kind: 'sql_block', name: 'Orders', source: sourceDql, compiledSql: failedSql, parameterValues: { min_order_id: 7 }, trustState: 'review_required', persistence: 'transient' },
        proposedSql: failedSql, sql: failedSql, executionError: 'The warehouse rejected the source dialect quoting.',
        warehouseFailure: { version: 1, origin: 'warehouse', stage: 'execution', category: 'dialect_error', retryDisposition: 'model_repair', redactedMessage: 'The warehouse rejected the source dialect quoting.', driver: 'duckdb' },
      },
    }],
    evaluations: [], nextActions: [],
  });
  let attempts = 0;
  const executor = {
    executeQuery: vi.fn(async (sql: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('Parser Error: dialect quoting requires explicit identifiers');
      return { columns: ['order_id'], rows: [{ order_id: FIGURE }], rowCount: 1, sql };
    }),
  } as unknown as QueryExecutor;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://repair-figures.example.test/')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ summary: `Order ${FIGURE} leads.`, sql: repairedSql, viz: 'table', outputs: ['order_id'] })}\n\`\`\`` } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return nativeFetch(input, init);
  }));
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, connection: { driver: 'file' }, preferredPort: 0,
    hostHooks: { resolvePrincipal: () => priya, answerFigures: () => rule, onePerson: true },
    captureServer: (created) => { servers.push(created); },
    agentRunExecutors: { conversation: failedAnswer, certified_answer: failedAnswer, semantic_answer: failedAnswer, generated_answer: failedAnswer, research: failedAnswer, clarify: failedAnswer, blocked: failedAnswer },
  });
  const base = `http://127.0.0.1:${port}`;
  const created = await (await nativeFetch(`${base}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Show orders', requestedMode: 'ask', executionTarget: { target: 'local' } }) })).json() as { run: { id: string } };
  const response = await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(created.run.id)}/repair-execution`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await response.text();
  const body = JSON.parse(text);
  const stored = await (await nativeFetch(`${base}/api/agent-runs/${encodeURIComponent(body.run?.id ?? 'none')}`)).text();
  return { status: response.status, text, body, stored };
}

describe('a repaired answer and HH-14', () => {
  it('control: with figures shown, the repaired run carries its rows', async () => {
    const repaired = await repairAs('show');
    expect(repaired.status, repaired.text.slice(0, 300)).toBe(201);
    expect(repaired.text).toContain(String(FIGURE));
  });

  it('withholds the repaired run\'s figures from a person the host keeps them from, and stores it that way', async () => {
    const repaired = await repairAs('withhold_review');
    expect(repaired.status, repaired.text.slice(0, 300)).toBe(201);
    expect(repaired.body.run).toMatchObject({ trustState: 'review_required', figuresWithheld: true });
    expect(repaired.text).not.toContain(String(FIGURE));
    expect(repaired.stored).not.toContain(String(FIGURE));
  });
});
