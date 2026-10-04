import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBConnector, QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal, DqlStatementEvent } from './request-context.js';
import type { DqlQueryContext } from './row-policy.js';

/**
 * RFC 0010 HH-3 / HH-6: describing a table is a statement like any other. With a host, the connector's catalog
 * lookup runs through the one checked path as metadata (the row policy sees it, the statement observer hears of
 * it), and a name holding a quote, a backslash or a control character is not looked up. Without a host the lookup
 * binds the name, so such a name changes nothing either.
 */
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const withDuckDb = connectorRoot ? describe : describe.skip;

withDuckDb('describing a table (real DuckDB)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dql-describe-'));
  const servers: Server[] = [];
  const executors: QueryExecutor[] = [];
  const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@insurer.example', source: 'host' };

  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    await Promise.all(executors.splice(0).map((executor) => executor.disconnect().catch(() => undefined)));
    rmSync(scratch, { recursive: true, force: true });
  });

  const project = async (name: string): Promise<{ root: string; connection: ConnectionConfig }> => {
    const root = join(scratch, name);
    mkdirSync(join(root, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(root, '.dql', 'connectors', 'node_modules'), 'dir');
    const database = join(root, 'warehouse.duckdb');
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: name, connections: { default: { driver: 'duckdb', filepath: 'warehouse.duckdb' } } }));
    const seed = new DuckDBConnector();
    await seed.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] });
    await seed.execute("CREATE TABLE claims AS SELECT * FROM (VALUES ('West', 10)) AS t(region, amount)");
    await seed.disconnect();
    return { root, connection: { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] } };
  };

  const start = async (root: string, connection: ConnectionConfig, hostHooks?: DqlHostHooks) => {
    const executor = new QueryExecutor();
    executors.push(executor);
    const port = await startLocalServer({ rootDir: root, projectRoot: root, executor, connection, preferredPort: 0, ...(hostHooks ? { hostHooks } : {}), captureServer: (created) => { servers.push(created); } });
    return async (relation: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/describe-table?relation=${encodeURIComponent(relation)}`, { headers: { 'x-test-person': 'priya' } });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
    };
  };

  it('with a host, runs the catalog lookup through the statement observer and the row policy, as metadata', async () => {
    const { root, connection } = await project('hosted');
    const events: DqlStatementEvent[] = [];
    const queries: DqlQueryContext[] = [];
    const call = await start(root, connection, {
      resolvePrincipal: (req) => (req.headers['x-test-person'] === 'priya' ? priya : null),
      statements: (event) => { events.push(event); },
      rowPolicy: (query) => { queries.push(query); return { sql: query.sql, params: query.params }; },
    });
    events.length = 0;
    queries.length = 0;
    const described = await call('main.claims');
    expect(described.status, described.text).toBe(200);
    expect(described.body).toEqual([{ name: 'region', type: 'VARCHAR' }, { name: 'amount', type: 'INTEGER' }]);
    expect(events.some((event) => event.purpose === 'metadata' && event.outcome === 'ok')).toBe(true);
    const lookup = queries.find((query) => query.purpose === 'metadata' && /information_schema\.columns/i.test(query.sql));
    expect(lookup, JSON.stringify(queries.map((query) => query.sql))).toBeDefined();
    // The names are values of the lookup, not part of its text.
    expect(lookup!.sql).not.toContain('claims');
    expect(lookup!.params).toEqual(['main', 'claims']);
  });

  it('with a host, refuses a name holding a quote, a backslash or a control character, plainly and before any statement', async () => {
    const { root, connection } = await project('hosted-names');
    const events: DqlStatementEvent[] = [];
    const call = await start(root, connection, { resolvePrincipal: (req) => (req.headers['x-test-person'] === 'priya' ? priya : null), statements: (event) => { events.push(event); } });
    events.length = 0;
    for (const relation of [`"main"."cla'ims"`, '"main"."cla\\ims"', `"main"."claims${String.fromCharCode(1)}"`, '`main`.`cl"aims`']) {
      const refused = await call(relation);
      expect(refused.status, relation).toBe(400);
      expect(refused.body).toMatchObject({ code: 'RELATION_NAME_REFUSED', error: expect.stringContaining('plain name') });
    }
    expect(events).toEqual([]);
    // A plain name still answers.
    expect((await call('main.claims')).status).toBe(200);
  });

  it('without a host, a name holding quotes or backslashes is only a name: nothing but its own columns (none) comes back', async () => {
    const { root, connection } = await project('single-user');
    const call = await start(root, connection);
    for (const relation of [`"main"."claims' UNION SELECT 'x', 'y' --"`, '"main"."claims\\\' OR 1=1 --"']) {
      const answer = await call(relation);
      expect(answer.status, `${relation}: ${answer.text}`).toBe(200);
      expect(answer.body).toEqual([]);
    }
    expect((await call('main.claims')).body).toEqual([{ name: 'region', type: 'VARCHAR' }, { name: 'amount', type: 'INTEGER' }]);
  });
});
