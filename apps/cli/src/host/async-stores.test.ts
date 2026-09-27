import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import {
  ConversationStore,
  MemoryStore,
  SqliteAgentRunStore,
  defaultAgentRunSqlitePath,
  defaultConversationPath,
  defaultMemoryPath,
} from '@duckcodeailabs/dql-agent';
import { startLocalServer } from '../local-runtime.js';
import type { DqlConversationStore, DqlHostHooks, DqlMemoryStore, DqlPrincipal, DqlRunStore } from './request-context.js';

/**
 * RFC 0010 HH-6: a host's stores answer with Promises (a shared database, so
 * several copies of DQL can serve one project). DQL awaits every call, keeps
 * each person's runs and threads their own, and never opens the project's
 * SQLite files for them.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every method answers a tick later, as a network database would; `close` leaves the shared store open. */
function promised<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== 'function') return value;
      if (property === 'close') return async () => { calls.push('close'); };
      return async (...args: unknown[]) => {
        calls.push(String(property));
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

async function start() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-async-stores-'));
  const hostRoot = mkdtempSync(join(tmpdir(), 'dql-async-stores-host-'));
  roots.push(projectRoot, hostRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'async_stores' }));
  const calls = { runs: [] as string[], conversations: [] as string[], memory: [] as string[] };
  const runs = promised(new SqliteAgentRunStore({ path: join(hostRoot, 'runs.sqlite') }), calls.runs) as unknown as DqlRunStore;
  const conversations = promised(new ConversationStore(join(hostRoot, 'threads.sqlite')), calls.conversations) as unknown as DqlConversationStore;
  const memory = promised(new MemoryStore(join(hostRoot, 'memory.sqlite')), calls.memory) as unknown as DqlMemoryStore;
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const hooks: Partial<DqlHostHooks> = {
    resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
    stores: { runs, conversations: () => conversations, memory: () => memory },
  };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    hostHooks: hooks as DqlHostHooks,
    captureServer: (created) => { servers.push(created); },
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-person': person },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { call, calls, projectRoot };
}

describe('stores that answer with Promises (HH-6)', () => {
  it('keeps threads, turns and runs in the host store, each person seeing only their own', async () => {
    const { call, calls, projectRoot } = await start();
    const thread = await call('priya', 'POST', '/api/agent/threads', { title: 'Claims by region', surface: 'ask' });
    expect(thread.status).toBe(201);
    expect(thread.body.thread.ownerId).toBe('u-priya');
    const threadId = thread.body.thread.id as string;

    // A question in her thread: whatever the answer, it is stored as hers, in the host's store.
    const asked = await call('priya', 'POST', '/api/agent-runs', { question: 'Claims paid last week', threadId });
    expect(asked.status).toBeLessThan(500);
    const runId = (asked.body.run?.id ?? asked.body.runId) as string;
    expect(runId).toBeTruthy();

    const opened = await call('priya', 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
    expect(opened.status).toBe(200);
    expect(opened.body.turns.map((turn: { question: string }) => turn.question)).toEqual(['Claims paid last week']);
    expect(opened.body.runs.map((run: { id: string }) => run.id)).toEqual([runId]);

    const priyaRuns = await call('priya', 'GET', '/api/agent-runs');
    expect(priyaRuns.body.runs.map((run: { id: string }) => run.id)).toEqual([runId]);
    expect(priyaRuns.body.total).toBe(1);
    expect((await call('priya', 'GET', `/api/agent-runs/${runId}`)).status).toBe(200);
    expect((await call('priya', 'GET', `/api/agent-runs/${runId}/thread`)).body).toEqual({ threadId });

    // Dan sees none of it.
    expect((await call('dan', 'GET', '/api/agent-runs')).body).toMatchObject({ runs: [], total: 0 });
    expect((await call('dan', 'GET', `/api/agent-runs/${runId}`)).status).toBe(404);
    expect((await call('dan', 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`)).status).toBe(404);
    expect((await call('dan', 'GET', '/api/agent/threads/search?q=claims')).body.turns).toEqual([]);
    expect((await call('priya', 'GET', '/api/agent/threads/search?q=claims')).body.turns).toHaveLength(1);

    // Rename, pin, then delete: each an awaited host call.
    const renamed = await call('priya', 'PATCH', `/api/agent/threads/${encodeURIComponent(threadId)}`, { title: 'CA claims', favorite: true });
    expect(renamed.body.thread).toMatchObject({ title: 'CA claims', favorite: true });

    // Memory goes to the host store too.
    const saved = await call('priya', 'POST', '/api/agent/memory', { scope: 'project', title: 'Claims', content: 'Claims are paid on the settlement date.' });
    expect(saved.body.memory.title).toBe('Claims');
    expect((await call('priya', 'GET', '/api/agent/memory')).body.memories.map((item: { id: string }) => item.id)).toEqual([saved.body.memory.id]);
    expect((await call('priya', 'DELETE', `/api/agent/memory?id=${saved.body.memory.id}`)).status).toBe(200);
    expect((await call('priya', 'GET', '/api/agent/memory')).body.memories).toEqual([]);

    expect((await call('priya', 'DELETE', `/api/agent/threads/${encodeURIComponent(threadId)}`)).status).toBe(200);
    expect((await call('priya', 'GET', '/api/agent/threads')).body.threads).toEqual([]);

    expect(calls.runs).toEqual(expect.arrayContaining(['save', 'get', 'list', 'count']));
    expect(calls.conversations).toEqual(expect.arrayContaining(['createThread', 'getThread', 'appendTurn', 'recentTurns', 'searchTurns', 'renameThread', 'deleteThread']));
    expect(calls.memory).toEqual(expect.arrayContaining(['upsert', 'list', 'delete']));
    // The project's own SQLite stores were never opened.
    expect(existsSync(defaultAgentRunSqlitePath(projectRoot))).toBe(false);
    expect(existsSync(defaultConversationPath(projectRoot))).toBe(false);
    expect(existsSync(defaultMemoryPath(projectRoot))).toBe(false);
  });

  it('continues a thread from a second copy of DQL sharing the same stores', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'dql-async-stores-shared-'));
    roots.push(hostRoot);
    const shared = {
      runs: promised(new SqliteAgentRunStore({ path: join(hostRoot, 'runs.sqlite') }), []) as unknown as DqlRunStore,
      conversations: promised(new ConversationStore(join(hostRoot, 'threads.sqlite')), []) as unknown as DqlConversationStore,
    };
    const people: Record<string, DqlPrincipal> = { priya, dan };
    const copies = await Promise.all([0, 1].map(async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'dql-async-stores-copy-'));
      roots.push(projectRoot);
      writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'async_stores' }));
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor: {} as QueryExecutor,
        preferredPort: 0,
        hostHooks: {
          resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
          stores: { runs: shared.runs, conversations: () => shared.conversations },
        } as DqlHostHooks,
        captureServer: (created) => { servers.push(created); },
      });
      return async (person: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'x-test-person': person },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
    }));
    const [a, b] = copies;
    const threadId = (await a('priya', 'POST', '/api/agent/threads', { title: 'Claims', surface: 'ask' })).body.thread.id as string;
    await a('priya', 'POST', '/api/agent-runs', { question: 'Claims paid last week', threadId });
    await b('priya', 'POST', '/api/agent-runs', { question: 'And the week before?', threadId });
    const onB = await b('priya', 'GET', `/api/agent/threads/${encodeURIComponent(threadId)}`);
    expect(onB.body.turns.map((turn: { question: string; seq: number }) => [turn.seq, turn.question])).toEqual([[1, 'Claims paid last week'], [2, 'And the week before?']]);
    // The second copy refuses Dan exactly as the first would.
    expect((await b('dan', 'POST', '/api/agent-runs', { question: 'continue her thread', threadId })).status).toBe(404);
    expect((await a('priya', 'GET', '/api/agent-runs')).body.total).toBe(2);
  });
});
