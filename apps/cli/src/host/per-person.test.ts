import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
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
