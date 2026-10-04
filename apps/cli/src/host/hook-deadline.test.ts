import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { DEFAULT_HOST_HOOK_TIMEOUT_MS, HostHookTimeoutError, hooksWithDeadlines, hostHookTimeoutMs, withDeadline } from './hook-deadline.js';
import { withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 rule 1: every hook DQL waits for answers within a time limit, or
 * counts as failed, and failing is closed: a refusal in plain words, no
 * figures, nothing listed. An answer that comes after the limit is ignored.
 */
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckIt = connectorRoot ? it : it.skip;
const person: DqlPrincipal = { id: 'u-ana', kind: 'person', email: 'ana@example.test', source: 'host' };
const LIMIT = 300;
const never = <T>() => new Promise<T>(() => undefined);
const later = <T>(value: T, ms: number) => new Promise<T>((done) => setTimeout(() => done(value), ms));

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(hooks: Partial<DqlHostHooks>, options: { warehouse?: boolean; setup?: (root: string) => void } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hook-deadline-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'hook_deadline' }));
  options.setup?.(projectRoot);
  let executor = {} as QueryExecutor;
  let connection = { driver: 'file' } as ConnectionConfig;
  if (options.warehouse) {
    executor = new QueryExecutor();
    connection = { driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
  }
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0,
    hostHooks: { resolvePrincipal: () => person, ...hooks } as DqlHostHooks,
    hostHookTimeoutMs: LIMIT,
    captureServer: (created) => { servers.push(created); },
  });
  return async (method: string, path: string, body?: unknown) => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed, ms: Date.now() - started };
  };
}

describe('the time limit itself', () => {
  it('is 10 seconds unless the embedding program sets one', () => {
    expect(DEFAULT_HOST_HOOK_TIMEOUT_MS).toBe(10_000);
    expect(hostHookTimeoutMs(undefined)).toBe(10_000);
    expect(hostHookTimeoutMs(-1)).toBe(10_000);
    expect(hostHookTimeoutMs('5000')).toBe(10_000);
    expect(hostHookTimeoutMs(2_500)).toBe(2_500);
  });

  it('answers in time as the hook did, fails a hook that does not, and ignores a late answer', async () => {
    expect(await withDeadline('x', 200, () => 'ok')).toBe('ok');
    await expect(withDeadline('x', 50, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withDeadline('authorize', 50, () => later({ allow: true }, 300))).rejects.toBeInstanceOf(HostHookTimeoutError);
  });

  it('bounds only the hooks the host gave, so "has a hook" keeps its meaning', () => {
    const bounded = hooksWithDeadlines({ authorize: () => ({ allow: true }), traceSalt: 'k', enterpriseCertification: true }, LIMIT);
    expect(Object.keys(bounded).sort()).toEqual(['authorize', 'enterpriseCertification', 'traceSalt']);
    expect(bounded.traceSalt).toBe('k');
  });

  it('the tool gate: a gate that has not decided in time refuses the tool, and a next() it calls later never runs it', async () => {
    let ran = 0;
    let lateNext: (() => Promise<unknown>) | undefined;
    const bounded = hooksWithDeadlines({ tools: (_call, next) => { lateNext = next; return never(); } }, 100);
    await expect(bounded.tools!({ name: 'run_sql', args: {}, principal: person }, async () => { ran += 1; return 'ran'; })).rejects.toBeInstanceOf(HostHookTimeoutError);
    await expect(lateNext!()).rejects.toBeInstanceOf(HostHookTimeoutError);
    expect(ran).toBe(0);
    // A gate that decided in time is not cut short by a tool that runs longer than the limit.
    const slowTool = hooksWithDeadlines({ tools: (_call, next) => next() }, 50);
    expect(await slowTool.tools!({ name: 'run_sql', args: {}, principal: person }, () => later('done', 150))).toBe('done');
  });
});

describe('a hook that does not answer in time, on a hosted server', () => {
  it('resolvePrincipal: refused in plain words (503, not "sign in"), within the limit', async () => {
    const call = await serve({ resolvePrincipal: () => never() });
    const answer = await call('GET', '/api/identity');
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: 'DQL could not check who you are right now. Try again in a moment.', code: 'HOST_UNAVAILABLE' });
    expect(answer.ms).toBeLessThan(3_000);
  });

  it('authorize: refused in plain words; an "allow" that arrives after the limit does not let it through', async () => {
    for (const hook of [() => never<{ allow: boolean }>(), () => later({ allow: true }, 900)]) {
      const call = await serve({ authorize: hook });
      const answer = await call('POST', '/api/agent/threads', { title: 'x', surface: 'ask' });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: 'PERMISSION_DENIED', error: 'DQL could not check what you may do right now. Try again in a moment.' });
      expect(answer.ms).toBeLessThan(3_000);
    }
  });

  duckIt('rowPolicy and credentials: the statement is refused and never runs', async () => {
    for (const hooks of [{ rowPolicy: () => never<never>() }, { credentials: () => never<never>() }] as Array<Partial<DqlHostHooks>>) {
      let ran = 0;
      const call = await serve({ ...hooks, statements: (event) => { if (event.outcome === 'ok') ran += 1; } }, { warehouse: true });
      const answer = await call('POST', '/api/query', { sql: 'SELECT 1 AS n' });
      expect(answer.status, answer.text.slice(0, 200)).toBe(403);
      expect(answer.body?.code).toBe('POLICY_DENIED');
      expect(answer.ms).toBeLessThan(3_000);
      expect(ran).toBe(0);
    }
  }, 60_000);

  it('ui, answerStatus, directoryGroups, homeCards, follows: the screens get nothing from the host, in time', async () => {
    const call = await serve({
      ui: () => never(),
      answerStatus: () => never(),
      directoryGroups: () => never(),
      homeCards: () => never(),
      follows: { list: () => never(), set: () => never() },
    }, { setup: (root) => {
      mkdirSync(join(root, 'apps', 'claims'), { recursive: true });
      writeFileSync(join(root, 'apps', 'claims', 'dql.app.json'), JSON.stringify({ version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft', owners: ['t@example.test'] }));
    } });
    const ui = await call('GET', '/api/host/ui');
    expect(ui.status).toBe(200);
    expect(ui.body).toMatchObject({ host: true, links: [], answerActions: [] });
    expect((await call('POST', '/api/host/answer-status', { runIds: ['r1'] })).body).toEqual({ statuses: {} });
    expect((await call('GET', '/api/host/groups')).body).toEqual({ source: 'host', groups: [] });
    expect((await call('GET', '/api/host/home-cards')).body).toEqual({ cards: [] });
    expect((await call('GET', '/api/apps/claims/follow')).body?.follows).toEqual([]);
    const follow = await call('POST', '/api/apps/claims/follow', { following: true });
    expect(follow.status).toBeGreaterThanOrEqual(400);
    for (const answer of [ui, follow]) expect(answer.ms).toBeLessThan(3_000);
  });

  it('stores: a store call that does not answer is a plain message with a reference', async () => {
    const stuck = new Proxy({}, { get: (_t, property) => (property === 'then' ? undefined : () => never()) });
    const call = await serve({ stores: { runs: stuck as never, conversations: () => stuck as never } });
    for (const path of ['/api/agent-runs', '/api/agent/threads']) {
      const answer = await call('GET', path);
      expect(answer.status, path).toBeGreaterThanOrEqual(500);
      expect(String(answer.body?.error ?? answer.body?.message ?? ''), path).toMatch(/^DQL could not reach its saved (answers|conversations) right now\..*reference [bcdfghjkmnpqrstvwxz]{8}\.$/);
      expect(answer.ms).toBeLessThan(3_000);
    }
  });

  it('tools: a gate that does not decide in time refuses the tool', async () => {
    const { runGatedTool } = await import('@duckcodeailabs/dql-agent');
    let ran = 0;
    const hooks = hooksWithDeadlines({ tools: () => never() }, LIMIT);
    await withRequestContext({ principal: person, requestId: 'r', hooks }, async () => {
      await expect(runGatedTool({ name: 'run_sql', run: async () => { ran += 1; return 'ran'; } }, {})).rejects.toBeInstanceOf(HostHookTimeoutError);
    });
    expect(ran).toBe(0);
  });

  it('delivery: a sink that does not answer is "not delivered", within six times the limit', async () => {
    const hooks = hooksWithDeadlines({ delivery: () => never() }, 50);
    const { dispatchNotifications } = await import('../schedule/notifiers/index.js');
    const started = Date.now();
    const results = await withRequestContext({ principal: person, requestId: 'r', hooks }, () => dispatchNotifications([{ type: 'email', recipients: ['a@example.test'] } as never], { block: 'b', path: 'p', startedAt: 't', alerts: [], queries: [], trigger: 'cron' } as never, tmpdir()));
    expect(results).toEqual([expect.objectContaining({ delivered: false })]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
