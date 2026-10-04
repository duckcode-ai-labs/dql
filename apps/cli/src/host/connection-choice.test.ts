import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor, QueryResult } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';
import type { DqlQueryContext } from './row-policy.js';

/**
 * RFC 0010: with a host, the server chooses the connection. A request may
 * name one of the project's own connections; connection settings in the
 * request are never used (nothing in them is read); the server's local
 * DuckDB workspace only where the host allows it. Without a
 * host, the notebook's own UI picks connections as it always has.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.DQL_TEST_CONNECTION_CANARY;
});

async function start(hooks?: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-connection-choice-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'connection_choice',
    defaultConnectionName: 'default',
    connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' }, second: { driver: 'sqlite', filepath: 'second.sqlite' } },
  }));
  const used: Array<Record<string, unknown>> = [];
  const result = { columns: [{ name: 'one', type: 'integer' }], rows: [{ one: 1 }], rowCount: 1, executionTime: 1 } as unknown as QueryResult;
  const executor = {
    // Like the real executor: expands, then runs through executePositional (where the host's hooks sit).
    async executeQuery(this: QueryExecutor, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(sql, [], config); },
    executePositional: async (_sql: string, _params: unknown, config: ConnectionConfig) => { used.push({ ...config }); return result; },
    getConnector: async (config: ConnectionConfig) => { used.push({ ...config }); return { execute: async () => result, disconnect: async () => undefined }; },
    disconnect: async () => undefined,
  } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor,
    preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: (req) => (req.headers['x-test-person'] === 'priya' ? priya : null), ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (body: unknown, route = '/api/query') => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': 'priya' }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  return { call, used, projectRoot };
}

describe('with a host, the server chooses the connection (RFC 0010)', () => {
  it('never uses a connection object from the request, nor expands its environment references', async () => {
    process.env.DQL_TEST_CONNECTION_CANARY = 'CANARY-CONNECTION-ENV-7f3a';
    const policy: DqlQueryContext[] = [];
    const { call, used } = await start({ rowPolicy: (query) => { policy.push(query); return { sql: query.sql }; } });
    const answer = await call({ sql: 'SELECT 1 AS one', connection: { name: 'mine', driver: 'postgresql', host: '127.0.0.1', port: 9, password: '${DQL_TEST_CONNECTION_CANARY}' } });
    expect(answer.text).not.toContain('CANARY-CONNECTION-ENV-7f3a');
    expect(used.length).toBeGreaterThan(0);
    for (const config of used) {
      expect(config.driver).toBe('sqlite');
      expect(String(config.filepath)).toMatch(/main\.sqlite$/);
      expect(config.name).not.toBe('mine');
      expect(JSON.stringify(config)).not.toContain('CANARY-CONNECTION-ENV-7f3a');
    }
    expect(policy.length).toBeGreaterThan(0);
    expect(policy.every((query) => query.connection.name !== 'mine' && query.connection.driver === 'sqlite')).toBe(true);
  });

  it('picks one of the project\'s own connections by name, and the host hears that name', async () => {
    const policy: DqlQueryContext[] = [];
    const { call, used } = await start({ rowPolicy: (query) => { policy.push(query); return { sql: query.sql }; } });
    const answer = await call({ sql: 'SELECT 1 AS one', executionTarget: { target: 'connection', connectionName: 'second' } });
    expect(answer.status, answer.text).toBe(200);
    expect(used.some((config) => String(config.filepath).endsWith('second.sqlite') && config.name === 'second')).toBe(true);
    expect(policy.at(-1)?.connection).toEqual({ driver: 'sqlite', name: 'second' });
  });

  it('refuses a connection name the project does not have, without repeating it', async () => {
    const { call, used } = await start({});
    const answer = await call({ sql: 'SELECT 1 AS one', executionTarget: { target: 'connection', connectionName: 'someone-elses-warehouse' } });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.text).toContain('no connection by that name');
    expect(answer.text).not.toContain('someone-elses-warehouse');
    expect(used).toEqual([]);
  });

  it('refuses an Ask that names a connection the project does not have, or the local files, before a run records it', async () => {
    const { call } = await start({});
    const unknown = await call({ question: 'How many?', executionTarget: { target: 'connection', connectionName: 'someone-elses-warehouse' } }, '/api/agent-runs');
    expect(unknown.status).toBe(403);
    expect(unknown.text).toContain('CONNECTION_NOT_ALLOWED');
    expect(unknown.text).not.toContain('someone-elses-warehouse');
    const local = await call({ question: 'How many?', executionTarget: { target: 'local' } }, '/api/agent-runs');
    expect(local.status).toBe(403);
  });

  it('refuses the server\'s local workspace unless the host allows it', async () => {
    const refused = await start({});
    const answer = await refused.call({ sql: 'SELECT 1 AS one', executionTarget: { target: 'local' } });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.text).toContain('not on the server\'s local files');
    expect(refused.used).toEqual([]);
  });
});

describe('a refusal is a refusal, not a server error', () => {
  it('answers 403 with POLICY_DENIED when the host\'s row policy refuses, and for a connection the server chooses', async () => {
    const { call } = await start({ rowPolicy: () => ({ refuse: 'You may not read files here.' }) });
    const refused = await call({ sql: 'SELECT 1 AS one' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({ code: 'POLICY_DENIED', error: 'You may not read files here.' });
    const local = await call({ sql: 'SELECT 1 AS one', executionTarget: { target: 'local' } });
    expect(local.status).toBe(403);
  });
});

describe('without a host, the notebook picks the connection as before', () => {
  it('runs on the connection the request carries', async () => {
    const { call, used } = await start();
    const answer = await call({ sql: 'SELECT 1 AS one', connection: { driver: 'sqlite', filepath: ':memory:' } });
    expect(answer.status, answer.text).toBe(200);
    expect(used.some((config) => config.filepath === ':memory:')).toBe(true);
    const unknown = await call({ sql: 'SELECT 1 AS one', executionTarget: { target: 'connection', connectionName: 'nope' } });
    expect(unknown.text).toContain('Connection not found: nope');
  });
});
