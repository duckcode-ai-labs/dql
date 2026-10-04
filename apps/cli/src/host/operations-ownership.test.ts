import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * RFC 0010: an operation (an Ask in progress, a page run, a refresh) belongs
 * to the person who started it. With a host, the operations list, one
 * operation by id, cancelling it and the live operations stream are each
 * person's own; without a host the one user sees every operation, as before.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const QUESTION = 'CANARY-OPERATION-QUESTION-7f3a: claims by region';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hooks?: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operations-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operations' }));
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  const stream = async (person: string) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/operations/events`, { headers: { 'x-test-person': person }, signal: controller.signal });
    const frames: string[] = [];
    const reader = response.body!.getReader();
    void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; frames.push(Buffer.from(value).toString('utf8')); } } catch { /* closed */ } })();
    return { frames, close: () => controller.abort() };
  };
  return { call, stream };
}

const operationsOf = (text: string): Array<{ id: string; ownerId?: string; message: string }> => (JSON.parse(text) as { operations: Array<{ id: string; ownerId?: string; message: string }> }).operations;

describe('with a host, operations are the person\'s own', () => {
  it('lists, reads, cancels and streams only your own operations', async () => {
    const { call, stream } = await start({});
    const watching = await stream('dan');
    await call('priya', 'POST', '/api/agent-runs', { question: QUESTION });
    await new Promise((done) => setTimeout(done, 400));
    const mine = operationsOf((await call('priya', 'GET', '/api/operations?limit=20')).text);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((operation) => operation.ownerId === 'u-priya')).toBe(true);

    const theirs = await call('dan', 'GET', '/api/operations?limit=20');
    expect(theirs.status).toBe(200);
    expect(theirs.text).not.toContain('CANARY-OPERATION-QUESTION-7f3a');
    expect(operationsOf(theirs.text).some((operation) => mine.some((own) => own.id === operation.id))).toBe(false);
    expect((await call('dan', 'GET', `/api/operations/${encodeURIComponent(mine[0].id)}`)).status).toBe(404);
    expect((await call('dan', 'DELETE', `/api/operations/${encodeURIComponent(mine[0].id)}`)).status).toBe(404);
    expect((await call('priya', 'GET', `/api/operations/${encodeURIComponent(mine[0].id)}`)).status).toBe(200);

    // Ask traces follow their runs: someone else's are neither listed nor found.
    const runId = mine.find((operation) => (operation as { scope?: string }).scope?.startsWith('agent-run:')) as { scope?: string } | undefined;
    const priyasTraces = await call('priya', 'GET', '/api/ask-traces');
    const dansTraces = await call('dan', 'GET', '/api/ask-traces');
    if (priyasTraces.status === 200) {
      const theirs = (JSON.parse(dansTraces.text) as { traces?: Array<{ runId?: string }> }).traces ?? [];
      expect(theirs.filter((trace) => runId?.scope?.endsWith(trace.runId ?? '~'))).toEqual([]);
      expect(dansTraces.text).not.toContain('CANARY-OPERATION-QUESTION-7f3a');
      if (runId?.scope) expect((await call('dan', 'GET', `/api/ask-traces/by-run/${encodeURIComponent(runId.scope.slice('agent-run:'.length))}`)).status).toBe(404);
    }

    const late = await stream('dan');
    await new Promise((done) => setTimeout(done, 300));
    watching.close();
    late.close();
    for (const frames of [watching.frames, late.frames]) {
      expect(frames.join('')).not.toContain('CANARY-OPERATION-QUESTION-7f3a');
      for (const id of mine.map((operation) => operation.id)) expect(frames.join('')).not.toContain(id);
    }
  });
});

describe('with host hooks but nobody signed in (a host without resolvePrincipal), no operation is shown', () => {
  it('lists, reads and streams none, and cancels none', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-operations-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'operations' }));
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      hostHooks: { rowPolicy: ({ sql }) => ({ sql }) },
      captureServer: (created) => { servers.push(created); },
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, text: await response.text() };
    };
    const asked = await call('POST', '/api/agent-runs', { question: QUESTION });
    expect(asked.status, asked.text.slice(0, 200)).toBeLessThan(300);
    await new Promise((done) => setTimeout(done, 400));
    // The operation exists (its owner is nobody); it is simply not shown to a request with no person.
    const { LocalOperationCoordinator } = await import('../local-operation-coordinator.js');
    const store = new LocalOperationCoordinator(join(projectRoot, '.dql', 'cache', 'operations.sqlite'));
    expect(store.list(20, {}).length).toBeGreaterThan(0);
    const listed = await call('GET', '/api/operations?limit=20');
    expect(listed.status).toBe(200);
    expect(operationsOf(listed.text)).toEqual([]);
    expect(listed.text).not.toContain('CANARY-OPERATION-QUESTION-7f3a');
    const controller = new AbortController();
    const events = await fetch(`${base}/api/operations/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const first = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString('utf8');
    controller.abort();
    expect(first).not.toContain('CANARY-OPERATION-QUESTION-7f3a');
  });
});

describe('without a host, the one user sees every operation', () => {
  it('lists operations without an owner', async () => {
    const { call } = await start();
    await call('', 'POST', '/api/agent-runs', { question: QUESTION });
    await new Promise((done) => setTimeout(done, 400));
    const all = operationsOf((await call('', 'GET', '/api/operations?limit=20')).text);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((operation) => operation.ownerId === undefined)).toBe(true);
    expect((await call('', 'GET', `/api/operations/${encodeURIComponent(all[0].id)}`)).status).toBe(200);
  });
});

describe('with a host, agent memory: one\'s own notes are one\'s own; notes for everyone are a project change', () => {
  it('keys personal notes by the person, hides them from others, and refuses shared notes without project.write', async () => {
    const { call } = await start({ authorize: (principal, action) => ({ allow: !(action === 'project.write' && principal.id === 'u-priya') }) });
    const shared = await call('priya', 'POST', '/api/agent/memory', { scope: 'project', title: 'rule', content: 'CANARY-MEMORY-SHARED-7f3a' });
    expect(shared.status).toBe(403);
    const own = await call('priya', 'POST', '/api/agent/memory', { scope: 'user', scopeId: 'u-dan', title: 'mine', content: 'CANARY-MEMORY-OWN-7f3a' });
    expect(own.status).toBe(200);
    const saved = (JSON.parse(own.text) as { memory: { id: string; scopeId?: string } }).memory;
    expect(saved.scopeId).toBe('u-priya');
    expect((await call('priya', 'GET', '/api/agent/memory')).text).toContain('CANARY-MEMORY-OWN-7f3a');
    expect((await call('dan', 'GET', '/api/agent/memory')).text).not.toContain('CANARY-MEMORY-OWN-7f3a');
    expect((await call('dan', 'DELETE', `/api/agent/memory?id=${encodeURIComponent(saved.id)}`)).status).toBe(404);
    expect((await call('dan', 'POST', '/api/agent/memory', { id: saved.id, scope: 'user', title: 'x', content: 'overwritten' })).status).toBe(404);
    expect((await call('dan', 'POST', '/api/agent/memory', { scope: 'project', title: 'rule', content: 'shared note' })).status).toBe(200);
    expect((await call('priya', 'POST', '/api/agent/memory/default-files')).status).toBe(403);
  });
});
