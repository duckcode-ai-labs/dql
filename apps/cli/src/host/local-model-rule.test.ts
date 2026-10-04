import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { saveProviderSettings } from '../settings/provider-settings.js';

/**
 * DQL's local-model rule, without any host: result values reach a model only
 * when it runs on this machine (Ollama on a loopback URL). The rule holds only
 * if the provider then talks to that machine and no other: Ollama tries no
 * other address of its own, and a model on this machine never fails over to
 * another provider the project also has (which would carry the same prompt,
 * values included, off the machine).
 *
 * Global fetch is stubbed: every address that is not this machine is recorded
 * and answered in-process, so nothing leaves the machine and no name is looked up.
 */
const here = dirname(fileURLToPath(import.meta.url));
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');

const servers: Server[] = [];
const roots: string[] = [];
const executors: QueryExecutor[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

describe('the local-model rule without a host', () => {
  duckIt('a chart question on "Ollama on this machine" reaches no other machine: no fallback address, no failover to another provider', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-local-model-'));
    roots.push(projectRoot);
    cpSync(fixtureRoot, projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
    // An Ollama on this machine that is up but cannot answer (its model is not pulled): a fault the provider fails on.
    const ollama = createServer((req, res) => {
      res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(req.url === '/api/tags' ? '{"models":[]}' : '{"error":"model \'llama3\' not found"}');
    });
    servers.push(ollama);
    await new Promise<void>((done) => ollama.listen(0, '127.0.0.1', () => done()));
    const ollamaPort = (ollama.address() as { port: number }).port;
    // The project also has a hosted model configured; the person's active model is Ollama on this machine.
    saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'test-key-not-real', baseUrl: 'https://models.example.test/v1', model: 'gpt-test' });
    saveProviderSettings(projectRoot, { id: 'ollama', enabled: true, baseUrl: `http://127.0.0.1:${ollamaPort}`, model: 'llama3' });

    const nativeFetch = globalThis.fetch;
    const offMachine: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (!LOOPBACK.has(url.hostname)) {
        offMachine.push(`${url.origin}${url.pathname}`);
        const reply = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'One region leads.' }, finish_reason: 'stop' }], message: { role: 'assistant', content: 'One region leads.' }, done: true, models: [] };
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return nativeFetch(input, init);
    }));

    const executor = new QueryExecutor();
    executors.push(executor);
    const connection = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const post = async (path: string, body: unknown) => {
      const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
    };
    const run = await post('/api/apps/commerce-pilot/dashboards/overview/run', {});
    expect(run.status, run.text.slice(0, 200)).toBe(200);
    const tile = (run.body.tiles as Array<{ tileId: string; status: string; tileType?: string }>).find((candidate) => candidate.status === 'ok' && candidate.tileType === 'dataset');
    expect(tile).toBeTruthy();
    const asked = await post('/api/apps/commerce-pilot/ask', { question: 'What stands out?', dashboardId: 'overview', tileId: tile!.tileId, runId: run.body.runId });
    expect(asked.status, asked.text.slice(0, 200)).toBeLessThan(500);
    expect(offMachine, 'requests to an address that is not this machine').toEqual([]);
  }, 120_000);
});
