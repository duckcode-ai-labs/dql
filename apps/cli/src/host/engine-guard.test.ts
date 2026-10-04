import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBConnector, QueryExecutor, type ConnectionConfig, type QueryResult } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { HOSTED_STATEMENT_REFUSED, HOSTED_SYSTEM_RELATION_REFUSED, hostedStatementRefusal, isEngineRestrictionError, restrictedEngineConnection } from './engine-guard.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';
import { withHostQueryHooks, type DqlQueryContext } from './row-policy.js';

/**
 * RFC 0010, with a host: a statement reaches the connection's tables and views, and nothing else the
 * engine could reach — no file, no environment variable, no extension, no other database, no setting.
 * The engine is restricted (DuckDB), and the statement is checked for the same families on every engine.
 * Without a host nothing changes.
 */
describe('the statement check, with a host', () => {
  it('is part of the host package, with the reading it rests on, so a host can check a statement the same way', async () => {
    const host = await import('./index.js');
    expect(host.hostedStatementRefusal).toBe(hostedStatementRefusal);
    expect(host.hostedStatementRefusal('SELECT 1; SELECT 2', 'duckdb', [], { readOnly: true })).toBe(host.HOSTED_READ_ONLY_REFUSED);
    expect(host.knownLexicon('snowflake')).toBe(true);
    expect(host.knownLexicon('no-such-engine')).toBe(false);
    expect(host.lexStatement("SELECT 'a;b' -- note", 'postgresql').map((token) => token.kind)).toEqual(['word', 'string']);
    expect(() => host.lexStatement('SELECT /* open', 'postgresql')).toThrow(host.UnreadableStatement);
  });

  const refused = (sql: string, driver = 'duckdb', allowed: string[] = []) => hostedStatementRefusal(sql, driver, allowed) !== null;

  it('refuses file readers, the environment, queries given as text, and statements that reach beyond the tables', () => {
    for (const sql of [
      "SELECT * FROM read_text('/etc/hosts')",
      "SELECT * FROM read_csv_auto('/etc/hosts')",
      "SELECT * FROM read_parquet('x.parquet')",
      "SELECT * FROM glob('/etc/*')",
      "SELECT * FROM sniff_csv('/etc/hosts')",
      "SELECT * FROM parquet_metadata('x.parquet')",
      "SELECT getenv('HOME') AS h",
      "SELECT * FROM query('SELECT 1')",
      "SELECT * FROM query_table('claims')",
      'SELECT * FROM "read_text"(\'/etc/hosts\')',
      "SELECT * FROM main.read_text('/etc/hosts')",
      "SELECT * FROM '/etc/hosts'",
      'SELECT * FROM "notes.csv"',
      "SELECT * FROM claims, 'other.csv'",
      "SELECT * FROM claims JOIN 'other.csv' USING (id)",
      "SELECT * FROM (SELECT * FROM 'other.csv') AS o",
      "FROM 'other.csv'",
      "COPY claims TO '/tmp/out.csv'",
      "COPY claims FROM '/etc/hosts'",
      "EXPLAIN ANALYZE COPY claims TO '/tmp/out.csv'",
      "ATTACH '/tmp/other.duckdb' AS other",
      'DETACH other',
      'INSTALL httpfs',
      'FORCE INSTALL httpfs',
      'LOAD httpfs',
      'PRAGMA enable_profiling',
      'SET threads = 1',
      "SET VARIABLE path = '/etc/hosts'",
      'RESET threads',
      "EXPORT DATABASE '/tmp/export'",
      "IMPORT DATABASE '/tmp/export'",
      'SELECT 1; SET threads = 1',
      "PREPARE copy_out AS COPY claims TO '/tmp/out.csv'",
      'EXECUTE copy_out',
      "SELECT 'a' AS note, read_text('/etc/hosts') AS r",
      // A call the token scan reads as text is refused rather than trusted.
      "SELECT 'read_text(' AS note",
      'SELECT * FROM U&"claims"',
      "SELECT * FROM claims /* unterminated",
    ]) expect(refused(sql), sql).toBe(true);
  });

  it('refuses the same families on other engines', () => {
    expect(refused("SELECT pg_read_file('/etc/passwd')", 'postgresql')).toBe(true);
    expect(refused("COPY claims FROM PROGRAM 'id'", 'postgresql')).toBe(true);
    expect(refused('SET ROLE admin', 'postgresql')).toBe(true);
    expect(refused("SELECT lo_import('/etc/passwd')", 'postgresql')).toBe(true);
    expect(refused("SELECT * FROM claims INTO OUTFILE '/tmp/x'", 'mysql')).toBe(true);
    expect(refused("LOAD DATA INFILE '/etc/passwd' INTO TABLE claims", 'mysql')).toBe(true);
    expect(refused("SELECT LOAD_FILE('/etc/passwd')", 'mysql')).toBe(true);
    expect(refused("ATTACH DATABASE '/tmp/other.db' AS other", 'sqlite')).toBe(true);
    expect(refused("SELECT load_extension('x')", 'sqlite')).toBe(true);
    expect(refused("VACUUM INTO '/tmp/copy.db'", 'sqlite')).toBe(true);
    expect(refused("PUT file:///etc/passwd @stage", 'snowflake')).toBe(true);
    expect(refused('USE ROLE accountadmin', 'snowflake')).toBe(true);
    expect(refused("UNLOAD ('SELECT 1') TO 's3://bucket/x'", 'redshift')).toBe(true);
  });

  it('runs ordinary questions over tables and views', () => {
    for (const sql of [
      'SELECT region, COUNT(*) AS n FROM main.claims GROUP BY region ORDER BY region',
      'WITH west AS (SELECT * FROM claims WHERE region = \'West\') SELECT COUNT(*) FROM west',
      "SELECT a, 'b.csv' AS label FROM claims WHERE note IN ('x.csv', 'y')",
      'SELECT * FROM claims_by_region',
      'DESCRIBE SELECT * FROM claims',
      'SELECT "date"."year" FROM claims AS "date"',
      "SELECT $$text$$ AS note FROM claims",
      'SELECT * FROM range(10)',
      "SELECT current_setting('enable_external_access') AS access",
    ]) expect(refused(sql), sql).toBe(false);
  });

  it('lets a file reader read a plain path inside a folder the connection allows, and nothing else', () => {
    const data = mkdtempSync(join(tmpdir(), 'dql-allowed-'));
    try {
      expect(refused(`SELECT * FROM read_csv('${data}/claims.csv')`, 'duckdb', [data])).toBe(false);
      expect(refused(`SELECT * FROM read_csv(['${data}/a.csv', '${data}/b.csv'], header = true)`, 'duckdb', [data])).toBe(false);
      expect(refused(`SELECT * FROM read_parquet('${data}/*.parquet')`, 'duckdb', [data])).toBe(false);
      expect(refused(`SELECT * FROM '${data}/claims.csv'`, 'duckdb', [data])).toBe(false);
      expect(refused(`SELECT * FROM read_csv('${data}/../outside.csv')`, 'duckdb', [data])).toBe(true);
      expect(refused(`SELECT * FROM read_csv('${data}x/claims.csv')`, 'duckdb', [data])).toBe(true);
      expect(refused(`SELECT * FROM read_csv(concat('${data}/', 'claims.csv'))`, 'duckdb', [data])).toBe(true);
      expect(refused("SELECT * FROM read_csv('s3://bucket/claims.csv')", 'duckdb', [data])).toBe(true);
      expect(refused("SELECT * FROM read_text('/etc/hosts')", 'duckdb', [data])).toBe(true);
      expect(refused(`SELECT getenv('HOME'), * FROM read_csv('${data}/claims.csv')`, 'duckdb', [data])).toBe(true);
      // A folder reached through a link is judged by where it really is.
      symlinkSync('/etc', join(data, 'etc-link'));
      expect(refused(`SELECT * FROM read_text('${data}/etc-link/hosts')`, 'duckdb', [data])).toBe(true);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('restricts DuckDB and file connections only, and reads the engine\'s own refusal', () => {
    expect(restrictedEngineConnection({ driver: 'duckdb', filepath: 'x.duckdb' }).restrictExternalAccess).toBe(true);
    expect(restrictedEngineConnection({ driver: 'file' }).restrictExternalAccess).toBe(true);
    expect(restrictedEngineConnection({ driver: 'postgresql' }).restrictExternalAccess).toBeUndefined();
    expect(isEngineRestrictionError(new Error('DuckDB query failed: Permission Error: Scanning read_text files is disabled through configuration'))).toBe(true);
    expect(isEngineRestrictionError(new Error('DuckDB query failed: Invalid Input Error: Cannot change configuration option "threads" - the configuration has been locked'))).toBe(true);
    expect(isEngineRestrictionError(new Error('Catalog Error: Table with name x does not exist!'))).toBe(false);
  });

  it('checks every statement the host\'s executor runs, before the row policy, and leaves it alone without a host', async () => {
    const ran: Array<{ sql: string; config: ConnectionConfig }> = [];
    const result = { columns: [], rows: [], rowCount: 0 } as unknown as QueryResult;
    const inner = {
      executePositional: async (sql: string, _params: unknown[], config: ConnectionConfig) => { ran.push({ sql, config }); return result; },
      getConnector: async () => ({ execute: async (sql: string) => { ran.push({ sql, config: { driver: 'duckdb' } }); return result; }, disconnect: async () => undefined }),
    } as unknown as QueryExecutor;
    const policy: DqlQueryContext[] = [];
    const hosted = withHostQueryHooks(inner, { engine: true, rowPolicy: (query) => { policy.push(query); return { sql: query.sql }; } });
    const duckdb: ConnectionConfig = { driver: 'duckdb', filepath: 'w.duckdb' };
    await expect(hosted.executePositional("SELECT * FROM read_text('/etc/hosts')", [], duckdb)).rejects.toThrow(HOSTED_STATEMENT_REFUSED);
    await expect((await hosted.getConnector(duckdb)).execute('INSTALL httpfs')).rejects.toThrow(HOSTED_STATEMENT_REFUSED);
    expect(policy).toEqual([]);
    expect(ran).toEqual([]);
    await hosted.executePositional('SELECT 1 AS one', [], duckdb);
    expect(ran[0]!.config.restrictExternalAccess).toBe(true);
    // Without a host the executor is the one it was given.
    expect(withHostQueryHooks(inner, {})).toBe(inner);
  });
});

const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const withDuckDb = connectorRoot ? describe : describe.skip;

withDuckDb('with a host, DuckDB reaches the database only (real DuckDB)', () => {
  const FILE_CANARY = 'CANARY-ENGINE-FILE-4c1e';
  const ENV_CANARY = 'CANARY-ENGINE-ENV-9b27';
  const scratch = mkdtempSync(join(tmpdir(), 'dql-engine-'));
  const outside = join(scratch, 'outside');
  const canaryFile = join(outside, 'canary.csv');
  const servers: Server[] = [];
  const executors: QueryExecutor[] = [];
  const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@insurer.example', source: 'host' };

  /** A project with a DuckDB warehouse (a table and a view) and a CSV in its data folder. */
  const project = async (name: string): Promise<{ root: string; database: string }> => {
    const root = join(scratch, name);
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(root, '.dql', 'connectors', 'node_modules'), 'dir');
    writeFileSync(join(root, 'data', 'regions.csv'), 'region,manager\nWest,Ana\nEast,Bo\n');
    const database = join(root, 'warehouse.duckdb');
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: name, connections: { default: { driver: 'duckdb', filepath: 'warehouse.duckdb' } } }));
    const seed = new DuckDBConnector();
    await seed.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] });
    await seed.execute("CREATE TABLE claims AS SELECT * FROM (VALUES ('West', 10), ('West', 5), ('East', 7)) AS t(region, amount)");
    await seed.execute('CREATE VIEW claims_by_region AS SELECT region, SUM(amount) AS total FROM claims GROUP BY region');
    await seed.disconnect();
    return { root, database };
  };

  const start = async (root: string, connection: ConnectionConfig, hostHooks?: DqlHostHooks) => {
    const executor = new QueryExecutor();
    executors.push(executor);
    const port = await startLocalServer({ rootDir: root, projectRoot: root, executor, connection, preferredPort: 0, ...(hostHooks ? { hostHooks } : {}), captureServer: (created) => { servers.push(created); } });
    return async (body: Record<string, unknown>, route = '/api/query') => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': 'priya' }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
    };
  };
  const hostHooks = (extra: Partial<DqlHostHooks> = {}): DqlHostHooks => ({ resolvePrincipal: (req) => (req.headers['x-test-person'] === 'priya' ? priya : null), ...extra });

  beforeAll(() => {
    mkdirSync(outside, { recursive: true });
    writeFileSync(canaryFile, `secret\n${FILE_CANARY}\n`);
    process.env.DQL_TEST_ENGINE_CANARY = ENV_CANARY;
  });
  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    await Promise.all(executors.splice(0).map((executor) => executor.disconnect().catch(() => undefined)));
    delete process.env.DQL_TEST_ENGINE_CANARY;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('refuses files, the environment, extensions and settings; the canaries never come back; tables and views still answer', async () => {
    const { root, database } = await project('hosted');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] }, hostHooks());
    const written = join(outside, 'written.csv');
    for (const sql of [
      `SELECT * FROM read_text('${canaryFile}')`,
      `SELECT * FROM read_csv_auto('${canaryFile}')`,
      `SELECT * FROM '${canaryFile}'`,
      `SELECT * FROM glob('${outside}/*')`,
      "SELECT getenv('DQL_TEST_ENGINE_CANARY') AS v",
      `SELECT * FROM query('SELECT * FROM read_text(''${canaryFile}'')')`,
      `COPY claims TO '${written}'`,
      `COPY claims FROM '${canaryFile}'`,
      `ATTACH '${join(outside, 'other.duckdb')}' AS other`,
      'INSTALL httpfs',
      'LOAD httpfs',
      'PRAGMA enable_profiling',
      'SET threads = 1',
      `EXPORT DATABASE '${join(outside, 'export')}'`,
    ]) {
      const answer = await call({ sql });
      expect(answer.status, `${sql}: ${answer.text}`).not.toBe(200);
      expect(answer.text).not.toContain(FILE_CANARY);
      expect(answer.text).not.toContain(ENV_CANARY);
    }
    const plain = await call({ sql: `SELECT * FROM read_text('${canaryFile}')` });
    expect(plain.status).toBe(403);
    expect(plain.text).toContain('DQL did not run this statement');
    // Nothing was written or attached.
    expect(existsSync(written)).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(['canary.csv']);

    // A person does not read the engine's settings; DQL's own statement (platform) does, through the same host
    // executor: the engine itself is restricted and its settings locked.
    const settingsSql = "SELECT current_setting('enable_external_access') AS access, current_setting('lock_configuration') AS locked";
    const settings = await call({ sql: settingsSql });
    expect(settings.status, settings.text).toBe(403);
    expect(settings.body.error).toBe(HOSTED_SYSTEM_RELATION_REFUSED);
    const own = new QueryExecutor();
    executors.push(own);
    const engine = await withHostQueryHooks(own, { engine: true }).executeQuery(settingsSql, [], {}, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] }, { purpose: 'platform' });
    expect(engine.rows[0]).toMatchObject({ access: false, locked: true });

    const table = await call({ sql: 'SELECT region, SUM(amount) AS total FROM claims GROUP BY region ORDER BY region' });
    expect(table.status, table.text).toBe(200);
    expect(table.body.rows).toEqual([{ region: 'East', total: 7 }, { region: 'West', total: 15 }]);
    const view = await call({ sql: 'SELECT * FROM claims_by_region ORDER BY region' });
    expect(view.status, view.text).toBe(200);
    expect(view.body.rows).toHaveLength(2);
  });

  it('reads files in a folder the connection allows, and still nothing outside it', async () => {
    const { root, database } = await project('allowed');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!], allowedDirectories: [join(root, 'data')] }, hostHooks());
    const inside = await call({ sql: `SELECT * FROM read_csv_auto('${join(root, 'data', 'regions.csv')}') ORDER BY region` });
    expect(inside.status, inside.text).toBe(200);
    expect(inside.body.rows).toEqual([{ region: 'East', manager: 'Bo' }, { region: 'West', manager: 'Ana' }]);
    for (const sql of [`SELECT * FROM read_text('${canaryFile}')`, `SELECT * FROM read_csv_auto('${join(root, 'data')}/../../outside/canary.csv')`, 'INSTALL httpfs', `COPY claims TO '${join(root, 'data', 'copy.csv')}'`]) {
      const answer = await call({ sql });
      expect(answer.status, sql).not.toBe(200);
      expect(answer.text).not.toContain(FILE_CANARY);
    }
    expect(existsSync(join(root, 'data', 'copy.csv'))).toBe(false);
  });

  it('keeps a draft space\'s uploaded dataset as a table its owner can query, without reading files for a statement', async () => {
    const { root, database } = await project('draft');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] }, hostHooks({ onePerson: true }));
    const upload = await call({ filename: 'targets.csv', contentBase64: Buffer.from('region,target,due\nWest,20,2026-01-31\nEast,9,2026-02-28\n').toString('base64') }, '/api/datasets/import');
    expect(upload.status, upload.text).toBe(201);
    const alias = upload.body.dataset.alias as string;
    expect(upload.body.dataset.profile.rowCount).toBe(2);
    const local = { target: 'local' };
    const rows = await call({ sql: `SELECT region, target, due FROM ${alias} ORDER BY region`, executionTarget: local });
    expect(rows.status, rows.text).toBe(200);
    expect(rows.body.rows.map((row: Record<string, unknown>) => [row.region, row.target, String(row.due).slice(0, 10)])).toEqual([['East', 9, '2026-02-28'], ['West', 20, '2026-01-31']]);
    const kind = await call({ sql: `SELECT table_type FROM information_schema.tables WHERE table_name = '${alias}'`, executionTarget: local });
    expect(kind.body.rows).toEqual([{ table_type: 'BASE TABLE' }]);
    // The workspace database is restricted too: the stored upload is not read by a statement.
    const stored = join(root, upload.body.dataset.sourcePath as string);
    const direct = await call({ sql: `SELECT * FROM read_csv_auto('${stored}')`, executionTarget: local });
    expect(direct.status).not.toBe(200);
    const canary = await call({ sql: `SELECT * FROM read_text('${canaryFile}')`, executionTarget: local });
    expect(canary.status).not.toBe(200);
    expect(canary.text).not.toContain(FILE_CANARY);
  });

  it('with a host, a statement a person writes only reads, on any connection; DQL still makes its own views of the data folder', async () => {
    const { root, database } = await project('read-only');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!], allowedDirectories: [join(root, 'data')] }, hostHooks());
    // DQL's own view over data/regions.csv, made at start (purpose platform), answers.
    const view = await call({ sql: 'SELECT region, manager FROM regions ORDER BY region' });
    expect(view.status, view.text).toBe(200);
    expect(view.body.rows).toEqual([{ region: 'East', manager: 'Bo' }, { region: 'West', manager: 'Ana' }]);
    for (const sql of [
      "INSERT INTO claims VALUES ('North', 1)",
      'UPDATE claims SET amount = 0',
      'DELETE FROM claims',
      'CREATE TABLE copied AS SELECT * FROM claims',
      'CREATE OR REPLACE VIEW regions AS SELECT 1 AS region',
      'DROP VIEW claims_by_region',
      'ALTER TABLE claims ADD COLUMN extra INTEGER',
      'TRUNCATE claims',
      "WITH x AS (SELECT 1) INSERT INTO claims SELECT 'North', 1 FROM x",
      'SELECT 1 AS one; SELECT 2 AS two',
      "SELECT nextval('none') AS n",
    ]) {
      const answer = await call({ sql });
      expect(answer.status, `${sql}: ${answer.text}`).toBe(403);
      expect(answer.text, sql).toContain('only reads data');
    }
    // Nothing changed.
    const count = await call({ sql: 'SELECT COUNT(*) AS n, SUM(amount) AS total FROM claims' });
    expect(count.body.rows).toEqual([{ n: 3, total: 22 }]);
    const objects = await call({ sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name" });
    expect(objects.body.rows.map((row: Record<string, unknown>) => row.table_name)).toEqual(['claims', 'claims_by_region', 'regions']);
  });

  it('changes nothing without a host: a person writes to their own DuckDB as before', async () => {
    const { root, database } = await project('single-user-writes');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] });
    const insert = await call({ sql: "INSERT INTO claims VALUES ('North', 1)" });
    expect(insert.status, insert.text).toBe(200);
    const created = await call({ sql: 'CREATE TABLE copied AS SELECT * FROM claims' });
    expect(created.status, created.text).toBe(200);
    const count = await call({ sql: 'SELECT COUNT(*) AS n FROM copied' });
    expect(count.body.rows).toEqual([{ n: 4 }]);
  });

  it('changes nothing without a host: a statement reads the project\'s CSV', async () => {
    const { root, database } = await project('single-user');
    const call = await start(root, { driver: 'duckdb', filepath: database, moduleSearchPaths: [connectorRoot!] });
    const answer = await call({ sql: `SELECT COUNT(*) AS n FROM read_csv_auto('${join(root, 'data', 'regions.csv')}')` });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.rows).toEqual([{ n: 2 }]);
  });
});
