import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore, SqliteAgentRunStore } from '@duckcodeailabs/dql-agent';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { currentPrincipal, currentRequestContext, personaSlotCount, PERSONA_SLOT_LIMIT, type DqlConversationStore, type DqlHostHooks, type DqlPrincipal, type DqlRunStore } from './request-context.js';

/**
 * The host-hook contract, request context: 200 interleaved requests as 4 people, with every hook and store
 * answering after a random delay so the requests overlap at every await. Each person must see only their own
 * principal everywhere: in the row policy and credentials hooks (the statement names the request's nonce), in the
 * audit sink (the event and the request context it runs in), in run ownership and the host's async run and
 * conversation stores, in per-person files (favorites, research runs, threads), in the Dataset result cache, and in
 * the persona slots, up to their LRU cap.
 */
const here = dirname(fileURLToPath(import.meta.url));
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckIt = connectorRoot ? it : it.skip;
const evidenceDir = process.env.HOST_CHECK_EVIDENCE_DIR?.trim();
function evidence(name: string, record: unknown): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, name), `${JSON.stringify(record)}\n`);
}

const REGIONS: Record<string, string> = { priya: 'West', lee: 'Northeast', omar: 'Southeast', grace: 'Midwest' };
const PEOPLE: Record<string, DqlPrincipal> = Object.fromEntries(Object.entries(REGIONS).map(([key, region]) => [key, {
  id: `u-${key}`, kind: 'person' as const, email: `${key}@example.test`, attributes: { region }, source: 'host' as const,
}]));
const ownerOf = (id: string | null | undefined) => Object.keys(PEOPLE).find((key) => PEOPLE[key]!.id === id) ?? `?${id}`;
const jitter = () => new Promise((done) => setTimeout(done, Math.floor(Math.random() * 12)));

const servers: Server[] = [];
const roots: string[] = [];
const executors: QueryExecutor[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every method of a store answers after a random delay, as a network database would. */
function slow<T extends object>(target: T, onCall?: (method: string, args: unknown[]) => void): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== 'function') return value;
      if (property === 'close') return async () => undefined;
      return async (...args: unknown[]) => {
        await jitter();
        onCall?.(String(property), args);
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

const reviewAnswer = (request: { question?: string }) => ({
  summary: `Answer for ${request?.question ?? ''}`,
  answer: `Answer for ${request?.question ?? ''}`,
  status: 'answered' as const,
  trustState: 'review_required' as const,
  stopReason: 'human_review_required' as const,
  artifacts: [],
  evaluations: [],
  nextActions: [],
});

describe('request context under 200 interleaved requests as 4 people', () => {
  duckIt('every hook, store and per-person file sees only the person whose request it serves', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-conc-'));
    const hostRoot = mkdtempSync(join(tmpdir(), 'dql-conc-host-'));
    roots.push(projectRoot, hostRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_concurrency' }));
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    const dbPath = join(hostRoot, 'claims.duckdb');
    const connection = { driver: 'duckdb', filepath: dbPath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    const seed = new QueryExecutor();
    await seed.executeQuery(`CREATE TABLE claims AS SELECT * FROM (VALUES ${Object.values(REGIONS).map((region, index) => `(${index + 1}, '${region}', ${(index + 1) * 100})`).join(', ')}) AS t(id, region, amount)`, [], {}, connection);
    await seed.disconnect();

    const mismatches: string[] = [];
    const policySeen: Array<{ who: string; nonce?: string }> = [];
    const auditSeen: Array<{ event: string | null; context: string | null; path: string }> = [];
    const runSaves: Array<{ owner: string; question: string }> = [];
    const runs = slow(new SqliteAgentRunStore({ path: join(hostRoot, 'runs.sqlite') }), (method, args) => {
      if (method !== 'save') return;
      const run = args[0] as { ownerId?: string; question?: string };
      runSaves.push({ owner: ownerOf(run.ownerId), question: run.question ?? '' });
      const asker = currentPrincipal();
      if (asker?.id !== run.ownerId) mismatches.push(`run store save: context ${asker?.id} saved a run owned by ${run.ownerId}`);
    }) as unknown as DqlRunStore;
    const conversations = slow(new ConversationStore(join(hostRoot, 'threads.sqlite'))) as unknown as DqlConversationStore;

    const hooks: DqlHostHooks = {
      resolvePrincipal: async (req) => { await jitter(); return PEOPLE[String(req.headers['x-test-person'] ?? '')] ?? null; },
      authorize: async (principal) => {
        await jitter();
        if (currentPrincipal()?.id !== undefined && currentPrincipal()?.id !== principal.id) mismatches.push(`authorize: context ${currentPrincipal()?.id} for ${principal.id}`);
        return { allow: true };
      },
      credentials: async ({ principal, connection: config }) => {
        await jitter();
        if (currentPrincipal()?.id !== principal?.id) mismatches.push(`credentials: context ${currentPrincipal()?.id} hook ${principal?.id}`);
        return { connection: { ...config } };
      },
      rowPolicy: async ({ principal, sql, purpose }) => {
        await jitter();
        if (purpose === 'metadata') return { sql };
        const nonce = /N-[a-z]+-\d+/.exec(sql)?.[0];
        const who = ownerOf(principal?.id);
        policySeen.push({ who, ...(nonce ? { nonce } : {}) });
        if (nonce && !nonce.startsWith(`N-${who}-`)) mismatches.push(`rowPolicy: ${who} was asked about ${nonce}`);
        if (currentPrincipal()?.id !== principal?.id) mismatches.push(`rowPolicy: context ${currentPrincipal()?.id} hook ${principal?.id}`);
        const region = String(principal?.attributes?.region ?? 'none').replace(/'/g, "''");
        return { sql: sql.replace(/\bFROM claims\b/, `FROM (SELECT * FROM claims WHERE region = '${region}') AS claims`) };
      },
      audit: async (event) => {
        const context = currentRequestContext();
        const path = event.kind === 'request' ? event.path : event.kind;
        auditSeen.push({ event: ownerOf(event.principalId), context: context?.principal ? ownerOf(context.principal.id) : null, path });
        await jitter();
      },
      stores: { runs, conversations: () => conversations },
    };
    const executor = new QueryExecutor();
    executors.push(executor);
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks: hooks,
      agentRunExecutors: { conversation: reviewAnswer, generated_answer: reviewAnswer, semantic_answer: reviewAnswer, certified_answer: reviewAnswer, research: reviewAnswer } as never,
      captureServer: (created) => { servers.push(created); },
    });
    const call = async (person: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      let parsed: any;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
      return { status: response.status, text, body: parsed };
    };

    // 200 requests: 50 per person, five kinds, shuffled and fired together.
    const kinds = ['query', 'thread', 'ask', 'favorite', 'research'] as const;
    const plan: Array<{ person: string; kind: typeof kinds[number]; nonce: string }> = [];
    for (const person of Object.keys(PEOPLE)) for (let index = 0; index < 50; index += 1) plan.push({ person, kind: kinds[index % kinds.length]!, nonce: `N-${person}-${index}` });
    plan.sort(() => Math.random() - 0.5);
    const results = await Promise.all(plan.map(async ({ person, kind, nonce }) => {
      if (kind === 'query') return { person, kind, nonce, answer: await call(person, 'POST', '/api/query', { sql: `SELECT '${nonce}' AS nonce, region, SUM(amount) AS total FROM claims GROUP BY region` }) };
      if (kind === 'thread') return { person, kind, nonce, answer: await call(person, 'POST', '/api/agent/threads', { title: nonce, surface: 'ask' }) };
      if (kind === 'ask') return { person, kind, nonce, answer: await call(person, 'POST', '/api/agent-runs', { question: `How many claims ${nonce}?` }) };
      if (kind === 'favorite') return { person, kind, nonce, answer: await call(person, 'POST', '/api/user-prefs/favorites', { name: nonce }) };
      return { person, kind, nonce, answer: await call(person, 'POST', '/api/notebook/research', { notebookPath: `notebooks/${nonce}.dqlnb`, question: nonce }) };
    }));
    await new Promise((done) => setTimeout(done, 100));

    // Every answer is the asker's own.
    for (const { person, kind, nonce, answer } of results) {
      expect(answer.status, `${kind} ${nonce}: ${answer.text.slice(0, 200)}`).toBeLessThan(300);
      const others = Object.keys(PEOPLE).filter((other) => other !== person);
      for (const other of others) if (answer.text.includes(`N-${other}-`)) mismatches.push(`${kind} ${nonce} answer carries ${other}'s nonce`);
      if (kind === 'query') {
        const regions = (answer.body.rows as Array<{ region: string }>).map((row) => row.region);
        if (JSON.stringify(regions) !== JSON.stringify([REGIONS[person]])) mismatches.push(`query ${nonce} rows ${JSON.stringify(regions)}`);
      }
      if (kind === 'thread' && answer.body.thread.ownerId !== PEOPLE[person]!.id) mismatches.push(`thread ${nonce} owned by ${answer.body.thread.ownerId}`);
      if (kind === 'ask') {
        // The answer does not carry its owner; the run is read back by id: found for its asker, not found for others.
        const runId = encodeURIComponent(answer.body.run.id);
        if ((await call(person, 'GET', `/api/agent-runs/${runId}`)).status !== 200) mismatches.push(`run ${nonce} not found for its asker`);
        const other = Object.keys(PEOPLE).find((candidate) => candidate !== person)!;
        if ((await call(other, 'GET', `/api/agent-runs/${runId}`)).status !== 404) mismatches.push(`run ${nonce} readable by ${other}`);
      }
      if (kind === 'research' && answer.body.run.owner !== PEOPLE[person]!.email) mismatches.push(`research ${nonce} owned by ${answer.body.run.owner}`);
    }
    // Each person's lists hold their own items only, all of them.
    for (const person of Object.keys(PEOPLE)) {
      const mine = (text: string) => [...new Set(text.match(/N-[a-z]+-\d+/g) ?? [])];
      const expectedOf = (kind: string) => plan.filter((entry) => entry.person === person && entry.kind === kind).map((entry) => entry.nonce).sort();
      const threads = mine((await call(person, 'GET', '/api/agent/threads')).text).sort();
      const favorites = mine((await call(person, 'GET', '/api/user-prefs/favorites')).text).sort();
      const research = mine((await call(person, 'GET', '/api/notebook/research?limit=100')).text).sort();
      const askRuns = mine((await call(person, 'GET', '/api/agent-runs?limit=100')).text).sort();
      if (JSON.stringify(threads) !== JSON.stringify(expectedOf('thread'))) mismatches.push(`${person} threads ${JSON.stringify(threads)}`);
      if (JSON.stringify(favorites) !== JSON.stringify(expectedOf('favorite'))) mismatches.push(`${person} favorites ${JSON.stringify(favorites)}`);
      if (JSON.stringify(research) !== JSON.stringify(expectedOf('research'))) mismatches.push(`${person} research ${JSON.stringify(research)}`);
      if (JSON.stringify(askRuns) !== JSON.stringify(expectedOf('ask'))) mismatches.push(`${person} runs ${JSON.stringify(askRuns)}`);
    }
    // The audit sink: every request event names the person whose request it was, and runs in that person's context.
    for (const seen of auditSeen) if (seen.context !== null && seen.event !== seen.context) mismatches.push(`audit event for ${seen.event} ran in ${seen.context}'s context (${seen.path})`);
    const auditByPerson = Object.fromEntries(Object.keys(PEOPLE).map((person) => [person, auditSeen.filter((seen) => seen.event === person && seen.path !== 'answer').length]));
    for (const save of runSaves) {
      const nonce = /N-[a-z]+-\d+/.exec(save.question)?.[0];
      if (nonce && !nonce.startsWith(`N-${save.owner}-`)) mismatches.push(`run store kept ${nonce} as ${save.owner}'s`);
    }
    evidence('concurrency.jsonl', { requests: results.length, policyCalls: policySeen.length, auditEvents: auditSeen.length, auditByPerson, runSaves: runSaves.length, mismatches });
    expect(policySeen.filter((seen) => seen.nonce).length).toBe(plan.filter((entry) => entry.kind === 'query').length);
    expect(Object.values(auditByPerson).every((count) => count >= 40)).toBe(true);
    expect(mismatches).toEqual([]);
  }, 180_000);
});

const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');

describe('the Dataset result cache under interleaved readers', () => {
  duckIt('the same Dataset question, 200 times as 4 people with different row rules, never serves another person\'s rows', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-conc-cache-'));
    roots.push(projectRoot);
    cpSync(fixtureRoot, projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
    const connection = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    const executor = new QueryExecutor();
    executors.push(executor);
    const readers: Record<string, DqlPrincipal> = {
      admin: { id: 'u-admin', kind: 'person', email: 'admin@example.test', groups: ['admins'], source: 'host' },
      ca: { id: 'u-ca', kind: 'person', email: 'ca@example.test', attributes: { region: 'CA' }, source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@example.test', attributes: { region: 'US' }, source: 'host' },
      ca2: { id: 'u-ca2', kind: 'person', email: 'ca2@example.test', attributes: { region: 'CA' }, source: 'host' },
    };
    const hooks: DqlHostHooks = {
      resolvePrincipal: async (req) => { await jitter(); return readers[String(req.headers['x-test-person'] ?? '')] ?? null; },
      rowPolicy: async ({ principal, sql, purpose, relations }) => {
        await jitter();
        if (purpose === 'metadata' || principal === null || principal.groups?.includes('admins')) return { sql };
        if (!relations.includes('main.order_lines')) return { sql };
        const region = String(principal.attributes?.region ?? '');
        return { sql: sql.replace(/(?:"main"|main)\."?order_lines"?/g, `(SELECT * FROM "main"."order_lines" WHERE "region" = '${region}') AS "order_lines"`) };
      },
    };
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks: hooks, captureServer: (created) => { servers.push(created); } });
    const call = async (person: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
    };
    const tables = await call('admin', '/api/app-datasets/tables');
    const table = tables.body.tables.find((entry: { name: string }) => entry.name === 'order_lines');
    const created = await call('admin', '/api/app-datasets/tables/create', { tableId: table.id, name: 'Order lines', domain: 'commerce' });
    expect(created.status, created.text).toBe(201);
    const query = { dimensions: [{ field: 'region' }], measures: [{ measure: 'order_line_count' }] };
    const expected: Record<string, string> = { admin: 'CA:3,US:5', ca: 'CA:3', us: 'US:5', ca2: 'CA:3' };
    const order = Object.keys(readers).flatMap((person) => Array.from({ length: 50 }, () => person)).sort(() => Math.random() - 0.5);
    const wrong: string[] = [];
    await Promise.all(order.map(async (person) => {
      const run = await call(person, '/api/app-datasets/run', { sourceId: created.body.sourceId, query });
      if (run.status !== 200) { wrong.push(`${person}: ${run.status} ${run.text.slice(0, 120)}`); return; }
      const got = (run.body.result.rows as Array<{ region: string; order_line_count: number }>).map((row) => `${row.region}:${Number(row.order_line_count)}`).sort().join(',');
      if (got !== expected[person]) wrong.push(`${person} got ${got}`);
    }));
    evidence('concurrency.jsonl', { cacheRuns: order.length, wrong });
    expect(wrong).toEqual([]);
  }, 180_000);
});

describe('persona slots: one per person, bounded', () => {
  it(`keeps at most ${PERSONA_SLOT_LIMIT} people\'s "view as"; an evicted person sees Apps as themselves, never as someone else`, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-conc-persona-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_persona' }));
    mkdirSync(join(projectRoot, 'apps', 'claims'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
      version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft', owners: ['owner@example.test'],
      members: [{ userId: 'member@example.test', displayName: 'Member', roles: ['viewer'] }, { userId: 'owner@example.test', displayName: 'Owner', roles: ['owner'] }],
      roles: [{ id: 'viewer', displayName: 'Viewer' }, { id: 'owner', displayName: 'Owner' }],
      policies: [{ id: 'viewers-read', domain: 'claims', minClassification: 'internal', allowedRoles: ['viewer', 'owner'], accessLevel: 'read', enabled: true }],
    }));
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, connection: { driver: 'file' } as ConnectionConfig, preferredPort: 0,
      hostHooks: { resolvePrincipal: (req) => ({ id: String(req.headers['x-test-person']), kind: 'person', source: 'host' }) },
      captureServer: (created) => { servers.push(created); },
    });
    const call = async (person: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    // Two people choose different personas; neither sees the other's.
    expect((await call('first', 'POST', '/api/persona', { userId: 'owner@example.test', appId: 'claims' })).status).toBe(200);
    expect((await call('second', 'POST', '/api/persona', { userId: 'member@example.test', appId: 'claims' })).status).toBe(200);
    expect((await call('first', 'GET', '/api/persona')).body.persona?.userId).toBe('owner@example.test');
    expect((await call('second', 'GET', '/api/persona')).body.persona?.userId).toBe('member@example.test');
    expect((await call('third', 'GET', '/api/persona')).body.persona ?? null).toBeNull();
    // Past the cap the least recently used slots go; the count never passes it.
    for (let batch = 0; batch < PERSONA_SLOT_LIMIT + 200; batch += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => call(`crowd-${batch + index}`, 'GET', '/api/persona')));
      expect(personaSlotCount()).toBeLessThanOrEqual(PERSONA_SLOT_LIMIT);
    }
    const evicted = await call('first', 'GET', '/api/persona');
    evidence('concurrency.jsonl', { personaSlots: personaSlotCount(), evictedFirst: evicted.body.persona ?? null });
    expect(evicted.body.persona ?? null).toBeNull();
    expect((await call('third', 'GET', '/api/persona')).body.persona ?? null).toBeNull();
  }, 180_000);
});

describe('negative control: the checks above can fail', () => {
  duckIt('a host that keeps "the current person" in a process variable instead of the request context is caught', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-conc-neg-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_negative' }));
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    const dbPath = join(projectRoot, 'claims.duckdb');
    const connection = { driver: 'duckdb', filepath: dbPath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    const seed = new QueryExecutor();
    await seed.executeQuery(`CREATE TABLE claims AS SELECT * FROM (VALUES ${Object.values(REGIONS).map((region, index) => `(${index + 1}, '${region}', ${(index + 1) * 100})`).join(', ')}) AS t(id, region, amount)`, [], {}, connection);
    await seed.disconnect();
    let lastPlaced: DqlPrincipal | null = null;
    const executor = new QueryExecutor();
    executors.push(executor);
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0,
      hostHooks: {
        resolvePrincipal: async (req) => { const who = PEOPLE[String(req.headers['x-test-person'] ?? '')] ?? null; lastPlaced = who; await jitter(); return who; },
        // The fault under test: the policy reads a process variable, not the principal DQL hands it.
        rowPolicy: async ({ sql, purpose }) => {
          await jitter();
          if (purpose === 'metadata') return { sql };
          const region = String((lastPlaced as DqlPrincipal | null)?.attributes?.region ?? 'none');
          return { sql: sql.replace(/\bFROM claims\b/, `FROM (SELECT * FROM claims WHERE region = '${region}') AS claims`) };
        },
      },
      captureServer: (created) => { servers.push(created); },
    });
    const order = Object.keys(PEOPLE).flatMap((person) => Array.from({ length: 25 }, () => person)).sort(() => Math.random() - 0.5);
    const wrong: string[] = [];
    await Promise.all(order.map(async (person) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': person }, body: JSON.stringify({ sql: 'SELECT region FROM claims' }) });
      const body = await response.json() as { rows?: Array<{ region: string }> };
      const regions = (body.rows ?? []).map((row) => row.region);
      if (JSON.stringify(regions) !== JSON.stringify([REGIONS[person]])) wrong.push(`${person} got ${JSON.stringify(regions)}`);
    }));
    evidence('concurrency.jsonl', { negativeControl: { requests: order.length, wrongRows: wrong.length } });
    expect(wrong.length).toBeGreaterThan(0);
  }, 120_000);
});
