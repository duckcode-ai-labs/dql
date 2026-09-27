import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPageEdition, DqlPrincipal } from './request-context.js';
import type { DqlRowPolicy } from './row-policy.js';

/**
 * RFC 0010 HH-16: a Home that summarises, following a page, and who an App
 * is for. Each person's "What moved" comes from their own runs (their row
 * rules), a scheduled run tells the host about a new edition without a
 * figure, the host adds cards, and an App's audience groups decide who opens
 * it. Without a host the same Home works for the one local person.
 */
const here = dirname(fileURLToPath(import.meta.url));
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-home-'));
  roots.push(root);
  cpSync(fixtureRoot, root, { recursive: true });
  // A weekly schedule on the page, so a scheduled run can make an edition.
  const appPath = join(root, 'apps', 'commerce-pilot', 'dql.app.json');
  const app = JSON.parse(readFileSync(appPath, 'utf-8'));
  app.schedules = [{ id: 'weekly', cron: '0 7 * * 1', dashboard: 'overview', deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/x' }] }];
  writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`);
  return root;
}

const caller = (base: string) => async (person: string | undefined, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
};

describe('Home without a host', () => {
  it('lists the project\'s Apps, keeps follows as the local person\'s own state, and takes audience groups as typed', async () => {
    const root = project();
    const port = await startLocalServer({ rootDir: root, projectRoot: root, executor: {} as never, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const call = caller(`http://127.0.0.1:${port}`);

    const home = await call(undefined, 'GET', '/api/home');
    expect(home.status, home.text).toBe(200);
    expect(home.body.apps.map((app: { id: string }) => app.id)).toEqual(['commerce-pilot']);
    expect(home.body.apps[0]).toMatchObject({ name: 'Commerce pilot', homePageId: 'overview', following: false });
    expect(home.body.moved).toEqual([]);
    expect((await call(undefined, 'GET', '/api/host/home-cards')).body).toEqual({ cards: [] });
    expect((await call(undefined, 'GET', '/api/host/groups')).body).toEqual({ source: 'free_text' });

    const followed = await call(undefined, 'POST', '/api/apps/commerce-pilot/follow', { pageId: 'overview', following: true });
    expect(followed.status, followed.text).toBe(200);
    expect(followed.body).toMatchObject({ following: true, follows: [{ appId: 'commerce-pilot', pageId: 'overview', title: 'Commerce pilot · Overview' }] });
    expect(existsSync(join(root, '.dql', 'local', 'private', 'home', 'local.json'))).toBe(true);
    expect((await call(undefined, 'GET', '/api/home')).body.apps[0].following).toBe(true);
    expect((await call(undefined, 'POST', '/api/apps/commerce-pilot/follow', { pageId: 'nope', following: true })).status).toBe(400);
    expect((await call(undefined, 'POST', '/api/apps/commerce-pilot/follow', { pageId: 'overview', following: false })).body.following).toBe(false);

    // Audience groups, typed by the author; only those fields of the file change.
    const before = JSON.parse(readFileSync(join(root, 'apps', 'commerce-pilot', 'dql.app.json'), 'utf-8'));
    const saved = await call(undefined, 'PUT', '/api/apps/commerce-pilot/audience', { groups: ['claims-leaders', ' claims-leaders '], text: 'Claims leadership' });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, audienceGroups: ['claims-leaders'], audience: 'Claims leadership', path: 'apps/commerce-pilot/dql.app.json' });
    const after = JSON.parse(readFileSync(join(root, 'apps', 'commerce-pilot', 'dql.app.json'), 'utf-8'));
    expect(after).toEqual({ ...before, audience: 'Claims leadership', audienceGroups: ['claims-leaders'] });
    expect((await call(undefined, 'PUT', '/api/apps/commerce-pilot/audience', { groups: 'claims-leaders' })).status).toBe(400);
    // One local person: the audience is a note, the App still opens.
    expect((await call(undefined, 'GET', '/api/home')).body.apps.map((app: { id: string }) => app.id)).toEqual(['commerce-pilot']);
    expect((await call(undefined, 'PUT', '/api/apps/commerce-pilot/audience', { groups: [] })).body.audienceGroups).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'apps', 'commerce-pilot', 'dql.app.json'), 'utf-8'))).not.toHaveProperty('audienceGroups');
  });
});

describe('Home with a host (RFC 0010 HH-16)', () => {
  duckDbIt('gives each person their own What moved, tells the host of a new edition without a figure, adds host cards, and opens an App only for its audience', async () => {
    const root = project();
    const databasePath = join(root, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    mkdirSync(join(root, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(root, '.dql', 'connectors', 'node_modules'), 'dir');
    execFileSync(process.execPath, [seedWarehouse, '--seed', join(root, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });

    const people: Record<string, DqlPrincipal> = {
      admin: { id: 'u-admin', kind: 'person', email: 'admin@example.test', groups: ['analyst'], source: 'host' },
      ca: { id: 'u-ca', kind: 'person', email: 'ca@example.test', groups: ['analyst', 'ca-leaders'], attributes: { region: 'CA' }, source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@example.test', groups: ['analyst', 'us-leaders'], attributes: { region: 'US' }, source: 'host' },
    };
    // "New data arrives" for CA between two of her runs: first two order lines, then all of them.
    let caLimit: number | undefined = 2;
    const policy: DqlRowPolicy = ({ principal, sql, purpose, relations }) => {
      if (purpose === 'metadata' || !principal || principal.id === 'u-admin' || !relations.some((relation) => relation === 'order_lines' || relation === 'main.order_lines')) return { sql };
      const region = String(principal.attributes?.region);
      const limit = region === 'CA' && caLimit ? ` LIMIT ${caLimit}` : '';
      return { sql: sql.replace(/(?<![\w."])(?:(?:"main"|main)\.)?"?order_lines"?(?!\w)/g, `(SELECT * FROM "main"."order_lines" WHERE "region" = '${region}' ORDER BY "order_line_id"${limit}) AS "order_lines"`) };
    };
    const editions: DqlPageEdition[] = [];
    const hostHooks: DqlHostHooks = {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      rowPolicy: policy,
      // Only the admin may change Apps.
      authorize: (principal, action) => ({ allow: action !== 'app.author' || principal.id === 'u-admin' }),
      pageEdition: (edition) => { editions.push(edition); },
      homeCards: (principal) => (principal.id === 'u-ca' ? [{
        id: 'requests',
        title: 'Open requests',
        items: [
          { id: 'R-7', title: 'Which adjusters have the most open claims?', status: 'Waiting for a steward', href: '/e/requests/R-7', tone: 'info' },
          { id: 'R-8', title: 'Elsewhere', href: 'https://elsewhere.example/x' },
        ],
        more: { label: 'All my requests', href: '//elsewhere.example' },
      }] : []),
      directoryGroups: () => [{ id: 'ca-leaders', label: 'CA leaders', members: 1 }, { id: 'us-leaders' }],
      delivery: async () => ({ delivered: true }),
    };
    const executor = new QueryExecutor();
    try {
      const port = await startLocalServer({ rootDir: root, projectRoot: root, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { servers.push(created); } });
      const call = caller(`http://127.0.0.1:${port}`);
      const run = async (person: string, refresh = false) => {
        const result = await call(person, 'POST', '/api/apps/commerce-pilot/dashboards/overview/run', { variables: {}, ...(refresh ? { refresh: true } : {}) });
        expect(result.status, result.text.slice(0, 400)).toBe(200);
        return result.body;
      };
      const kpi = (body: any, tileId: string) => Number(Object.values(body.tiles.find((tile: { tileId: string }) => tile.tileId === tileId).result.rows[0])[0]);

      // CA twice (her data grows in between), US once.
      const first = await run('ca');
      caLimit = undefined;
      const second = await run('ca', true);
      const us = await run('us');
      expect(kpi(second, 'order-lines-dataset-kpi')).toBeGreaterThan(kpi(first, 'order-lines-dataset-kpi'));

      const caHome = await call('ca', 'GET', '/api/home');
      expect(caHome.status, caHome.text).toBe(200);
      const moved = caHome.body.moved as Array<{ appId: string; pageId: string; appName: string; pageTitle: string; changes: Array<{ label: string; from: string; to: string; direction: string }> }>;
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({ appId: 'commerce-pilot', pageId: 'overview', appName: 'Commerce pilot', pageTitle: 'Overview' });
      expect(moved[0].changes.length).toBeGreaterThan(0);
      expect(moved[0].changes.every((change) => change.direction === 'up')).toBe(true);
      // Her figures, not anyone else's: US's revenue appears nowhere in her Home.
      const usRevenue = kpi(us, 'order-lines-dataset-kpi');
      expect(caHome.text).not.toContain(String(Math.round(usRevenue)));
      // US ran once: nothing moved for him, and nothing of CA's is on his Home.
      const usHome = await call('us', 'GET', '/api/home');
      expect(usHome.body.moved).toEqual([]);
      expect(readdirSync(join(root, '.dql', 'local', 'private', 'home')).filter((file) => file.endsWith('.json'))).toHaveLength(2);

      // Follows are each person's own.
      expect((await call('ca', 'POST', '/api/apps/commerce-pilot/follow', { pageId: 'overview', following: true })).body.following).toBe(true);
      expect((await call('us', 'GET', '/api/apps/commerce-pilot/follow?page=overview')).body.following).toBe(false);
      expect((await call('ca', 'GET', '/api/home')).body.apps[0].following).toBe(true);

      // A scheduled run is an edition: the host hears of it once, with a link and no figure.
      expect((await call('admin', 'POST', '/api/apps/commerce-pilot/schedules/weekly/run', {})).status).toBe(200);
      await new Promise((done) => setTimeout(done, 50));
      expect(editions).toEqual([expect.objectContaining({ appId: 'commerce-pilot', pageId: 'overview', appTitle: 'Commerce pilot', pageTitle: 'Overview', href: '/?app=commerce-pilot&page=overview', scheduleId: 'weekly' })]);
      expect(JSON.stringify(editions)).not.toMatch(new RegExp(String(Math.round(kpi(second, 'order-lines-dataset-kpi')))));
      await call('admin', 'POST', '/api/apps/commerce-pilot/schedules/weekly/run', {});
      await new Promise((done) => setTimeout(done, 50));
      expect(editions).toHaveLength(1);
      // The scheduled run is not anyone's visit; US's Home now says a newer edition exists.
      expect((await call('us', 'GET', '/api/home')).body.moved).toEqual([expect.objectContaining({ appId: 'commerce-pilot', newEditionAt: editions[0]!.at, changes: [] })]);

      // The host's cards, with links kept to this origin.
      const cards = await call('ca', 'GET', '/api/host/home-cards');
      expect(cards.body.cards).toEqual([{ id: 'requests', title: 'Open requests', items: [
        { id: 'R-7', title: 'Which adjusters have the most open claims?', status: 'Waiting for a steward', href: '/e/requests/R-7', tone: 'info' },
        { id: 'R-8', title: 'Elsewhere' },
      ] }]);
      expect((await call('us', 'GET', '/api/host/home-cards')).body.cards).toEqual([]);

      // Audience from the host's groups: only its groups may be named, and only by an author.
      expect((await call('ca', 'GET', '/api/host/groups')).body).toEqual({ source: 'host', groups: [{ id: 'ca-leaders', label: 'CA leaders', members: 1 }, { id: 'us-leaders' }] });
      expect((await call('ca', 'PUT', '/api/apps/commerce-pilot/audience', { groups: ['ca-leaders'] })).status).toBe(403);
      expect((await call('admin', 'PUT', '/api/apps/commerce-pilot/audience', { groups: ['finance-leaders'] })).body).toMatchObject({ ok: false, code: 'UNKNOWN_GROUP' });
      const set = await call('admin', 'PUT', '/api/apps/commerce-pilot/audience', { groups: ['ca-leaders'] });
      expect(set.status, set.text).toBe(200);

      // US is outside the audience: the App is not listed and does not open. CA still reads it; the admin, who may author it, too.
      expect((await call('us', 'GET', '/api/apps')).body.apps.map((app: { id: string }) => app.id)).toEqual([]);
      const refused = await call('us', 'POST', '/api/apps/commerce-pilot/dashboards/overview/run', { variables: {} });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'PERMISSION_DENIED', error: 'Commerce pilot is for ca-leaders. Ask its owner for access.' });
      expect((await call('us', 'GET', '/api/home')).body.apps).toEqual([]);
      expect((await call('ca', 'GET', '/api/apps')).body.apps.map((app: { id: string }) => app.id)).toEqual(['commerce-pilot']);
      await run('ca');
      await run('admin');
      // "Ask about this App" is scoped to an App the person may open: US is refused, CA asks.
      const aboutApp = { question: 'What stands out this week?', requestedMode: 'ask', workspaceContext: { surface: 'apps', appId: 'commerce-pilot', dashboardId: 'overview', dashboardFilters: {} } };
      expect((await call('us', 'POST', '/api/agent-runs', aboutApp)).status).toBe(403);
      expect((await call('ca', 'POST', '/api/agent-runs', aboutApp)).status).not.toBe(403);
    } finally {
      await executor.disconnect();
    }
  }, 180_000);
});
