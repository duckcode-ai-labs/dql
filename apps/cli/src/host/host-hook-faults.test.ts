import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { LocalAppStorage, LocalNotebookResearchStorage, defaultLocalAppsDbPath } from '@duckcodeailabs/dql-project';
import { homePersonKey } from '../home/home-state.js';
import { startLocalServer } from '../local-runtime.js';
import { knowledgeServersFor } from './knowledge-sources.js';
import { observabilityFailures } from './observability.js';
import {
  hostAllowedSources,
  hostFiguresDependOnReader,
  hostPrincipalRunOwner,
  resultValuesMayReachModel,
  withRequestContext,
  type DqlHostHooks,
  type DqlPrincipal,
} from './request-context.js';

/**
 * The host-hook contract: every hook is optional and fails closed. For each hook, a hook that throws,
 * one that answers with something malformed ("junk"), one that never answers and one that answers late. The
 * expectation is RFC 0010 rule 1 ("fail closed"), the hook's own doc comment in request-context.ts, and a refusal
 * in plain words, never a 500 with internals. A hook that never answers is cut off by the time limit every hook has
 * (hook-deadline.ts).
 *
 * Needs DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT (the folder holding the pinned duckdb driver) for the query hooks.
 * Evidence lines go to hook-faults.jsonl in the folder an evidence variable names, when one is set.
 */

const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckIt = connectorRoot ? it : it.skip;
const evidenceDir = process.env.HOST_CHECK_EVIDENCE_DIR?.trim();
function evidence(record: Record<string, unknown>): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, 'hook-faults.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@example.test', attributes: { region: 'West' }, source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@example.test', attributes: { region: 'All' }, source: 'host' };
const PEOPLE: Record<string, DqlPrincipal> = { priya, dan };
const FIGURE = 'CANARY-FIGURE-HOOKS-4471';
const SECRET = 'CANARY-TOKEN-HOOKS-9f2c';
const INTERNALS = /Cannot use 'in'|TypeError|is not a function|is not iterable|Cannot read propert|undefined is not|\bat [\w.<>]+ \(|\.ts:\d+|\.js:\d+/;

/** A promise that never settles until the test releases it. */
function gate<T>(): { promise: Promise<T>; release(value: T): void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

const servers: Server[] = [];
const roots: string[] = [];
const executors: QueryExecutor[] = [];
let dbRoot = '';
let dbPath = '';

beforeAll(async () => {
  if (!connectorRoot) return;
  // One small warehouse for the query hooks: a table with a column a policy could hide.
  dbRoot = mkdtempSync(join(tmpdir(), 'dql-faults-db-'));
  dbPath = join(dbRoot, 'claims.duckdb');
  const seed = new QueryExecutor();
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: dbPath, moduleSearchPaths: [connectorRoot] } as ConnectionConfig;
  await seed.executeQuery("CREATE TABLE claims AS SELECT * FROM (VALUES (1, 'West', '900-12-3456', 100.0), (2, 'East', '900-12-9999', 250.5)) AS t(id, region, ssn, amount)", [], {}, connection);
  await seed.disconnect();
}, 60_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (dbRoot) rmSync(dbRoot, { recursive: true, force: true });
});

interface Answer { status: number | 'no answer'; text: string; body: any; ms: number }

async function serve(hooks: Partial<DqlHostHooks>, options: { warehouse?: boolean; setup?: (projectRoot: string) => void; agentRunExecutors?: unknown } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-faults-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_faults' }));
  options.setup?.(projectRoot);
  let executor = {} as QueryExecutor;
  // Without a warehouse the server gets a file connection, so nothing reads this machine's dbt profiles.
  let connection: ConnectionConfig = { driver: 'file' } as ConnectionConfig;
  if (options.warehouse) {
    executor = new QueryExecutor();
    executors.push(executor);
    connection = { driver: 'duckdb', filepath: dbPath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    // The project's connector folder holds the pinned driver (as the product's own host tests do), so nothing is installed.
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
  }
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor,
    connection,
    preferredPort: 0,
    hostHooks: { resolvePrincipal: (req) => PEOPLE[String(req.headers['x-test-person'] ?? 'priya')] ?? null, ...hooks } as DqlHostHooks,
    ...(options.agentRunExecutors ? { agentRunExecutors: options.agentRunExecutors as never } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown, extra: { person?: string; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Answer> => {
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-person': extra.person ?? 'priya', ...(extra.headers ?? {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(extra.timeoutMs ?? 20_000),
      });
      const text = await response.text();
      let parsed: any;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
      return { status: response.status, text, body: parsed, ms: Date.now() - started };
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') return { status: 'no answer', text: '', body: undefined, ms: Date.now() - started };
      throw error;
    }
  };
  return { call, projectRoot };
}

describe('resolvePrincipal (HH-1)', () => {
  it('a hook that throws or names no one well is a 401 in plain words; a late answer still places the person', async () => {
    const junk: unknown[] = [undefined, null, {}, 'u-priya', 42, [], { id: '' }, { id: '   ' }, { id: 7 }, { id: 'x', kind: 'robot' }, true];
    let index = 0;
    const { call } = await serve({
      resolvePrincipal: async (req) => {
        if (req.headers['x-test-mode'] === undefined && req.headers['x-test-junk'] === undefined) return priya;
        const mode = String(req.headers['x-test-mode'] ?? '');
        if (mode === 'throw') throw new Error('identity provider down: CANARY-IDP-INTERNAL');
        if (mode === 'late') { await new Promise((done) => setTimeout(done, 400)); return priya; }
        return junk[Number(req.headers['x-test-junk'])] as DqlPrincipal;
      },
    });
    const fetchAs = async (headers: Record<string, string>) => call('GET', '/api/identity', undefined, { headers });
    const thrown = await fetchAs({ 'x-test-mode': 'throw' });
    expect(thrown.status).toBe(401);
    expect(thrown.body).toEqual({ error: 'Sign in to use DQL.' });
    for (index = 0; index < junk.length; index += 1) {
      const answer = await fetchAs({ 'x-test-junk': String(index) });
      expect(answer.status, `junk #${index} ${JSON.stringify(junk[index])}`).toBe(401);
    }
    const late = await fetchAs({ 'x-test-mode': 'late' });
    expect(late.status).toBe(200);
    expect(late.body.principal.id).toBe('u-priya');
  });

  it('a hook that never answers holds that request only; another person is answered meanwhile', async () => {
    const held = gate<DqlPrincipal | null>();
    const { call } = await serve({ resolvePrincipal: (req) => (req.headers['x-test-person'] === 'stuck' ? held.promise : PEOPLE[String(req.headers['x-test-person'])] ?? null) });
    const stuck = call('GET', '/api/identity', undefined, { person: 'stuck', timeoutMs: 1_500 });
    const other = await call('GET', '/api/identity', undefined, { person: 'dan' });
    expect(other.status).toBe(200);
    const answer = await stuck;
    evidence({ hook: 'resolvePrincipal', mode: 'never', status: answer.status, ms: answer.ms });
    expect(answer.status).toBe('no answer');
    held.release(null);
  });
});

describe('authorize (HH-2, HH-12)', () => {
  it('only { allow: true } allows; a throw or any other answer is a plain 403, and `next` passes only as a same-origin path', async () => {
    const answers: Array<[string, unknown, number]> = [
      ['allow', { allow: true }, 200],
      ['true', true, 403], ['string', 'allow', 403], ['allow-string', { allow: 'true' }, 403], ['allow-1', { allow: 1 }, 403],
      ['null', null, 403], ['undefined', undefined, 403], ['array', [], 403], ['reason-object', { allow: false, reason: { html: '<b>x</b>' } }, 403],
    ];
    for (const [label, decision, expected] of answers) {
      const { call: callWith } = await serve({ authorize: () => decision as never });
      const answer = await callWith('POST', '/api/query', { sql: 'SELECT 1' });
      const status = answer.status === 403 ? 403 : answer.status === 'no answer' ? 'no answer' : (answer.status === 200 || answer.status === 500 || answer.status === 400) ? 200 : answer.status;
      expect(status, `${label}: ${answer.text.slice(0, 200)}`).toBe(expected);
      if (expected === 403) {
        expect(answer.body).toMatchObject({ code: 'PERMISSION_DENIED', error: 'You do not have permission to do this.' });
      }
    }
    const { call: thrower } = await serve({ authorize: () => { throw new Error('policy store down: CANARY-POLICY-INTERNAL'); } });
    const thrown = await thrower('POST', '/api/query', { sql: 'SELECT 1' });
    expect(thrown.status).toBe(403);
    expect(thrown.text).not.toContain('CANARY-POLICY-INTERNAL');
    for (const [href, kept] of [['/e/access', true], ['https://evil.example/x', false], ['//evil.example/x', false], ['/\\evil.example', false], ['javascript:alert(1)', false]] as Array<[string, boolean]>) {
      const { call: withNext } = await serve({ authorize: () => ({ allow: false, reason: 'Ask for access.', next: { label: 'Request access', href } }) });
      const refused = await withNext('POST', '/api/query', { sql: 'SELECT 1' });
      expect(refused.status).toBe(403);
      expect(Boolean(refused.body?.next), href).toBe(kept);
    }
  }, 120_000);

  it('a hook that answers late still decides; one that never answers holds the request (no time limit) and never allows', async () => {
    const { call } = await serve({ authorize: async () => { await new Promise((done) => setTimeout(done, 400)); return { allow: false, reason: 'Late no.' }; } });
    const late = await call('POST', '/api/query', { sql: 'SELECT 1' });
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('Late no.');
    const held = gate<{ allow: boolean }>();
    const { call: stuckCall } = await serve({ authorize: () => held.promise });
    const stuck = await stuckCall('POST', '/api/query', { sql: 'SELECT 1' }, { timeoutMs: 1_500 });
    evidence({ hook: 'authorize', mode: 'never', status: stuck.status, ms: stuck.ms });
    expect(stuck.status).toBe('no answer');
    held.release({ allow: true });
  });
});

describe('rowPolicy (HH-3)', () => {
  duckIt('a throw, a refusal or any malformed answer refuses in plain words and runs nothing; no internals, no echo of the answer', async () => {
    const answers: Array<[string, unknown]> = [
      ['throw', 'THROW'],
      ['bare string (SQL instead of { sql })', `SELECT id, ssn FROM claims /* ${SECRET} */`],
      ['number', 42],
      ['null', null],
      ['undefined', undefined],
      ['sql number', { sql: 42 }],
      ['sql empty', { sql: '   ' }],
      ['refuse number', { refuse: 42 }],
      ['groupRows string', { sql: 'SELECT 1 AS n', groupRows: 'n' }],
      ['groupRows minimum 0', { sql: 'SELECT 1 AS n', groupRows: { column: 'n', minimum: 0, refusal: 'Too small.' } }],
      ['groupRows minimum 1.5', { sql: 'SELECT 1 AS n', groupRows: { column: 'n', minimum: 1.5, refusal: 'Too small.' } }],
      ['groupRows no column', { sql: 'SELECT 1 AS n', groupRows: { column: '', minimum: 5, refusal: 'Too small.' } }],
    ];
    for (const [label, result] of answers) {
      const ran: string[] = [];
      const { call } = await serve({
        rowPolicy: (query) => {
          if (result === 'THROW') throw new Error('policy store down: CANARY-ROWPOLICY-INTERNAL');
          return result as never;
        },
        statements: (event) => { ran.push(event.outcome); },
      }, { warehouse: true });
      const answer = await call('POST', '/api/query', { sql: 'SELECT id, region FROM claims' });
      evidence({ hook: 'rowPolicy', mode: label, status: answer.status, error: String(answer.body?.error ?? '').slice(0, 300), code: answer.body?.code, outcomes: ran });
      expect.soft(answer.status, `${label}: ${answer.text.slice(0, 300)}`).toBe(403);
      expect.soft(answer.body?.code, label).toBe('POLICY_DENIED');
      expect.soft(String(answer.body?.error ?? ''), `${label}: internals`).not.toMatch(INTERNALS);
      expect.soft(answer.text, `${label}: echoes the hook's answer`).not.toContain(SECRET);
      expect.soft(answer.text, label).not.toContain('CANARY-ROWPOLICY-INTERNAL');
      expect.soft(answer.text, `${label}: rows`).not.toContain('West');
      expect.soft(ran.includes('ok'), `${label}: a statement ran`).toBe(false);
    }
  }, 180_000);

  duckIt('a policy that answers late still decides; one that never answers holds the request and never runs it', async () => {
    const held = gate<{ refuse: string }>();
    let runs = 0;
    const { call } = await serve({ rowPolicy: () => held.promise, statements: (event) => { if (event.outcome === 'ok') runs += 1; } }, { warehouse: true });
    const stuck = await call('POST', '/api/query', { sql: 'SELECT id FROM claims' }, { timeoutMs: 1_500 });
    evidence({ hook: 'rowPolicy', mode: 'never', status: stuck.status, ms: stuck.ms });
    expect(stuck.status).toBe('no answer');
    expect(runs).toBe(0);
    held.release({ refuse: 'No.' });
    const { call: lateCall } = await serve({ rowPolicy: async (query) => { await new Promise((done) => setTimeout(done, 300)); return { sql: `SELECT * FROM (${query.sql}) WHERE region = 'West'` }; } }, { warehouse: true });
    const late = await lateCall('POST', '/api/query', { sql: 'SELECT id, region FROM claims' });
    expect(late.status, late.text.slice(0, 200)).toBe(200);
    expect(JSON.stringify(late.body.rows)).not.toContain('East');
  }, 60_000);
});

describe('credentials (HH-4)', () => {
  duckIt('a throw, a refusal or a malformed answer is CREDENTIALS_REQUIRED in plain words; the hook\'s answer (a token) never reaches the person', async () => {
    const answers: Array<[string, unknown]> = [
      ['throw', 'THROW'],
      ['bare token string', SECRET],
      ['null', null],
      ['undefined', undefined],
      ['connection null', { connection: null }],
      ['connection string', { connection: SECRET }],
      ['refuse number', { refuse: 7 }],
      ['array', [SECRET]],
    ];
    for (const [label, result] of answers) {
      const { call } = await serve({
        credentials: () => {
          if (result === 'THROW') throw new Error(`token endpoint down: ${SECRET}`);
          return result as never;
        },
      }, { warehouse: true });
      const answer = await call('POST', '/api/query', { sql: 'SELECT id, region FROM claims' });
      evidence({ hook: 'credentials', mode: label, status: answer.status, error: String(answer.body?.error ?? '').replaceAll(SECRET, '<CANARY>').slice(0, 300), code: answer.body?.code, containsSecret: answer.text.includes(SECRET) });
      expect.soft(answer.status, `${label}: ${answer.text.slice(0, 300).replaceAll(SECRET, '<CANARY>')}`).toBe(403);
      expect.soft(answer.body?.code, label).toBe('POLICY_DENIED');
      expect.soft(answer.text.includes(SECRET), `${label}: the hook's token is in the answer`).toBe(false);
      expect.soft(String(answer.body?.error ?? ''), `${label}: internals`).not.toMatch(INTERNALS);
    }
  }, 120_000);

  duckIt('a host\'s overlay cannot lift the engine restriction (row-policy.ts: "a host\'s overlay cannot lift it")', async () => {
    const { call } = await serve({ credentials: () => ({ connection: { restrictExternalAccess: false } as never }) }, { warehouse: true });
    const answer = await call('POST', '/api/query', { sql: "SELECT * FROM read_text('/etc/hosts')" });
    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain('localhost');
    // An overlay may name folders (`allowedDirectories` is a connection setting, and the hook may lay "any field but
    // driver" over the connection): plain reads under those folders are then allowed.
    const { call: withFolders } = await serve({ credentials: () => ({ connection: { allowedDirectories: [dbRoot] } as never }) }, { warehouse: true });
    const inFolder = await withFolders('POST', '/api/query', { sql: `SELECT COUNT(*) AS n FROM glob('${dbRoot}/*')` });
    evidence({ hook: 'credentials', mode: 'overlay allowedDirectories', status: inFolder.status });
  });
});

describe('statements (HH-6)', () => {
  duckIt('an observer that throws, rejects or never answers changes nothing for the person', async () => {
    for (const mode of ['throw', 'reject', 'never'] as const) {
      const { call } = await serve({
        statements: () => {
          if (mode === 'throw') throw new Error('metrics down');
          if (mode === 'reject') return Promise.reject(new Error('metrics down'));
          return new Promise<void>(() => undefined);
        },
      }, { warehouse: true });
      const answer = await call('POST', '/api/query', { sql: 'SELECT COUNT(*) AS n FROM claims' });
      expect(answer.status, `${mode}: ${answer.text.slice(0, 200)}`).toBe(200);
    }
  }, 60_000);
});

describe('columnsVisible (rule 10)', () => {
  duckIt('a throw or a malformed answer lists none of the table\'s columns; without the hook every column is listed', async () => {
    const listed = async (hook: DqlHostHooks['columnsVisible'] | undefined) => {
      const { call } = await serve(hook ? { columnsVisible: hook } : {}, { warehouse: true });
      const schema = await call('GET', '/api/schema');
      const described = await call('GET', '/api/describe-table?relation=main.claims');
      const fromSchema = (schema.body as Array<{ name: string; columns: Array<{ name: string }> }> | undefined)?.find((table) => /claims$/.test(table.name))?.columns.map((column) => column.name) ?? [];
      const fromDescribe = Array.isArray(described.body) ? described.body.map((column: { name: string }) => column.name) : [];
      return { schema: fromSchema.sort(), describe: fromDescribe.sort(), statuses: [schema.status, described.status] };
    };
    const all = await listed(undefined);
    evidence({ hook: 'columnsVisible', mode: 'absent', ...all });
    // GET /api/schema lists live tables without their columns (they load per table), so describe-table is the oracle.
    expect(all.describe).toEqual(['amount', 'id', 'region', 'ssn']);
    const hidden = await listed((_principal, _relation, columns) => columns.filter((name) => name !== 'ssn'));
    expect(hidden.describe).toEqual(['amount', 'id', 'region']);
    expect(hidden.schema).not.toContain('ssn');
    for (const [label, hook] of [
      ['throw', () => { throw new Error('policy store down'); }],
      ['null', () => null],
      ['string', () => 'id,region'],
      ['objects', () => [{ name: 'id' }]],
      ['numbers', () => [1, 2]],
    ] as unknown as Array<[string, DqlHostHooks['columnsVisible']]>) {
      const result = await listed(hook);
      evidence({ hook: 'columnsVisible', mode: label, ...result });
      expect(result.schema.filter((name) => name === 'ssn'), label).toEqual([]);
      expect(result.describe, label).toEqual([]);
      expect(result.statuses, label).toEqual([200, 200]);
    }
  }, 120_000);
});

/** Priya's own memo and research run, each quoting FIGURE, and a scripted needs-review Ask answer that quotes it too. */
function seedFigures(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'apps', 'claims', 'dashboards'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
    version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
    owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  const apps = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot), { owner: 'u-priya' });
  const memo = apps.createAppInvestigation({ appId: 'claims', question: 'Why did open claims change?' });
  apps.updateAppInvestigation(memo.id, { status: 'ready', summary: `${FIGURE} leads`, resultPreviews: [{ title: 'Open claims', result: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } }] });
  apps.close();
  const research = new LocalNotebookResearchStorage(join(projectRoot, '.dql', 'local', 'private', 'research', `${homePersonKey(priya)}.sqlite`));
  const run = research.createRun({ notebookPath: 'notebooks/a.dqlnb', title: 'Adjusters', question: 'Which adjusters have the most open claims?' });
  research.updateRun(run.id, { recommendation: `${FIGURE} first`, resultPreview: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } as never);
  research.close();
}

const reviewAnswer = () => ({
  summary: `Leading rows: ${FIGURE} · 15`,
  answer: `Leading rows: ${FIGURE} · 15`,
  status: 'needs_review' as const,
  trustState: 'review_required' as const,
  stopReason: 'human_review_required' as const,
  artifacts: [{ id: 'answer-1', kind: 'answer' as const, title: 'Generated answer', trustState: 'review_required' as const, payload: { text: `Leading rows: ${FIGURE}`, answer: FIGURE, result: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } }],
  evaluations: [],
  nextActions: [],
});
const scripted = { conversation: reviewAnswer, generated_answer: reviewAnswer, semantic_answer: reviewAnswer, certified_answer: reviewAnswer, research: reviewAnswer };

describe('answerFigures (HH-14)', () => {
  async function figuresSeen(hook: DqlHostHooks['answerFigures']): Promise<{ ask: boolean; memo: boolean; research: boolean; chat: number | string }> {
    const { call } = await serve({ answerFigures: hook }, { setup: seedFigures, agentRunExecutors: scripted });
    const asked = await call('POST', '/api/agent-runs', { question: 'Which adjusters have the most open claims?' });
    const runId = asked.body?.run?.id as string | undefined;
    const stored = runId ? await call('GET', `/api/agent-runs/${encodeURIComponent(runId)}`) : asked;
    const memos = await call('GET', '/api/apps/claims/investigations');
    const research = await call('GET', '/api/notebook/research');
    const chat = await call('POST', '/api/llm/run', { messages: [{ role: 'user', content: 'hi' }] });
    return { ask: asked.text.includes(FIGURE) || stored.text.includes(FIGURE), memo: memos.text.includes(FIGURE), research: research.text.includes(FIGURE), chat: chat.body?.code ?? chat.status };
  }

  it('control: "show" shows the figures; "withhold_review" and a throw withhold them everywhere', async () => {
    expect(await figuresSeen(() => 'show')).toMatchObject({ ask: true, memo: true, research: true });
    expect(await figuresSeen(() => 'withhold_review')).toEqual({ ask: false, memo: false, research: false, chat: 'FIGURES_WITHHELD' });
    expect(await figuresSeen(() => { throw new Error('settings store down'); })).toEqual({ ask: false, memo: false, research: false, chat: 'FIGURES_WITHHELD' });
  }, 60_000);

  it('a malformed answer withholds, as a throw does (fail closed): anything but "show" keeps needs-review figures back', async () => {
    const junk: Array<[string, unknown]> = [['undefined', undefined], ['null', null], ['typo "withhold"', 'withhold'], ['upper case', 'WITHHOLD_REVIEW'], ['true', true], ['object', { rule: 'withhold_review' }], ['array', ['withhold_review']]];
    const seen: Record<string, unknown> = {};
    for (const [label, value] of junk) seen[label] = await figuresSeen(() => value as never);
    evidence({ hook: 'answerFigures', mode: 'junk', seen });
    for (const [label] of junk) expect.soft(seen[label], label).toEqual({ ask: false, memo: false, research: false, chat: 'FIGURES_WITHHELD' });
  }, 120_000);

  it('a late answer still decides; one that never answers holds the Ask request and shows nothing', async () => {
    expect(await figuresSeen(async () => { await new Promise((done) => setTimeout(done, 300)); return 'withhold_review' as const; })).toEqual({ ask: false, memo: false, research: false, chat: 'FIGURES_WITHHELD' });
    const held = gate<'show'>();
    const { call } = await serve({ answerFigures: () => held.promise }, { setup: seedFigures, agentRunExecutors: scripted });
    const memos = await call('GET', '/api/apps/claims/investigations', undefined, { timeoutMs: 1_500 });
    evidence({ hook: 'answerFigures', mode: 'never', status: memos.status, ms: memos.ms });
    expect(memos.text).not.toContain(FIGURE);
    held.release('show');
  }, 60_000);
});

describe('figuresDependOnReader, keepsAnswerText, isInBoundary, sourceAccess (fail closed by value)', () => {
  it('figuresDependOnReader: only `false` means no; a throw or anything else is yes; no host is no; a host with rowPolicy and no hook is yes', async () => {
    expect(await hostFiguresDependOnReader(undefined, ['claims'])).toBe(false);
    expect(await hostFiguresDependOnReader({ rowPolicy: ({ sql }) => ({ sql }) }, ['claims'])).toBe(true);
    expect(await hostFiguresDependOnReader({}, ['claims'])).toBe(false);
    expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => false }, ['claims'])).toBe(false);
    for (const value of [true, 0, '', null, undefined, 'false', {}, Promise.resolve(0)]) {
      expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => value as never }, ['claims']), String(value)).toBe(true);
    }
    expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => { throw new Error('x'); } }, undefined)).toBe(true);
    expect(await hostFiguresDependOnReader({ figuresDependOnReader: () => Promise.reject(new Error('x')) }, undefined)).toBe(true);
  });

  it('isInBoundary: only `true` lets values reach a model; a throw, a Promise or junk keeps them back; no hook: only a model on this machine', () => {
    const model = { id: 'anthropic', name: 'claude', baseUrl: 'https://api.example.test' };
    const decide = (isInBoundary: DqlHostHooks['isInBoundary'], local = false) => withRequestContext({ principal: priya, requestId: 'r', hooks: { isInBoundary } }, () => resultValuesMayReachModel(model, () => local, { relations: ['main.claims'] }));
    expect(decide(() => true)).toBe(true);
    for (const value of [1, 'true', {}, [], null, undefined, Promise.resolve(true)]) expect(decide(() => value as never), String(value)).toBe(false);
    expect(decide(() => { throw new Error('x'); })).toBe(false);
    expect(withRequestContext({ principal: priya, requestId: 'r', hooks: {} }, () => resultValuesMayReachModel(model, () => false))).toBe(false);
    expect(withRequestContext({ principal: priya, requestId: 'r', hooks: {} }, () => resultValuesMayReachModel(model, () => true))).toBe(true);
  });

  it('sourceAccess: a throw or malformed answer allows none; nobody signed in allows none; no hook allows all (null)', async () => {
    const sources = [{ id: 'app:block:claims:1', kind: 'dataset' as const, name: 'Claims' }, { id: 'metric:paid', kind: 'metric' as const, name: 'Paid' }];
    expect(await hostAllowedSources(undefined, priya, sources)).toBeNull();
    expect(await hostAllowedSources({}, priya, sources)).toBeNull();
    expect(await hostAllowedSources({ sourceAccess: () => ['metric:paid'] }, null, sources)).toEqual(new Set());
    for (const value of [null, undefined, 42, {}, 'app:block:claims:1']) {
      const allowed = await hostAllowedSources({ sourceAccess: () => value as never }, priya, sources);
      expect(sources.filter((source) => allowed?.has(source.id)).map((source) => source.id), String(value)).toEqual([]);
    }
    expect(await hostAllowedSources({ sourceAccess: () => { throw new Error('x'); } }, priya, sources)).toEqual(new Set());
  });

  it('purposeAttributes: a malformed value never makes finding a person\'s own run throw', () => {
    for (const value of ['model', { model: true }, 42, null]) {
      const run = () => withRequestContext({ principal: { ...priya, attributes: { region: 'West', model: true } }, requestId: 'r', hooks: { purposeAttributes: value as never } }, () => hostPrincipalRunOwner());
      let outcome: string;
      try { outcome = JSON.stringify(run()); } catch (error) { outcome = `threw: ${(error as Error).message}`; }
      evidence({ hook: 'purposeAttributes', mode: JSON.stringify(value), outcome });
      expect.soft(outcome, JSON.stringify(value)).not.toMatch(/^threw/);
    }
  });
});

describe('ui (HH-9) and GET /api/host/ui', () => {
  it('a throw gives the person and capabilities without extras; malformed extras are dropped, never a 500', async () => {
    const thrown = await (await serve({ ui: () => { throw new Error('ui store down'); } })).call('GET', '/api/host/ui');
    expect(thrown.status).toBe(200);
    expect(thrown.body).toMatchObject({ host: true, person: { id: 'u-priya' }, links: [], answerActions: [] });
    const junk: Array<[string, unknown]> = [
      ['string', 'links'],
      ['links object', { links: { id: 'x' } }],
      ['links with null', { links: [null] }],
      ['links bad href', { links: [{ id: 'x', label: 'X', href: 'https://evil.example', placement: 'nav' }, { id: 'y', label: 'Y', href: 'javascript:alert(1)', placement: 'nav' }] }],
      ['answerActions string', { answerActions: 'x' }],
      ['answerActions with null', { answerActions: [null] }],
      ['banner number', { banner: 5 }],
      ['signOut external', { signOutUrl: 'https://evil.example/logout' }],
      ['environment number', { environment: 42 }],
      ['appNotFound string', { appNotFound: 'nope' }],
    ];
    for (const [label, extras] of junk) {
      const answer = await (await serve({ ui: () => extras as never })).call('GET', '/api/host/ui');
      evidence({ hook: 'ui', mode: label, status: answer.status, error: answer.body?.error });
      expect.soft(answer.status, `${label}: ${answer.text.slice(0, 200)}`).toBe(200);
      expect.soft(answer.body?.host, label).toBe(true);
      expect.soft(answer.text, label).not.toContain('evil.example');
      expect.soft(answer.text, label).not.toContain('javascript:');
    }
  }, 60_000);

  it('without a host the app is told { host: false }; with a host whose resolvePrincipal is absent, too', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-noui-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), '{}');
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, connection: { driver: 'file' } as ConnectionConfig, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    expect(await (await fetch(`http://127.0.0.1:${port}/api/host/ui`)).json()).toEqual({ host: false });
  });
});

describe('homeCards, directoryGroups, follows, answerStatus, audience (HH-9, HH-10, HH-16)', () => {
  it('homeCards: a throw or junk gives no cards; a host that never answers gives none within about 5 s', async () => {
    for (const [label, hook] of [['throw', () => { throw new Error('x'); }], ['string', () => 'cards'], ['objects', () => [{ id: 1 }, null, { id: 'a', title: 'A', items: 'x', more: { label: 'm', href: 'https://evil.example' } }]]] as unknown as Array<[string, DqlHostHooks['homeCards']]>) {
      const answer = await (await serve({ homeCards: hook })).call('GET', '/api/host/home-cards');
      expect(answer.status, label).toBe(200);
      expect(answer.text, label).not.toContain('evil.example');
    }
    const held = gate<never[]>();
    const answer = await (await serve({ homeCards: () => held.promise })).call('GET', '/api/host/home-cards', undefined, { timeoutMs: 8_000 });
    evidence({ hook: 'homeCards', mode: 'never', status: answer.status, ms: answer.ms });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ cards: [] });
    expect(answer.ms).toBeLessThan(7_000);
    held.release([]);
  }, 60_000);

  it('directoryGroups: a throw or junk means no group may be saved', async () => {
    for (const [label, hook] of [['throw', () => { throw new Error('x'); }], ['null', () => null], ['string', () => 'claims'], ['objects', () => [{ id: 7 }, null]]] as unknown as Array<[string, DqlHostHooks['directoryGroups']]>) {
      const answer = await (await serve({ directoryGroups: hook })).call('GET', '/api/host/groups');
      expect(answer.body, label).toEqual({ source: 'host', groups: [] });
    }
  });

  it('follows: a list that throws or answers junk shows none; a set that throws is refused in plain words without the host\'s own error text', async () => {
    const setup = (projectRoot: string) => {
      mkdirSync(join(projectRoot, 'apps', 'claims'), { recursive: true });
      writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({ version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft', owners: ['t@example.com'] }));
    };
    for (const list of [() => { throw new Error('x'); }, () => 'claims', () => [null, { appId: 7 }]] as Array<() => never>) {
      const answer = await (await serve({ follows: { list, set: () => undefined } }, { setup })).call('GET', '/api/apps/claims/follow');
      expect(answer.status).toBe(200);
      expect(answer.body.follows).toEqual([]);
    }
    const answer = await (await serve({ follows: { list: () => [], set: () => { throw new Error('connect ECONNREFUSED 10.0.3.7:5432 (CANARY-HOST-DB-INTERNAL)'); } } }, { setup })).call('POST', '/api/apps/claims/follow', { following: true });
    evidence({ hook: 'follows.set', mode: 'throw', status: answer.status, error: answer.body?.error });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect.soft(answer.text, 'the host\'s own error text reaches the person').not.toContain('CANARY-HOST-DB-INTERNAL');
  });

  it('audience: a throw means stakeholder; a malformed answer should mean the same (never the analyst default)', async () => {
    const seen: Array<string | undefined> = [];
    const audienceOf = async (hook: DqlHostHooks['audience']) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'dql-audience-'));
      roots.push(projectRoot);
      writeFileSync(join(projectRoot, 'dql.config.json'), '{}');
      const port = await startLocalServer({
        rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, connection: { driver: 'file' }, preferredPort: 0,
        hostHooks: { resolvePrincipal: () => priya, audience: hook },
        askAnalyticalPlannerProviderFactory: ({ request }: { request: { audience?: string } }) => { seen.push(request.audience); return null; },
        captureServer: (created: Server) => { servers.push(created); },
      } as never);
      await fetch(`http://127.0.0.1:${port}/api/agent-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'How many open claims?', audience: 'analyst' }) });
      return seen.at(-1);
    };
    expect(await audienceOf(() => { throw new Error('x'); })).toBe('stakeholder');
    const junk = await audienceOf(() => 'reader' as never);
    evidence({ hook: 'audience', mode: 'junk "reader"', planner_saw: junk ?? '(absent: the engine defaults to analyst)' });
    expect.soft(junk ?? 'analyst (default)', 'a malformed audience').toBe('stakeholder');
  }, 60_000);
});

describe('knowledgeSources (HH-15), audit (HH-6), tools (HH-7)', () => {
  it('knowledgeSources: a throw or junk gives none; nobody signed in gives none', async () => {
    for (const value of [null, 'x', [null, { id: 7, url: 'https://x.example' }, { id: 'ok' }]]) {
      expect(await knowledgeServersFor({ projectRoot: tmpdir(), hooks: { knowledgeSources: () => value as never }, principal: priya }), JSON.stringify(value)).toEqual([]);
    }
    expect(await knowledgeServersFor({ projectRoot: tmpdir(), hooks: { knowledgeSources: () => { throw new Error('x'); } }, principal: priya })).toEqual([]);
    expect(await knowledgeServersFor({ projectRoot: tmpdir(), hooks: { knowledgeSources: () => [{ id: 'c', url: 'https://c.example' }] }, principal: null })).toEqual([]);
  });

  it('audit: a sink that throws, rejects or never answers never changes the answer; each failure is counted', async () => {
    const before = observabilityFailures().audit;
    for (const mode of ['throw', 'reject', 'never'] as const) {
      const { call } = await serve({
        audit: () => {
          if (mode === 'throw') throw new Error('audit down');
          if (mode === 'reject') return Promise.reject(new Error('audit down'));
          return new Promise<void>(() => undefined);
        },
      });
      const answer = await call('POST', '/api/agent/threads', { title: 'A thread', surface: 'ask' });
      expect(answer.status, mode).toBe(201);
    }
    await new Promise((done) => setTimeout(done, 50));
    expect(observabilityFailures().audit - before).toBeGreaterThanOrEqual(2);
  });

  it('tools: a gate that throws refuses the tool; one that answers late still answers; one that never answers holds it', async () => {
    const { runGatedTool } = await import('@duckcodeailabs/dql-agent');
    const held = gate<unknown>();
    await serve({
      tools: async (call, next) => {
        if (call.name === 'refused') throw new Error('Not for you.');
        if (call.name === 'late') { await new Promise((done) => setTimeout(done, 200)); return next(); }
        if (call.name === 'stuck') return held.promise;
        return next();
      },
    });
    await withRequestContext({ principal: priya, requestId: 'r' }, async () => {
      await expect(runGatedTool({ name: 'refused', run: async () => 'ran' }, {})).rejects.toThrow('Not for you.');
      expect(await runGatedTool({ name: 'late', run: async () => 'ran' }, {})).toBe('ran');
      const outcome = await Promise.race([runGatedTool({ name: 'stuck', run: async () => 'ran' }, {}), new Promise((done) => setTimeout(() => done('held'), 500))]);
      evidence({ hook: 'tools', mode: 'never', outcome });
      expect(outcome).toBe('held');
    });
    held.release('released');
  });
});

describe('stores (HH-6): a host store that throws or answers junk', () => {
  /** A run store whose every method throws, rejects, or answers junk. */
  const brokenRuns = (mode: 'throw' | 'reject' | 'junk') => new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (property === 'close') return async () => undefined;
      return (..._args: unknown[]) => {
        if (mode === 'throw') throw new Error('store down: CANARY-STORE-INTERNAL at 10.0.3.7');
        if (mode === 'reject') return Promise.reject(new Error('store down: CANARY-STORE-INTERNAL at 10.0.3.7'));
        return Promise.resolve(property === 'list' ? 'not a list' : property === 'count' ? 'many' : { id: 'r-x', ownerId: 'u-dan', question: 'CANARY-OTHER-PERSON-QUESTION' });
      };
    },
  });

  it('runs: a store that throws, rejects or answers junk refuses in plain words, never quotes the store, and never shows another person\'s run', async () => {
    for (const mode of ['throw', 'reject', 'junk'] as const) {
      const { call } = await serve({ stores: { runs: brokenRuns(mode) as never } }, { agentRunExecutors: scripted });
      const asked = await call('POST', '/api/agent-runs', { question: 'How many open claims?' });
      const listed = await call('GET', '/api/agent-runs');
      const byId = await call('GET', '/api/agent-runs/r-x');
      evidence({ hook: 'stores.runs', mode, ask: asked.status, list: listed.status, get: byId.status, askError: String(asked.body?.error ?? '').slice(0, 160), listError: String(listed.body?.error ?? '').slice(0, 160) });
      for (const [label, answer] of [['ask', asked], ['list', listed], ['get', byId]] as const) {
        expect.soft(answer.text, `${mode} ${label}: the store's own words`).not.toContain('CANARY-STORE-INTERNAL');
        expect.soft(answer.text, `${mode} ${label}: another person's run`).not.toContain('CANARY-OTHER-PERSON-QUESTION');
        expect.soft(String(answer.body?.error ?? ''), `${mode} ${label}: internals`).not.toMatch(INTERNALS);
      }
    }
  }, 60_000);

  it('conversations and memory: a store that throws refuses in plain words without its own text', async () => {
    const throwing = new Proxy({}, { get: (_t, property) => (property === 'then' ? undefined : property === 'close' ? async () => undefined : () => { throw new Error('store down: CANARY-STORE-INTERNAL'); }) });
    const { call } = await serve({ stores: { conversations: () => throwing as never, memory: () => throwing as never } });
    for (const [method, path, body] of [['GET', '/api/agent/threads', undefined], ['POST', '/api/agent/threads', { title: 'x', surface: 'ask' }], ['GET', '/api/agent/memory', undefined]] as const) {
      const answer = await call(method, path, body);
      evidence({ hook: 'stores.conversations/memory', route: `${method} ${path}`, status: answer.status, error: String(answer.body?.error ?? '').slice(0, 160) });
      expect.soft(answer.text, `${method} ${path}`).not.toContain('CANARY-STORE-INTERNAL');
      expect.soft(answer.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
  }, 60_000);
});

describe('keepsAnswerText (HH-14, earlier static answer tiles)', () => {
  it('only `true` keeps the earlier answer text; a throw or anything else reads the placeholder', async () => {
    const { createAppPackage } = await import('../apps-api.js');
    const { readFileSync: read } = await import('node:fs');
    const ANSWER = 'West has 149 open claims worth $1,204,330.';
    const setup = (projectRoot: string) => {
      mkdirSync(join(projectRoot, 'blocks', 'claims'), { recursive: true });
      writeFileSync(join(projectRoot, 'blocks', 'claims', 'open-claims.dql'), 'block "Open claims" {\n  domain = "claims"\n  status = "certified"\n  type = "custom"\n  description = "Open claims by region"\n  owner = "analytics@local"\n  query = """SELECT region, COUNT(*) AS n FROM main.claims GROUP BY region"""\n  visualization {\n    chart = "bar"\n  }\n}\n');
      const created = createAppPackage(projectRoot, { name: 'Claims weekly', domain: 'claims', owners: ['owner@local'], selectedBlockIds: ['Open claims'] });
      if (!created.ok) throw new Error('App not created');
      const pagePath = join(projectRoot, 'apps', 'claims-weekly', 'dashboards', 'overview.dqld');
      const page = JSON.parse(read(pagePath, 'utf-8'));
      // An Ask answer published as text before the rule (no record of what it read).
      page.layout.items.push({ i: 'ask-old', x: 0, y: 30, w: 12, h: 2, title: 'Open claims (Ask)', text: { markdown: ANSWER }, viz: { type: 'text' }, sourceClass: 'narrative', sourceEvidence: [{ source: 'ask:ask-old', reason: 'Saved from Ask.', kind: 'text', trustState: 'review_required' }] });
      writeFileSync(pagePath, `${JSON.stringify(page, null, 2)}\n`);
    };
    const seen: Record<string, boolean> = {};
    for (const [label, hook] of [['true', () => true], ['false', () => false], ['throw', () => { throw new Error('x'); }], ['"yes"', () => 'yes'], ['1', () => 1], ['object', () => ({ keep: true })], ['undefined', () => undefined]] as Array<[string, () => unknown]>) {
      const { call } = await serve({ rowPolicy: ({ sql }) => ({ sql }), keepsAnswerText: hook as never }, { setup });
      const answer = await call('GET', '/api/apps/claims-weekly/dashboards/overview');
      seen[label] = answer.text.includes('149');
      expect(answer.status, `${label}: ${answer.text.slice(0, 160)}`).toBe(200);
    }
    evidence({ hook: 'keepsAnswerText', seen });
    expect(seen).toEqual({ true: true, false: false, throw: false, '"yes"': false, 1: false, object: false, undefined: false });
  }, 60_000);
});
