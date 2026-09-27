import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeKnowledgeConnections, startFakeKnowledgeServer, type FakeKnowledgeServer } from '@duckcodeailabs/dql-mcp';
import { startLocalServer } from '../local-runtime.js';
import { createSeededSqliteExecutor, type GoldenSeed } from '../testkit/seeded-sqlite-executor.js';

/**
 * RESEARCH WITH TEAM DOCUMENTS, THROUGH THE SERVER (RFC 0010 HH-15). The
 * jaffle-golden fixture on its seeded engine, the recorded reading of
 * "revenue by month", then "Research deeper" from that answer, with the
 * project's knowledge server (a fake MCP document server):
 *   - the server's pages may reach any model (`knowledge.hostedModels`):
 *     Research reads the page and cites it, as context only;
 *   - they may not, and the model is not on this machine: Research reads
 *     nothing and says so in a "Team documents not read" step.
 * Either way the investigation's verdict and trust are the same.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../test/fixtures/jaffle-golden');
const seed = JSON.parse(readFileSync(join(fixtureDir, 'seeds', 'seed.json'), 'utf8')) as GoldenSeed;
const PAGE = 'Revenue is the total of every order, after refunds. Month boundaries follow the store calendar.';

let knowledge: FakeKnowledgeServer;
const servers: Server[] = [];
const roots: string[] = [];

beforeAll(async () => {
  knowledge = await startFakeKnowledgeServer({
    tokens: ['project-token'],
    pages: [{ id: 'revenue', title: 'Revenue definition', url: 'https://wiki.example/revenue', text: PAGE }],
  });
  process.env.DQL_EVAL_CASSETTE_DIR = join(fixtureDir, 'test-cassettes', 'golden');
  process.env.DQL_EVAL_CASSETTE_MODE = 'replay';
});
afterEach(async () => {
  await closeKnowledgeConnections();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => { await knowledge.close(); });

async function start(hostedModels: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dql-knowledge-research-'));
  roots.push(root);
  cpSync(fixtureDir, root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  rmSync(join(root, 'test-cassettes'), { recursive: true, force: true });
  mkdirSync(join(root, '.dql'), { recursive: true });
  writeFileSync(join(root, '.dql', 'mcp-servers.json'), JSON.stringify({
    servers: [{ name: 'wiki', label: 'Team wiki', url: knowledge.url, use: ['knowledge'], trusted: true, authorizationToken: 'project-token', ...(hostedModels ? { knowledge: { hostedModels: true } } : {}) }],
  }));
  const port = await startLocalServer({
    rootDir: root, projectRoot: root, executor: createSeededSqliteExecutor(seed), connection: { driver: 'sqlite', filepath: ':memory:' }, preferredPort: 0,
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

async function run(base: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return ((await response.json()) as { run: unknown }).run;
}

async function research(base: string) {
  const asked = await run(base, { question: 'revenue by month', requestedMode: 'ask' });
  expect(asked.status).toBe('completed');
  return run(base, { question: 'Research deeper: revenue by month', requestedMode: 'research', workspaceContext: { researchSource: { runId: asked.id } } });
}

describe('Research and team documents (HH-15)', () => {
  it('cites the page when it may reach the model, and says which pages it held back when not — the verdict is the same', async () => {
    knowledge.calls.length = 0;
    const cited = await research(await start(true));
    expect(cited.knowledge).toMatchObject({ version: 1, contextOnly: true, citations: [expect.objectContaining({ sourceId: 'wiki', docId: 'revenue', title: 'Revenue definition' })] });
    expect(knowledge.calls.map((call) => call.tool)).toEqual(expect.arrayContaining(['search']));

    knowledge.calls.length = 0;
    const held = await research(await start(false));
    expect(held.knowledge).toBeUndefined();
    expect(knowledge.calls).toEqual([]);
    const step = (held.diagnosticReceiptV9?.story ?? []).find((entry: { title: string }) => entry.title === 'Team documents not read');
    expect(step).toMatchObject({ phase: 'search', detail: expect.stringContaining('Team wiki') });
    expect(step.detail).toContain('"hostedModels": true');
    // Documents are context only: the investigation reached the same verdict with or without them.
    const verdict = (run: any) => run.artifacts.find((artifact: any) => artifact.kind === 'research_run')?.payload?.investigation?.status;
    expect(verdict(held)).toBe(verdict(cited));
    expect(held.trustState).toBe(cited.trustState);
  }, 180_000);
});
