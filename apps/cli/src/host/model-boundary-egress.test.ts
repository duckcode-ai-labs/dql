import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { saveProviderSettings } from '../settings/provider-settings.js';

/**
 * The model boundary: no OSS path sends result values to a model without `isInBoundary` or a local-model check
 * that is true. RFC 0010 "Privacy boundary": "The OSS rule stays: result values reach a model only when the model
 * runs on this machine." Without a host, the check DQL makes before a chart question or a story draft carries the
 * chart's rows is "the provider is Ollama and its configured base URL is loopback".
 *
 * Here the configured Ollama is on loopback but not running. Global fetch is stubbed (nothing leaves this machine)
 * and records any request to `ollama` or `host.docker.internal`. Expected: no prompt or chart value leaves loopback.
 */
const here = dirname(fileURLToPath(import.meta.url));
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');
const evidenceDir = process.env.HOST_CHECK_EVIDENCE_DIR?.trim();

const servers: Server[] = [];
const roots: string[] = [];
const executors: QueryExecutor[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the local-model rule: a loopback Ollama that is down', () => {
  duckIt('a chart question whose model is "Ollama on loopback" never sends the chart\'s values to a host that is not this machine', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-boundary-'));
    roots.push(projectRoot);
    cpSync(fixtureRoot, projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
    // The person's model: Ollama, configured on this machine (a closed loopback port: the daemon is not running).
    saveProviderSettings(projectRoot, { id: 'ollama', enabled: true, baseUrl: 'http://127.0.0.1:9', model: 'llama3' });

    const nativeFetch = globalThis.fetch;
    const sent: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const host = new URL(url).hostname;
      if (host === 'ollama' || host === 'host.docker.internal') {
        sent.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
        if (host === 'host.docker.internal') throw new TypeError('fetch failed');
        if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        const reply = JSON.stringify({ message: { role: 'assistant', content: 'One region leads.' }, done: true });
        return new Response(url.endsWith('/api/chat') ? `${reply}\n` : reply, { status: 200, headers: { 'content-type': 'application/json' } });
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
    const tile = (run.body.tiles as Array<{ tileId: string; status: string; tileType?: string; result?: { rows?: Array<Record<string, unknown>> } }>).find((candidate) => candidate.status === 'ok' && candidate.tileType === 'dataset');
    expect(tile).toBeTruthy();
    const asked = await post('/api/apps/commerce-pilot/ask', { question: 'What stands out?', dashboardId: 'overview', tileId: tile!.tileId, runId: run.body.runId });
    expect(asked.status, asked.text.slice(0, 200)).toBe(200);

    // What left for a base URL that is not loopback, and whether it carried the chart's values.
    const values = JSON.stringify(tile!.result?.rows ?? []).match(/"[A-Z]{2}"|\b\d{2,}\b/g) ?? [];
    const carried = sent.filter((request) => request.body && values.some((value) => request.body.includes(value.replace(/"/g, ''))));
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      appendFileSync(join(evidenceDir, 'model-boundary.jsonl'), `${JSON.stringify({ case: 'ollama-fallback', answerMode: asked.body?.answer?.mode ?? asked.body?.mode ?? null, requestsOffMachine: sent.map((request) => ({ url: request.url, bytes: request.body.length, preview: request.body.slice(0, 400) })), carriedValues: carried.length })}\n`);
    }
    expect(sent.map((request) => request.url).filter((url) => url.endsWith('/api/chat') || url.endsWith('/api/generate')), 'prompts sent to a base URL that is not this machine').toEqual([]);
    expect(carried, 'chart values sent off this machine').toEqual([]);
  }, 120_000);
});

describe('values in prompt text on paths that never ask isInBoundary (source guard)', () => {
  /**
   * A static guard, as the RFC's own guard tests do for tools and executors: every place that writes earlier
   * answers, conversation memory, preview facts or Research facts into a model prompt decides first whether values
   * may reach that model (`resultValuesMayReachModel`, the HH-5 rule). Each site below must decide in the same
   * function that dispatches to the model.
   */
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const repo = resolve(here, '../../../..');
  /** From the site back to the start of its executor (the nearest `const ... = async`), forward to the model call. */
  const dispatchWindow = (file: string, marker: string): string => {
    const text = readFileSync(join(repo, file), 'utf8');
    const at = text.indexOf(marker);
    if (at < 0) throw new Error(`${marker} not found in ${file}`);
    const head = text.lastIndexOf(' = async', at);
    const call = text.indexOf('.generate(', at);
    return text.slice(head < 0 ? 0 : head, call < 0 ? at : call + 200);
  };
  const SITES: Array<[string, string, string]> = [
    ['conversation reply: conversation memory and thread history', 'apps/cli/src/local-runtime.ts', 'renderConversationMemoryForPrompt(request.conversationContext)'],
    ['App Autopilot: the preview\'s grouped facts', 'apps/cli/src/local-runtime.ts', 'summary: answerFromDatasetChartContext(preview.context, dataset)'],
  ];
  it('control: the story draft site, which does decide, passes the same guard', () => {
    // The story draft site decides through the one boundary function every value-carrying prompt uses.
    const body = dispatchWindow('apps/cli/src/local-runtime.ts', "relations: storyValueRelations(evidence.storyBindings, evidence.tileRelations)?.relations,");
    expect(/resultValuesMayReachModel\(|valuesMayReachProvider/.test(body)).toBe(true);
  });
  for (const [label, file, marker] of SITES) {
    it(`${label} decides with the boundary rule before it reaches the model`, () => {
      const body = dispatchWindow(file, marker);
      expect(body.includes('provider') || body.includes('generate('), `guard: ${label} dispatches to a model`).toBe(true);
      expect(/resultValuesMayReachModel\(|valuesMayReachProvider/.test(body), `${label} (${file}) sends values without the boundary rule`).toBe(true);
    });
  }
});

describe('a story draft outside the boundary', () => {
  it('gives a model outside the boundary binding names and labels only: no member of a grouped tile (a result value) is in the prompt', async () => {
    const { buildStoryBindingCatalog } = await import('@duckcodeailabs/dql-core');
    const { storyDraftUserPrompt } = await import('@duckcodeailabs/dql-agent');
    const catalog = buildStoryBindingCatalog([{
      tileId: 'claims-by-member', status: 'ok', title: 'Open claims by member',
      result: { columns: ['member_name', 'open_claims'], rows: [{ member_name: 'CANARY-MEMBER-Jane Roe', open_claims: 3 }, { member_name: 'CANARY-MEMBER-John Doe', open_claims: 2 }] },
    }]);
    const prompt = storyDraftUserPrompt({ pageTitle: 'Claims', catalog, tiles: [{ tileId: 'claims-by-member', title: 'Open claims by member', kind: 'table' }], includeValues: false });
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      appendFileSync(join(evidenceDir, 'model-boundary.jsonl'), `${JSON.stringify({ case: 'story-member-labels', includeValues: false, prompt: prompt.slice(0, 1200) })}\n`);
    }
    // The figures are withheld (no "(now …)"), but each grouped row's member is part of the binding's key and label.
    expect(prompt).not.toContain('(now ');
    expect(prompt, 'a member value (a result value) reaches a model the boundary keeps values from').not.toContain('CANARY-MEMBER');
  });
});
