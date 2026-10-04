import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { LocalNotebookResearchStorage, defaultNotebookResearchDbPath } from '@duckcodeailabs/dql-project';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * With a host, conversations belong to the person who had them, the host
 * decides whom answers are written for, and Research needs its own permission
 * even when requested through Ask (RFC 0010).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hooks: Partial<DqlHostHooks> = {}, seen?: { audiences: Array<string | undefined> }) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-per-person-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'per_person' }));
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...hooks },
    captureServer: (created) => { servers.push(created); },
    ...(seen ? { askAnalyticalPlannerProviderFactory: ({ request }) => { seen.audiences.push(request.audience); return null; } } : {}),
  });
  const base = `http://127.0.0.1:${port}`;
  return async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-person': person },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
}

describe('conversations belong to the person who had them', () => {
  it('lists, opens, searches and continues only your own threads', async () => {
    const call = await start();
    const mine = await call('priya', 'POST', '/api/agent/threads', { title: 'Claims by region', surface: 'ask' });
    expect(mine.status).toBe(201);
    expect(mine.body.thread.ownerId).toBe('u-priya');
    await call('dan', 'POST', '/api/agent/threads', { title: 'Subrogation', surface: 'ask' });

    const priyaList = await call('priya', 'GET', '/api/agent/threads');
    expect(priyaList.body.threads.map((thread: { title: string }) => thread.title)).toEqual(['Claims by region']);
    const danList = await call('dan', 'GET', '/api/agent/threads');
    expect(danList.body.threads.map((thread: { title: string }) => thread.title)).toEqual(['Subrogation']);

    const threadId = encodeURIComponent(mine.body.thread.id);
    expect((await call('dan', 'PATCH', `/api/agent/threads/${threadId}`, { title: 'mine now' })).status).toBe(404);
    expect((await call('dan', 'DELETE', `/api/agent/threads/${threadId}`)).status).toBe(404);
    expect((await call('dan', 'POST', `/api/agent/threads/${threadId}/archive`)).status).toBe(404);
    expect((await call('dan', 'POST', '/api/agent-runs', { question: 'continue her thread', threadId: mine.body.thread.id })).status).toBe(404);
    expect((await call('priya', 'PATCH', `/api/agent/threads/${threadId}`, { title: 'CA claims' })).body.thread.title).toBe('CA claims');
  });
});

describe('notebook research runs belong to the person who ran them', () => {
  it('lists, opens and changes only your own research runs, questions included', async () => {
    const call = await start();
    const question = 'CANARY-RESEARCH-QUESTION-7f3a: why did West claims rise?';
    const created = await call('priya', 'POST', '/api/notebook/research', { notebookPath: 'notebooks/claims.dqlnb', question });
    expect(created.status).toBe(201);
    const id = created.body.run.id as string;
    expect((await call('priya', 'GET', '/api/notebook/research')).body.runs.map((run: { id: string }) => run.id)).toEqual([id]);
    // Dan sees none of it: not in his list, not by id, not to change or rerun.
    const dansList = await call('dan', 'GET', '/api/notebook/research');
    expect(dansList.body.runs).toEqual([]);
    expect(JSON.stringify(dansList.body)).not.toContain('CANARY-RESEARCH-QUESTION');
    expect((await call('dan', 'GET', `/api/notebook/research/${encodeURIComponent(id)}`)).status).toBe(404);
    expect((await call('dan', 'PATCH', `/api/notebook/research/${encodeURIComponent(id)}`, { question: 'mine now' })).status).toBe(404);
    expect(JSON.stringify((await call('dan', 'GET', '/api/notebook/research/diagnostics')).body)).not.toContain('CANARY-RESEARCH-QUESTION');
    expect((await call('priya', 'GET', `/api/notebook/research/${encodeURIComponent(id)}`)).body.run.question).toBe(question);
  });

  it('names the person signed in as the owner, never a name in the request, and keeps it on every change', async () => {
    const call = await start();
    const created = await call('priya', 'POST', '/api/notebook/research', { notebookPath: 'notebooks/claims.dqlnb', question: 'Who owns this?', owner: 'maria@harbor.example' });
    expect(created.status).toBe(201);
    expect(created.body.run.owner).toBe('priya@harbor.example');
    const id = created.body.run.id as string;
    const patched = await call('priya', 'PATCH', `/api/notebook/research/${encodeURIComponent(id)}`, { title: 'Renamed', owner: 'maria@harbor.example' });
    expect(patched.status).toBe(200);
    expect(patched.body.run).toMatchObject({ title: 'Renamed', owner: 'priya@harbor.example' });
    const seeded = await call('priya', 'POST', '/api/notebook/research/seed-cells', { notebookPath: 'notebooks/seeded.dqlnb', owner: 'maria@harbor.example', cells: [{ id: 'c1', name: 'claims', sql: 'SELECT 1' }] });
    expect(seeded.status, JSON.stringify(seeded.body).slice(0, 300)).toBeLessThan(300);
    const mine = await call('priya', 'GET', '/api/notebook/research?limit=50');
    expect(mine.body.runs.map((run: { owner?: string }) => run.owner).filter((owner: string | undefined) => owner !== 'priya@harbor.example')).toEqual([]);
    // Someone else's id is not found on every route that takes one.
    for (const [method, action, body] of [['POST', 'run', {}], ['POST', 'review', { decision: 'approved' }], ['POST', 'reuse-check', {}], ['POST', 'promote-dql', {}], ['DELETE', '', undefined]] as Array<[string, string, unknown]>) {
      const answer = await call('dan', method, `/api/notebook/research/${encodeURIComponent(id)}${action ? `/${action}` : ''}`, body);
      expect(answer.status, `${method} ${action}`).toBe(404);
    }
    expect((await call('priya', 'GET', `/api/notebook/research/${encodeURIComponent(id)}`)).body.run).toMatchObject({ title: 'Renamed', owner: 'priya@harbor.example' });
  });

  it('with host hooks and nobody signed in, shows no one\'s runs and keeps none; the store from before the host is not read', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-research-nobody-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'per_person' }));
    const before = new LocalNotebookResearchStorage(defaultNotebookResearchDbPath(projectRoot));
    before.createRun({ notebookPath: 'notebooks/old.dqlnb', title: 'Before the host', question: 'CANARY-SHARED-RESEARCH-7f3a' });
    before.close();
    // A host that names nobody (no resolvePrincipal), then one that signs Priya in, on the same project.
    const serve = async (hostHooks: Partial<DqlHostHooks>) => {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, hostHooks, captureServer: (created) => { servers.push(created); } });
      return async (person: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, text: await response.text() };
      };
    };
    const call = await serve({});
    const signedIn = await serve({ resolvePrincipal: () => priya });
    const nobody = await call('', 'GET', '/api/notebook/research');
    expect(nobody.status).toBe(200);
    expect(JSON.parse(nobody.text).runs).toEqual([]);
    expect((await call('', 'POST', '/api/notebook/research', { notebookPath: 'notebooks/x.dqlnb', question: 'anyone?' })).status).toBe(403);
    expect((await call('', 'GET', '/api/notebook/research/diagnostics')).status).toBe(403);
    const priyas = await signedIn('priya', 'GET', '/api/notebook/research');
    expect(priyas.status).toBe(200);
    expect(priyas.text).not.toContain('CANARY-SHARED-RESEARCH');
  });
});

describe('without a host, the one local research store as before', () => {
  it('keeps the owner the request names and lists every run', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-research-local-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'local' }));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const post = await fetch(`http://127.0.0.1:${port}/api/notebook/research`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notebookPath: 'notebooks/a.dqlnb', question: 'Mine', owner: 'analyst@local' }) });
    expect(post.status).toBe(201);
    expect(((await post.json()) as { run: { owner?: string } }).run.owner).toBe('analyst@local');
    const store = new LocalNotebookResearchStorage(defaultNotebookResearchDbPath(projectRoot));
    expect(store.listRunsPage({ limit: 10 }).runs.map((run) => run.question)).toEqual(['Mine']);
    store.close();
  });
});

describe('the host decides audience and Research', () => {
  it('refuses Research through Ask without the research permission', async () => {
    const call = await start({
      authorize: (principal, action) => ({ allow: !(principal.id === 'u-priya' && action === 'research'), reason: 'Research is for analysts.' }),
    });
    const refused = await call('priya', 'POST', '/api/agent-runs', { question: 'Why did claims rise?', requestedMode: 'research' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'PERMISSION_DENIED', action: 'research', error: 'Research is for analysts.' });
    const allowed = await call('dan', 'POST', '/api/agent-runs', { question: 'Why did claims rise?', requestedMode: 'research' });
    expect(allowed.status).not.toBe(403);
  });

  it('writes answers for whom the host says, not the request body', async () => {
    const asked: string[] = [];
    const seen = { audiences: [] as Array<string | undefined> };
    const call = await start({
      audience: (principal) => { asked.push(principal.id); return principal.id === 'u-priya' ? 'stakeholder' : 'analyst'; },
    }, seen);
    await call('priya', 'POST', '/api/agent-runs', { question: 'Claims paid last week', audience: 'analyst' });
    await call('dan', 'POST', '/api/agent-runs', { question: 'Claims paid last week', audience: 'stakeholder' });
    expect(asked).toEqual(['u-priya', 'u-dan']);
    // Each asked for the other audience in the body; the host's answer is what the pipeline gets.
    expect(seen.audiences).toEqual(['stakeholder', 'analyst']);
  });
});

describe('what the app shows around its screens (HH-9)', () => {
  it('describes the person, what they may do, and the host additions; only same-origin links', async () => {
    const call = await start({
      authorize: (principal, action) => ({ allow: principal.id === 'u-dan' || ['project.read', 'ask', 'app.view', 'export'].includes(action) }),
      ui: () => ({
        signOutUrl: '/auth/logout',
        environment: 'Claims · Production',
        links: [
          { id: 'requests', label: 'My requests', href: '/e/requests', placement: 'nav' },
          { id: 'evil', label: 'Elsewhere', href: 'https://evil.example/x', placement: 'menu' },
          { id: 'proto', label: 'Protocol-relative', href: '//evil.example', placement: 'menu' },
        ],
        answerActions: [{ id: 'certify', label: 'Make this a certified answer', url: '/enterprise/api/requests' }, { id: 'bad', label: 'x', url: 'https://evil.example' }],
        banner: {
          text: '  Draft space —\n changes go to review, not Production  ',
          tone: 'caution',
          links: [{ label: 'Back to Production', href: '/enterprise/env/production' }, { label: 'Elsewhere', href: 'https://evil.example' }, { label: 'Protocol-relative', href: '//evil.example' }],
        },
      }),
    });
    const priyaUi = await call('priya', 'GET', '/api/host/ui');
    expect(priyaUi.body).toMatchObject({
      host: true,
      person: { id: 'u-priya', name: 'priya@harbor.example' },
      signOutUrl: '/auth/logout',
      environment: 'Claims · Production',
      links: [{ id: 'requests', label: 'My requests', href: '/e/requests', placement: 'nav' }],
      answerActions: [{ id: 'certify', label: 'Make this a certified answer', url: '/enterprise/api/requests' }],
      // The banner is plain text with same-origin links only.
      banner: { text: 'Draft space — changes go to review, not Production', tone: 'caution', links: [{ label: 'Back to Production', href: '/enterprise/env/production' }] },
    });
    expect(priyaUi.body.capabilities).toMatchObject({ ask: true, 'dataset.author': false, 'dataset.certify': false, 'settings.manage': false });
    expect((await call('dan', 'GET', '/api/host/ui')).body.capabilities).toMatchObject({ 'dataset.author': true, 'settings.manage': true });
    // The host sets up the project: nobody it signs in gets the first-run review.
    expect((await call('priya', 'GET', '/api/onboarding/launch')).body).toMatchObject({ shouldOpen: false, reason: null, hostManaged: true });
  });

  it('says why an action is refused and where to go, who the screens speak to, and what a missing App says; only same-origin links', async () => {
    const call = await start({
      authorize: (principal, action) => (principal.id === 'u-priya' && action === 'ask'
        ? { allow: false, reason: 'Asking needs the explorer role in this workspace.', next: { label: 'Request access', href: '/e/access' } }
        : principal.id === 'u-priya' && action === 'research'
          ? { allow: false, reason: 'Research is for analysts.', next: { label: 'Elsewhere', href: 'https://evil.example/' } }
          : { allow: principal.id === 'u-dan' || ['project.read', 'app.view'].includes(action) }),
      ui: (principal) => (principal.id === 'u-priya'
        ? { audience: 'reader', appNotFound: { message: '  This App is not in Claims.\n Switch workspace or ask for access. ', next: { label: 'Switch workspace', href: '/e/workspaces' } } }
        : { audience: 'everyone' as never, appNotFound: { message: 'x', next: { label: 'Elsewhere', href: '//evil.example' } } }),
    });
    const priyaUi = (await call('priya', 'GET', '/api/host/ui')).body;
    expect(priyaUi.capabilities).toMatchObject({ ask: false, research: false });
    expect(priyaUi.refusals.ask).toEqual({ reason: 'Asking needs the explorer role in this workspace.', next: { label: 'Request access', href: '/e/access' } });
    expect(priyaUi.refusals.research).toEqual({ reason: 'Research is for analysts.' });
    expect(priyaUi.audience).toBe('reader');
    expect(priyaUi.appNotFound).toEqual({ message: 'This App is not in Claims. Switch workspace or ask for access.', next: { label: 'Switch workspace', href: '/e/workspaces' } });
    // Only `reader` is passed on; a link elsewhere is dropped; what Dan may do carries no refusal.
    const danUi = (await call('dan', 'GET', '/api/host/ui')).body;
    expect(danUi.audience).toBeUndefined();
    expect(danUi.appNotFound).toEqual({ message: 'x' });
    expect(danUi.refusals).toBeUndefined();
  });

  it('says there is no host when there is none', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-no-host-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'no_host' }));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/host/ui`)).json()).toEqual({ host: false });
    const launch = await (await fetch(`http://127.0.0.1:${port}/api/onboarding/launch`)).json() as Record<string, unknown>;
    expect(launch.hostManaged).toBeUndefined();
  });
});

describe('answers belong to the person who asked (HH-10)', () => {
  it('lists and opens only your own runs, and gives a host your answer\'s facts and review status', async () => {
    const statusCalls: Array<{ person: string; runIds: string[] }> = [];
    const call = await start({
      answerStatus: (principal, runIds) => {
        statusCalls.push({ person: principal.id, runIds });
        return Object.fromEntries(runIds.map((id) => [id, { state: 'checked' as const, label: 'Checked by Dan Kim', detail: 'Matches the claims ledger.', href: '/e/requests/R-1' }]));
      },
    });
    const asked = await call('priya', 'POST', '/api/agent-runs', { question: 'Claims paid last week' });
    const runId: string = asked.body?.run?.id ?? asked.body?.id;
    expect(runId, JSON.stringify(asked.body).slice(0, 300)).toBeTruthy();
    await call('dan', 'POST', '/api/agent-runs', { question: 'Subrogation recoveries' });

    const priyaRuns = await call('priya', 'GET', '/api/agent-runs');
    expect(priyaRuns.body.runs.map((run: { question: string }) => run.question)).toEqual(['Claims paid last week']);
    expect(priyaRuns.body.total).toBe(1);
    expect((await call('dan', 'GET', '/api/agent-runs')).body.runs.map((run: { question: string }) => run.question)).toEqual(['Subrogation recoveries']);

    // Someone else's answer does not exist for you, wherever you look.
    expect((await call('dan', 'GET', `/api/agent-runs/${runId}`)).status).toBe(404);
    expect((await call('dan', 'GET', `/api/host/answers/${runId}`)).status).toBe(404);
    expect((await call('priya', 'GET', `/api/agent-runs/${runId}`)).status).toBe(200);

    const facts = await call('priya', 'GET', `/api/host/answers/${runId}`);
    expect(facts.status).toBe(200);
    expect(facts.body).toMatchObject({ runId, question: 'Claims paid last week', tables: expect.any(Array) });
    expect(JSON.stringify(facts.body)).not.toMatch(/"answer"|"rows"|"summary"/);

    const priyaStatus = await call('priya', 'POST', '/api/host/answer-status', { runIds: [runId, 'no-such-run'] });
    expect(priyaStatus.body.statuses).toEqual({ [runId]: { state: 'checked', label: 'Checked by Dan Kim', detail: 'Matches the claims ledger.', href: '/e/requests/R-1' } });
    // Dan asking about Priya's answer learns nothing, and the host is not even asked.
    expect((await call('dan', 'POST', '/api/host/answer-status', { runIds: [runId] })).body.statuses).toEqual({});
    expect(statusCalls).toEqual([{ person: 'u-priya', runIds: [runId] }]);
  });
});

describe('a host that names no one for a request (no resolvePrincipal)', () => {
  it('reads no one\'s answers, conversations, notebook runs or Home, and keeps none of its own', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-nobody-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'nobody' }));
    // What the server kept for its one user before it had a host.
    const local = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const before = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${local}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await before('/api/agent/threads', 'POST', { title: 'CANARY-NOBODY-7f3a', surface: 'ask' })).status).toBe(201);
    expect((await before('/api/run-snapshot', 'PUT', { path: 'notebooks/a.dqlnb', snapshot: { cells: [{ result: 'CANARY-NOBODY-7f3a' }] } })).status).toBe(200);
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, hostHooks: {}, captureServer: (created) => { servers.push(created); } });
    const nobody = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, text: await response.text() };
    };
    for (const path of ['/api/agent/threads', '/api/agent-runs', '/api/run-snapshot?path=notebooks%2Fa.dqlnb', '/api/home']) {
      expect((await nobody(path)).text, path).not.toContain('CANARY-NOBODY-7f3a');
    }
    expect(JSON.parse((await nobody('/api/agent-runs')).text).runs).toEqual([]);
    expect((await nobody('/api/run-snapshot', 'PUT', { path: 'notebooks/a.dqlnb', snapshot: { cells: [] } })).status).toBe(403);
  });
});

describe('a conversation turn kept as a note (HH-10, memory)', () => {
  it('is the person\'s own note by default; a note for everyone keeps the question, not the answer\'s figures', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-promote-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'promote' }));
    const answer = (() => ({ summary: 'West has FIGURE-4471 open claims', answer: 'West has FIGURE-4471 open claims', status: 'completed', trustState: 'governed', stopReason: 'answered', artifacts: [], evaluations: [], nextActions: [] })) as never;
    const people: Record<string, DqlPrincipal> = { priya, dan };
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      agentRunExecutors: { conversation: answer, generated_answer: answer, semantic_answer: answer, certified_answer: answer },
      hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, authorize: () => ({ allow: true }) },
      captureServer: (created) => { servers.push(created); },
    });
    const call = async (person: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
    };
    const thread = (await call('priya', 'POST', '/api/agent/threads', { title: 'Claims', surface: 'ask' })).body.thread.id as string;
    expect((await call('priya', 'POST', '/api/agent-runs', { question: 'How many open claims in the West?', threadId: thread })).status).toBeLessThan(300);
    const turnId = (await call('priya', 'GET', `/api/agent/threads/${thread}`)).body.turns[0].id as string;
    const own = await call('priya', 'POST', `/api/agent/threads/${thread}/promote`, { turnId });
    expect(own.status, own.text.slice(0, 200)).toBe(200);
    expect((await call('priya', 'GET', '/api/agent/memory')).text).toContain('FIGURE-4471');
    expect((await call('dan', 'GET', '/api/agent/memory')).text).not.toContain('FIGURE-4471');
    const shared = await call('priya', 'POST', `/api/agent/threads/${thread}/promote`, { turnId, scope: 'project' });
    expect(shared.status).toBe(200);
    const dans = await call('dan', 'GET', '/api/agent/memory');
    expect(dans.text).toContain('How many open claims in the West?');
    expect(dans.text).not.toContain('FIGURE-4471');
  });
});

describe('the local dataset workspace with a host several people share', () => {
  it('lists and keeps no one\'s data; a draft space (one person) keeps it; without a host, as before', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-datasets-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'datasets' }));
    const csv = Buffer.from('region,claims\nWest,1\n').toString('base64');
    const serve = async (hostHooks?: Partial<DqlHostHooks>) => {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, ...(hostHooks ? { hostHooks: { resolvePrincipal: () => priya, ...hostHooks } } : {}), captureServer: (created) => { servers.push(created); } });
      return async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, text: await response.text() };
      };
    };
    // Kept before the host, by the one local user: a staged copy with its preview rows.
    const id = 'ds_claims';
    mkdirSync(join(projectRoot, '.dql', 'local', 'datasets'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'datasets', 'registry.json'), JSON.stringify({ version: 1, datasets: [{ id, name: 'claims', alias: 'claims', tags: [], storageMode: 'local', format: 'csv', sourcePath: '.dql/local/datasets/claims.csv', refreshedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', profile: { rowCount: 1, columns: [], preview: [{ region: 'West', claims: 'CANARY-DATASET-7f3a' }] } }] }));
    const local = await serve();
    expect((await local('GET', '/api/datasets')).text).toContain('CANARY-DATASET-7f3a');
    const shared = await serve({});
    const listed = await shared('GET', '/api/datasets');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.text).datasets).toEqual([]);
    expect((await shared('GET', `/api/datasets/${id}`)).status).toBe(404);
    expect((await shared('POST', '/api/datasets/import', { filename: 'more.csv', contentBase64: csv })).status).toBe(403);
    expect((await shared('POST', '/api/datasets/stage', { confirmed: true, sql: 'SELECT 1' })).status).toBe(403);
    expect((await shared('DELETE', `/api/datasets/${id}`)).status).toBe(403);
    const draftSpace = await serve({ onePerson: true });
    expect((await draftSpace('GET', '/api/datasets')).text).toContain('CANARY-DATASET-7f3a');
    expect(listed.text).not.toContain('CANARY-DATASET-7f3a');
  });
});

describe('private skills and private blocks with a host several people share', () => {
  it('lists, makes and publishes none there; a draft space (one person) keeps them', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-private-drafts-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'private_drafts' }));
    mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'skills'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'skills', 'west-notes.skill.md'), '---\nid: west-notes\nscope: project\ndescription: CANARY-PRIVATE-SKILL-7f3a\n---\nWest claims are reviewed weekly. CANARY-PRIVATE-SKILL-7f3a\n');
    mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'blocks', 'west_claims.dql'), 'block "CANARY-PRIVATE-BLOCK-7f3a" {\n  domain = "claims"\n  type = "custom"\n  query = """SELECT 1"""\n}\n');
    const serve = async (hostHooks: Partial<DqlHostHooks>) => {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, hostHooks: { resolvePrincipal: () => dan, ...hostHooks }, captureServer: (created) => { servers.push(created); } });
      return async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, text: await response.text() };
      };
    };
    const shared = await serve({});
    expect((await shared('GET', '/api/skills')).text).not.toContain('CANARY-PRIVATE-SKILL-7f3a');
    expect((await shared('GET', '/api/blocks/library')).text).not.toContain('CANARY-PRIVATE-BLOCK-7f3a');
    expect((await shared('POST', '/api/skills/publish', { id: 'private::skill::west-notes' })).status).toBe(404);
    expect((await shared('DELETE', '/api/skills/private%3A%3Askill%3A%3Awest-notes')).status).toBe(404);
    expect((await shared('POST', '/api/skills', { skill: { id: 'mine', scope: 'project', body: 'x', visibility: 'private' } })).status).toBe(403);
    expect((await shared('POST', '/api/blocks', { name: 'mine', domain: 'claims', visibility: 'private' })).status).toBe(403);
    expect((await shared('POST', '/api/blocks/publish', { path: '.dql/local/private/blocks/west_claims.dql' })).status).toBe(404);
    const draftSpace = await serve({ onePerson: true });
    expect((await draftSpace('GET', '/api/skills')).text).toContain('CANARY-PRIVATE-SKILL-7f3a');
    expect((await draftSpace('GET', '/api/blocks/library')).text).toContain('CANARY-PRIVATE-BLOCK-7f3a');
  });
});

describe('a recorded correction with a host', () => {
  it('is a change to the project (project.write), and until reviewed only its author and reviewers list it', async () => {
    const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@harbor.example', source: 'host' };
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-corrections-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'corrections' }));
    const people: Record<string, DqlPrincipal> = { priya, dan, maria };
    const asked: string[] = [];
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      hostHooks: {
        resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
        // Priya may change the project here (a draft space would be the place); only Maria reviews hints.
        authorize: (principal, action) => {
          if (action === 'project.write') asked.push(principal.id);
          return { allow: action === 'hint.review' ? principal.id === 'u-maria' : action === 'project.write' ? principal.id !== 'u-dan' : true };
        },
      },
      captureServer: (created) => { servers.push(created); },
    });
    const call = async (person: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, text: await response.text() };
    };
    const correction = { question: 'CANARY-CORRECTION-7f3a open claims by region?', wrongSql: 'SELECT 1', correctedSql: 'SELECT region, COUNT(*) FROM claims GROUP BY region', scope: { metric: 'open_claims' } };
    // Dan may not change the project: his correction is refused before anything is written.
    expect((await call('dan', 'POST', '/api/agent/learnings/correction', correction)).status).toBe(403);
    expect((await call('priya', 'POST', '/api/agent/learnings/correction', correction)).status).toBe(200);
    expect(asked).toContain('u-priya');
    expect((await call('priya', 'GET', '/api/agent/hints')).text).toContain('CANARY-CORRECTION-7f3a');
    expect((await call('maria', 'GET', '/api/agent/hints')).text).toContain('CANARY-CORRECTION-7f3a');
    expect((await call('dan', 'GET', '/api/agent/hints')).text).not.toContain('CANARY-CORRECTION-7f3a');
  });
});
