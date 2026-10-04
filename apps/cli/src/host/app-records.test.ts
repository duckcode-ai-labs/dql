import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { createAppBuildDraft } from '@duckcodeailabs/dql-core';
import { LocalAppStorage, defaultLocalAppsDbPath } from '@duckcodeailabs/dql-project';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * RFC 0010: an App's analysis memos (investigations, run as the person who asked, with their result previews) and
 * App conversations are each person's with a host: listed, opened, run, pinned, changed and reused only for them,
 * and the App's own document lists only theirs. Memos and conversations kept before the host have no owner and are
 * no one's with one. Without a host, the one local user sees every record, as before.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const CANARY = 'CANARY-APP-MEMO-7f3a';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-records-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'app_records' }));
  mkdirSync(join(projectRoot, 'apps', 'claims', 'dashboards'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
    version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
    owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1, id: 'overview', metadata: { title: 'Overview' }, layout: { kind: 'grid', cols: 12, rowHeight: 40, items: [] },
  }));
  return projectRoot;
}

async function serve(projectRoot: string, hostHooks?: Partial<DqlHostHooks>) {
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hostHooks ? { hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...hostHooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return async (person: string, method: string, path: string, body?: unknown) => {
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
}

describe('with a host, an App\'s analysis memos and conversations are each person\'s', () => {
  it('lists, opens, runs, pins and reuses a memo only for the person who asked', async () => {
    const root = project();
    const call = await serve(root, {});
    const question = `Why did claims rise in the West? ${CANARY}`;
    const created = await call('priya', 'POST', '/api/apps/claims/investigations', { question, dashboardId: 'overview', run: false });
    expect(created.status, created.text.slice(0, 300)).toBe(201);
    const id = created.body.investigation.id as string;
    expect(created.body.investigation.ownerId).toBe('u-priya');
    expect((await call('priya', 'GET', '/api/apps/claims/investigations')).body.investigations.map((item: { id: string }) => item.id)).toEqual([id]);
    expect((await call('priya', 'GET', `/api/apps/claims/investigations/${id}`)).status).toBe(200);

    const dansList = await call('dan', 'GET', '/api/apps/claims/investigations');
    expect(dansList.status).toBe(200);
    expect(dansList.text).not.toContain(CANARY);
    for (const [method, path] of [['GET', ''], ['POST', '/run'], ['POST', '/pin']] as const) {
      const answer = await call('dan', method, `/api/apps/claims/investigations/${id}${path}`, method === 'POST' ? {} : undefined);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.text).not.toContain(CANARY);
    }
    // The same question from Dan is his own memo, never Priya's id or her previews.
    const dans = await call('dan', 'POST', '/api/apps/claims/investigations', { question, dashboardId: 'overview', run: false });
    expect(dans.status).toBe(201);
    expect(dans.body.investigation.id).not.toBe(id);
    expect(dans.body.investigation.ownerId).toBe('u-dan');
    // Priya asking again reuses her own.
    expect((await call('priya', 'POST', '/api/apps/claims/investigations', { question, dashboardId: 'overview', run: false })).body.investigation.id).toBe(id);
    // The App's own document lists only the reader's memos.
    const appForDan = await call('dan', 'GET', '/api/apps/claims');
    expect(appForDan.status).toBe(200);
    expect(JSON.stringify(appForDan.body?.investigations ?? [])).not.toContain(id);
  });

  it('keeps an AI pin (its answer and stored rows) for the person who pinned it, on the page as in the list', async () => {
    const root = project();
    const call = await serve(root, {});
    const pinned = await call('priya', 'POST', '/api/apps/claims/ai-pins', {
      dashboardId: 'overview', title: 'Open claims', question: 'Open claims by region', answer: `West has 147 open claims ${CANARY}`,
      sql: 'SELECT 1', result: { columns: ['region', 'open_claims'], rows: [{ region: 'West', open_claims: CANARY }] },
    });
    expect(pinned.status, pinned.text.slice(0, 300)).toBe(201);
    // With a host the pin is its pinner's, not the App's, and the answer says so.
    expect(pinned.body.notice).toBe('Only you see this pin; keep it as a live tile to share it.');
    const pinId = pinned.body.pin.id as string;
    expect((await call('priya', 'GET', '/api/apps/claims/ai-pins')).text).toContain(CANARY);
    expect((await call('dan', 'GET', '/api/apps/claims/ai-pins')).body.pins).toEqual([]);
    expect((await call('dan', 'POST', `/api/apps/claims/ai-pins/${pinId}/refresh`, {})).status).toBe(404);
    expect((await call('dan', 'GET', '/api/apps/claims')).text).not.toContain(CANARY);
    // The page holds the pin's tile for everyone; its stored answer and rows are shown only to the person who pinned it.
    const dansPage = await call('dan', 'POST', '/api/apps/claims/dashboards/overview/run', {});
    expect(dansPage.text).not.toContain(CANARY);
    const priyasPage = await call('priya', 'POST', '/api/apps/claims/dashboards/overview/run', {});
    expect(priyasPage.text).toContain(CANARY);
    // A pin belongs to its App: another App's routes do not reach it.
    mkdirSync(join(root, 'apps', 'finance', 'dashboards'), { recursive: true });
    writeFileSync(join(root, 'apps', 'finance', 'dql.app.json'), JSON.stringify({ version: 1, id: 'finance', name: 'Finance', description: 'Finance', visibility: 'shared', domain: 'finance', lifecycle: 'draft', owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' } }));
    expect((await call('priya', 'POST', `/api/apps/finance/ai-pins/${pinId}/refresh`, {})).status).toBe(404);
    expect((await call('priya', 'POST', `/api/apps/finance/ai-pins/${pinId}/promote`, {})).status).toBe(400);
    // Promoted to a draft block (project content), it says what it answers, not her figures.
    const promoted = await call('priya', 'POST', `/api/apps/claims/ai-pins/${pinId}/promote`, {});
    expect(promoted.status, promoted.text.slice(0, 200)).toBe(200);
    // Named as every route names project files: relative to the project, never the server's own path.
    expect(promoted.body.blockPath).toBe('apps/claims/drafts/open-claims.dql');
    expect(promoted.body.pin.promotedBlockPath).toBe('apps/claims/drafts/open-claims.dql');
    expect(promoted.text).not.toContain(root);
    const draft = readFileSync(join(root, promoted.body.blockPath), 'utf8');
    expect(draft).not.toContain(CANARY);
    expect(draft).toContain('Open claims by region');
  });

  it('keeps an App build draft and an AI build session for the author who started them', async () => {
    const root = project();
    const call = await serve(root, {});
    const draft = createAppBuildDraft({ id: 'build-west', appId: 'west-claims', name: `West claims ${CANARY}`, authoringMode: 'manual', frame: { goal: `Why West ${CANARY}`, metrics: [], dimensions: [], filters: [] }, now: '2026-10-01T00:00:00.000Z' });
    const asPriya = new LocalAppStorage(defaultLocalAppsDbPath(root), { owner: 'u-priya' });
    asPriya.saveAppBuildDraft(draft);
    asPriya.close();
    expect((await call('priya', 'GET', '/api/app-builds')).text).toContain(CANARY);
    expect((await call('priya', 'GET', '/api/app-builds/build-west')).status).toBe(200);
    expect((await call('dan', 'GET', '/api/app-builds')).text).not.toContain(CANARY);
    expect((await call('dan', 'GET', '/api/app-builds/build-west')).status).toBe(404);
    expect((await call('dan', 'PATCH', '/api/app-builds/build-west', { expectedRevision: draft.revision, operations: [{ type: 'set_name', name: 'taken' }] })).status).toBeGreaterThanOrEqual(400);
    const asDan = new LocalAppStorage(defaultLocalAppsDbPath(root), { owner: 'u-dan' });
    expect(() => asDan.saveAppBuildDraft({ ...draft, name: 'taken' })).toThrow(/APP_BUILD_DRAFT_NOT_FOUND/);
    asDan.close();
    // An AI build session (prompt, plan, preview rows, answer) is read only by the person who started it.
    mkdirSync(join(root, '.dql', 'local', 'app-ai-builds'), { recursive: true });
    writeFileSync(join(root, '.dql', 'local', 'app-ai-builds', 'aib_priya.json'), JSON.stringify({ id: 'aib_priya', status: 'proposed', prompt: CANARY, ownerId: 'u-priya', createdAt: 'x', updatedAt: 'x' }));
    writeFileSync(join(root, '.dql', 'local', 'app-ai-builds', 'aib_before.json'), JSON.stringify({ id: 'aib_before', status: 'proposed', prompt: CANARY, createdAt: 'x', updatedAt: 'x' }));
    expect((await call('priya', 'GET', '/api/apps/ai-builds/aib_priya')).status).toBe(200);
    const dans = await call('dan', 'GET', '/api/apps/ai-builds/aib_priya');
    expect(dans.status).toBe(404);
    expect(dans.text).not.toContain(CANARY);
    expect((await call('priya', 'GET', '/api/apps/ai-builds/aib_before')).status).toBe(404);
  });

  it('keeps an App conversation for the person who had it', async () => {
    const root = project();
    const call = await serve(root, {});
    const created = await call('priya', 'POST', '/api/apps/claims/conversations', { title: `West claims ${CANARY}`, messages: [{ role: 'user', content: `Why West? ${CANARY}` }] });
    expect(created.status).toBe(201);
    const id = created.body.conversation.id as string;
    expect((await call('priya', 'GET', '/api/apps/claims/conversations')).body.conversations.map((item: { id: string }) => item.id)).toEqual([id]);
    expect((await call('dan', 'GET', '/api/apps/claims/conversations')).body.conversations).toEqual([]);
    expect((await call('dan', 'GET', `/api/apps/claims/conversations/${id}`)).status).toBe(404);
    expect((await call('dan', 'PATCH', `/api/apps/claims/conversations/${id}`, { title: 'mine now' })).status).toBe(404);
    expect((await call('dan', 'DELETE', `/api/apps/claims/conversations/${id}`)).status).toBe(404);
    const mine = await call('priya', 'GET', `/api/apps/claims/conversations/${id}`);
    expect(mine.text).toContain(CANARY);
  });

  it('records from before the host are no one\'s; a host that names nobody reads none', async () => {
    const root = project();
    const before = new LocalAppStorage(defaultLocalAppsDbPath(root));
    before.createAppInvestigation({ appId: 'claims', question: `Before the host ${CANARY}` });
    before.createAppConversation({ appId: 'claims', title: `Before the host ${CANARY}` });
    before.close();
    const call = await serve(root, {});
    expect((await call('priya', 'GET', '/api/apps/claims/investigations')).text).not.toContain(CANARY);
    expect((await call('priya', 'GET', '/api/apps/claims/conversations')).text).not.toContain(CANARY);
    const nobody = await serve(root, { resolvePrincipal: undefined });
    expect((await nobody('', 'GET', '/api/apps/claims/investigations')).text).not.toContain(CANARY);
    expect((await nobody('', 'GET', '/api/apps/claims/conversations')).text).not.toContain(CANARY);
  });
});

describe('without a host, the one local user sees every memo and conversation, as before', () => {
  it('lists records kept without an owner', async () => {
    const root = project();
    const before = new LocalAppStorage(defaultLocalAppsDbPath(root));
    before.createAppInvestigation({ appId: 'claims', question: `Local ${CANARY}` });
    before.close();
    const call = await serve(root);
    const listed = await call('', 'GET', '/api/apps/claims/investigations');
    expect(listed.text).toContain(CANARY);
    const created = await call('', 'POST', '/api/apps/claims/conversations', { title: 'Local talk' });
    expect(created.status).toBe(201);
    expect(created.body.conversation.ownerId).toBeUndefined();
    expect((await call('', 'GET', '/api/apps/claims/conversations')).body.conversations).toHaveLength(1);
  });
});
