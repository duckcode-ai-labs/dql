import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { dispatchNotifications } from '../schedule/notifiers/index.js';
import { startLocalServer } from '../local-runtime.js';
import { currentHostGitHooks, hostModelProvider, resultValuesMayReachModel, withRequestContext, type DqlHostHooks, type DqlModelProvider, type DqlPrincipal } from './request-context.js';

/**
 * The host-hook contract: two servers in one process never cross state. RFC 0010 "One process, several
 * servers": "a host that runs Production and pull request previews in one process never has one server's git,
 * delivery, model, tool-gate or usage hooks replaced by another's; the process-wide values are only a fallback for
 * work outside a request". The request-context doc comment adds "each request uses its own server's hooks".
 *
 * Three set-ups: two hosted servers (a Production and a preview), a hosted server started BEFORE a server without a
 * host, and one started AFTER it. In each, every request uses its own server's hooks.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@example.test', source: 'host' };
const PAYLOAD = { block: 'b', path: 'p', startedAt: 't', alerts: [], queries: [], trigger: 'cron' } as never;

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(name: string, apps = false): string {
  const projectRoot = mkdtempSync(join(tmpdir(), `dql-two-${name}-`));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: name }));
  if (apps) {
    mkdirSync(join(projectRoot, 'apps', 'claims'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
      version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
      owners: ['owner@example.test'],
      members: [{ userId: 'member@example.test', displayName: 'Member', roles: ['viewer'] }, { userId: 'owner@example.test', displayName: 'Owner', roles: ['owner'] }],
      roles: [{ id: 'viewer', displayName: 'Viewer' }, { id: 'owner', displayName: 'Owner' }],
      policies: [{ id: 'viewers-read', domain: 'claims', minClassification: 'internal', allowedRoles: ['viewer', 'owner'], accessLevel: 'read', enabled: true }],
    }));
  }
  return projectRoot;
}

async function serve(name: string, hostHooks?: DqlHostHooks, apps = false) {
  const projectRoot = project(name, apps);
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    connection: { driver: 'file' } as ConnectionConfig,
    preferredPort: 0,
    ...(hostHooks ? { hostHooks } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown, person = 'priya') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-person': person },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed };
  };
  return { call, projectRoot };
}

/** A recording host: every hook notes which server it belongs to. */
function recordingHost(label: string, seen: string[]): DqlHostHooks {
  const model = { name: `${label}-model`, available: async () => true, generate: async () => 'ok' } as unknown as DqlModelProvider;
  return {
    resolvePrincipal: () => priya,
    authorize: () => { seen.push(`${label}:authorize`); return { allow: true }; },
    audit: (event) => { seen.push(`${label}:audit:${event.kind}`); },
    tools: async (call, next) => { seen.push(`${label}:tools:${call.name}`); return next(); },
    delivery: async () => { seen.push(`${label}:delivery`); return { delivered: true }; },
    modelProvider: () => { seen.push(`${label}:model`); return { id: 'bedrock', provider: model }; },
    isInBoundary: () => { seen.push(`${label}:boundary`); return label === 'preview'; },
    git: { openPullRequest: async () => { seen.push(`${label}:git`); return { url: `https://git.example.test/${label}` }; } },
    ui: () => ({ environment: `${label} environment` }),
  };
}

describe('two hosted servers in one process (a Production and a preview)', () => {
  it('each request uses its own server\'s hooks: authorize, audit, ui, and the tool gate, model, boundary, delivery and git', async () => {
    const seen: string[] = [];
    const productionHooks = recordingHost('production', seen);
    const previewHooks = recordingHost('preview', seen);
    const production = await serve('production', productionHooks);
    const preview = await serve('preview', previewHooks);

    // Interleaved requests to both; each server's own hooks hear only its own.
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? production : preview).call('POST', '/api/agent/threads', { title: `t${index}`, surface: 'ask' })));
    await new Promise((done) => setTimeout(done, 50));
    expect(seen.filter((entry) => entry === 'production:audit:request')).toHaveLength(10);
    expect(seen.filter((entry) => entry === 'preview:audit:request')).toHaveLength(10);
    expect((await production.call('GET', '/api/host/ui')).body.environment).toBe('production environment');
    expect((await preview.call('GET', '/api/host/ui')).body.environment).toBe('preview environment');

    // The process-wide values belong to the preview (started last); Production's requests still get Production's.
    seen.length = 0;
    const { runGatedTool } = await import('@duckcodeailabs/dql-agent');
    await withRequestContext({ principal: priya, requestId: 'r1', hooks: productionHooks }, async () => {
      await runGatedTool({ name: 'search_catalog', run: async () => 'ok' }, {});
      hostModelProvider();
      resultValuesMayReachModel({ id: 'bedrock', name: 'claude' }, () => false);
      await dispatchNotifications([{ type: 'email', recipients: ['a@example.test'] } as never], PAYLOAD, tmpdir());
      await currentHostGitHooks()?.openPullRequest?.({ gitRoot: '/', branch: 'b', base: 'main', title: 't', body: 'b', principal: priya });
    });
    expect(seen).toEqual(['production:tools:search_catalog', 'production:model', 'production:boundary', 'production:delivery', 'production:git']);
  });

  it('records: "view as" (the App persona) is kept per person for the whole process, not per server', async () => {
    const seen: string[] = [];
    const production = await serve('production-persona', recordingHost('production', seen), true);
    const preview = await serve('preview-persona', recordingHost('preview', seen), true);
    const chosen = await production.call('POST', '/api/persona', { userId: 'member@example.test', appId: 'claims' });
    expect(chosen.status, chosen.text).toBe(200);
    const onPreview = await preview.call('GET', '/api/persona');
    // The same person on both servers: a persona chosen on Production does not carry over to the preview.
    expect.soft(onPreview.body.persona?.userId ?? null, 'persona chosen on Production is active on the preview').toBeNull();
  });
});

describe('a hosted server and a server without a host in one process', () => {
  it('a server without a host started AFTER a hosted one must not remove the hosted server\'s tool gate (HH-7)', async () => {
    const seen: string[] = [];
    const hostedHooks = recordingHost('hosted', seen);
    hostedHooks.tools = async (call, next) => {
      seen.push(`hosted:tools:${call.name}`);
      if (call.name === 'run_sql') throw new Error('SQL tools are off for this workspace.');
      return next();
    };
    await serve('hosted', hostedHooks);
    await serve('plain');
    const { runGatedTool } = await import('@duckcodeailabs/dql-agent');
    let outcome: string;
    outcome = await withRequestContext({ principal: priya, requestId: 'r', hooks: hostedHooks }, async () => {
      try {
        return String(await runGatedTool({ name: 'run_sql', run: async () => 'ran without the gate' }, {}));
      } catch (error) {
        return `refused: ${(error as Error).message}`;
      }
    });
    expect(outcome, 'the hosted server\'s own request ran a tool its gate refuses').toBe('refused: SQL tools are off for this workspace.');
    expect(seen).toContain('hosted:tools:run_sql');
  });

  it('a hosted server started AFTER a server without a host must not become that server\'s model, boundary, delivery or tool gate', async () => {
    const plain = await serve('plain-first');
    const seen: string[] = [];
    await serve('hosted-later', recordingHost('hosted', seen));
    // Work of the server without a host runs with no request context (it names no one): the fallback is all it sees.
    const { runGatedTool } = await import('@duckcodeailabs/dql-agent');
    const sawModel = hostModelProvider();
    const mayReach = resultValuesMayReachModel({ id: 'openai', name: 'gpt' }, () => false);
    await dispatchNotifications([{ type: 'webhook', recipients: ['http://127.0.0.1:9/hook'] } as never], PAYLOAD, tmpdir()).catch(() => undefined);
    await runGatedTool({ name: 'search_catalog', run: async () => 'ok' }, {});
    const crossed = seen.filter((entry) => /model|boundary|delivery|tools/.test(entry));
    // And through the server without a host itself: its Ask asks the hosted server's model hook.
    seen.length = 0;
    await plain.call('POST', '/api/agent-runs', { question: 'How many claims were paid last month?' });
    const crossedOverHttp = [...seen];
    expect.soft(sawModel, 'the single-user server got the hosted server\'s model').toBeUndefined();
    expect.soft(mayReach, 'the single-user server took the hosted server\'s boundary rule').toBe(false);
    expect.soft(crossed, 'hooks of the hosted server heard the single-user server\'s work').toEqual([]);
    expect.soft(crossedOverHttp.filter((entry) => /model|boundary|tools|delivery/.test(entry)), 'the single-user server\'s Ask reached the hosted server\'s hooks').toEqual([]);
  });

  it('without any host at all, nothing of a host is consulted (control)', async () => {
    const plain = await serve('plain-only');
    expect(hostModelProvider()).toBeUndefined();
    expect(resultValuesMayReachModel({ id: 'openai', name: 'gpt' }, () => false)).toBe(false);
    expect(resultValuesMayReachModel({ id: 'ollama', name: 'llama', baseUrl: 'http://127.0.0.1:11434' }, () => true)).toBe(true);
    expect((await plain.call('GET', '/api/host/ui')).body).toEqual({ host: false });
  });
});
