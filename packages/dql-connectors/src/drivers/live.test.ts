/**
 * Live connector checks against real servers. Skipped unless the server is
 * named in the environment, e.g.
 *
 *   DQL_LIVE_MODULES=/path/with/node_modules \
 *   DQL_LIVE_POSTGRES='{"host":"localhost","port":55432,"username":"dql","password":"dql","database":"dql"}' \
 *   pnpm vitest run src/drivers/live.test.ts
 *
 * Each engine proves the same contract: typed values come back as the
 * calendar day / number the server holds, parameters bind, a row cap is
 * reported as truncated, a deadline and an abort release the caller, the
 * connection still works afterwards, and tables and columns list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionConfig, DatabaseConnector } from '../connector.js';
import { ConnectionPoolManager } from '../connection-pool.js';
import { QueryExecutor } from '../query-executor.js';

interface Engine {
  env: string;
  driver: ConnectionConfig['driver'];
  /** Statements that build `dql_live.orders` (or the engine's equivalent). */
  seed: string[];
  table: string;
  schema: string;
  /** A statement that runs for several seconds. */
  slow: string;
  /** SQL with one `$1` placeholder comparing `status`. */
  param: string;
}

const ENGINES: Engine[] = [
  {
    env: 'DQL_LIVE_POSTGRES',
    driver: 'postgresql',
    seed: [
      'DROP SCHEMA IF EXISTS dql_live CASCADE',
      'CREATE SCHEMA dql_live',
      `CREATE TABLE dql_live.orders (id BIGINT PRIMARY KEY, status TEXT, amount NUMERIC(12,2), ordered_on DATE, placed_at TIMESTAMP, paid BOOLEAN)`,
      `INSERT INTO dql_live.orders SELECT g, CASE WHEN g % 2 = 0 THEN 'shipped' ELSE 'open' END, g * 1.5, DATE '2024-01-31', TIMESTAMP '2024-01-31 23:30:00', g % 3 = 0 FROM generate_series(1, 50) g`,
    ],
    table: 'orders',
    schema: 'dql_live',
    slow: 'SELECT pg_sleep(10)',
    param: 'SELECT count(*) AS n FROM dql_live.orders WHERE status = $1',
  },
  // Redshift speaks the PostgreSQL protocol; a PostgreSQL server stands in
  // for its wire behaviour (cursor, cancel, types) when no cluster is at hand.
  {
    env: 'DQL_LIVE_REDSHIFT',
    driver: 'redshift',
    seed: [
      'DROP SCHEMA IF EXISTS dql_live CASCADE',
      'CREATE SCHEMA dql_live',
      `CREATE TABLE dql_live.orders (id BIGINT PRIMARY KEY, status TEXT, amount NUMERIC(12,2), ordered_on DATE, placed_at TIMESTAMP, paid BOOLEAN)`,
      `INSERT INTO dql_live.orders SELECT g, CASE WHEN g % 2 = 0 THEN 'shipped' ELSE 'open' END, g * 1.5, DATE '2024-01-31', TIMESTAMP '2024-01-31 23:30:00', g % 3 = 0 FROM generate_series(1, 50) g`,
    ],
    table: 'orders',
    schema: 'dql_live',
    slow: 'SELECT pg_sleep(10)',
    param: 'SELECT count(*) AS n FROM dql_live.orders WHERE status = $1',
  },
  {
    env: 'DQL_LIVE_MYSQL',
    driver: 'mysql',
    seed: [
      'DROP TABLE IF EXISTS orders',
      `CREATE TABLE orders (id BIGINT PRIMARY KEY, status VARCHAR(20), amount DECIMAL(12,2), ordered_on DATE, placed_at DATETIME, paid BOOLEAN)`,
      `INSERT INTO orders WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 50)
       SELECT n, IF(n % 2 = 0, 'shipped', 'open'), n * 1.5, DATE '2024-01-31', TIMESTAMP '2024-01-31 23:30:00', n % 3 = 0 FROM g`,
    ],
    table: 'orders',
    schema: 'dql_live',
    slow: 'SELECT SLEEP(10)',
    param: 'SELECT count(*) AS n FROM orders WHERE status = $1',
  },
  {
    env: 'DQL_LIVE_MSSQL',
    driver: 'mssql',
    seed: [
      "IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders",
      `CREATE TABLE dbo.orders (id BIGINT PRIMARY KEY, status NVARCHAR(20), amount DECIMAL(12,2), ordered_on DATE, placed_at DATETIME2, paid BIT)`,
      `WITH g AS (SELECT TOP 50 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects)
       INSERT INTO dbo.orders SELECT n, CASE WHEN n % 2 = 0 THEN 'shipped' ELSE 'open' END, n * 1.5, '2024-01-31', '2024-01-31T23:30:00', CASE WHEN n % 3 = 0 THEN 1 ELSE 0 END FROM g`,
    ],
    table: 'orders',
    schema: 'dbo',
    slow: "WAITFOR DELAY '00:00:10'; SELECT 1 AS done",
    param: 'SELECT count(*) AS n FROM dbo.orders WHERE status = $1',
  },
  {
    env: 'DQL_LIVE_CLICKHOUSE',
    driver: 'clickhouse',
    seed: [
      'DROP TABLE IF EXISTS orders',
      `CREATE TABLE orders (id Int64, status String, amount Decimal(12,2), ordered_on Date, placed_at DateTime, paid Bool) ENGINE = MergeTree ORDER BY id`,
      `INSERT INTO orders SELECT number + 1, if((number + 1) % 2 = 0, 'shipped', 'open'), (number + 1) * 1.5, toDate('2024-01-31'), toDateTime('2024-01-31 23:30:00'), (number + 1) % 3 = 0 FROM numbers(50)`,
    ],
    table: 'orders',
    schema: 'default',
    slow: 'SELECT sleepEachRow(1) FROM numbers(10) SETTINGS max_block_size = 1, function_sleep_max_microseconds_per_block = 0',
    param: 'SELECT count() AS n FROM orders WHERE status = $1',
  },
  {
    env: 'DQL_LIVE_TRINO',
    driver: 'trino',
    seed: [
      'DROP TABLE IF EXISTS memory.dql_live.orders',
      'CREATE SCHEMA IF NOT EXISTS memory.dql_live',
      `CREATE TABLE memory.dql_live.orders AS SELECT CAST(n AS BIGINT) AS id, IF(n % 2 = 0, 'shipped', 'open') AS status, CAST(n * 1.5 AS DECIMAL(12,2)) AS amount,
         DATE '2024-01-31' AS ordered_on, TIMESTAMP '2024-01-31 23:30:00' AS placed_at, n % 3 = 0 AS paid FROM UNNEST(sequence(1, 50)) AS t(n)`,
    ],
    table: 'orders',
    schema: 'dql_live',
    slow: 'SELECT count(*) FROM tpch.sf100.lineitem a CROSS JOIN tpch.sf100.lineitem b',
    param: 'SELECT count(*) AS n FROM memory.dql_live.orders WHERE status = $1',
  },
];

const modules = process.env.DQL_LIVE_MODULES ? [process.env.DQL_LIVE_MODULES] : undefined;

for (const engine of ENGINES) {
  const raw = process.env[engine.env];
  describe.skipIf(!raw)(`${engine.driver} live`, () => {
    const config = { driver: engine.driver, moduleSearchPaths: modules, ...(raw ? JSON.parse(raw) : {}) } as ConnectionConfig;
    const pool = new ConnectionPoolManager();
    const executor = new QueryExecutor(pool);
    let connector: DatabaseConnector;
    const run = (sql: string, values: unknown[] = [], options = {}) => executor.executePositional(sql, values, config, options);

    beforeAll(async () => {
      connector = await pool.getConnector(config);
      for (const statement of engine.seed) await connector.execute(statement);
    }, 120_000);

    afterAll(async () => {
      await pool.disconnectAll();
    });

    it('returns calendar days, numbers and booleans as the server holds them', async () => {
      const table = engine.driver === 'trino' ? 'memory.dql_live.orders' : engine.driver === 'mssql' ? 'dbo.orders' : engine.driver === 'postgresql' || engine.driver === 'redshift' ? 'dql_live.orders' : 'orders';
      const result = await run(`SELECT id, status, amount, ordered_on, placed_at, paid FROM ${table} WHERE id = 3`);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0]!;
      expect(row.id).toBe(3);
      expect(row.amount).toBe(4.5);
      expect(String(row.ordered_on)).toBe('2024-01-31');
      expect(String(row.placed_at)).toMatch(/^2024-01-31[ T]23:30:00/);
      expect(Boolean(row.paid)).toBe(true);
      const types = Object.fromEntries(result.columns.map((column) => [column.name, column.type]));
      expect(types.id).toBe('number');
      expect(types.amount).toBe('number');
      expect(types.ordered_on).toBe('date');
      expect(types.placed_at).toBe('datetime');
    });

    it('binds a parameter', async () => {
      const result = await run(engine.param, ["shipped"]);
      expect(Number(result.rows[0]!.n)).toBe(25);
      const quoted = await run(engine.param, ["o'pen"]);
      expect(Number(quoted.rows[0]!.n)).toBe(0);
    });

    it('reports a row cap as truncated, and a fit as whole', async () => {
      const table = engine.driver === 'trino' ? 'memory.dql_live.orders' : engine.driver === 'mssql' ? 'dbo.orders' : engine.driver === 'postgresql' || engine.driver === 'redshift' ? 'dql_live.orders' : 'orders';
      const cut = await run(`SELECT id FROM ${table} ORDER BY id`, [], { maxRows: 10 });
      expect(cut.rows).toHaveLength(10);
      expect(cut.truncated).toBe(true);
      expect(cut.rows[9]!.id).toBe(10);
      const whole = await run(`SELECT id FROM ${table} ORDER BY id`, [], { maxRows: 50 });
      expect(whole.rows).toHaveLength(50);
      expect(whole.truncated).toBeUndefined();
    });

    it('releases the caller at the deadline, and the connection still answers', async () => {
      const started = Date.now();
      await expect(run(engine.slow, [], { deadlineMs: 1_500 })).rejects.toThrow(/deadline/);
      expect(Date.now() - started).toBeLessThan(5_000);
      const after = await run('SELECT 1 AS ok');
      expect(Number(after.rows[0]!.ok)).toBe(1);
    }, 30_000);

    it('releases the caller on abort', async () => {
      const controller = new AbortController();
      const pending = run(engine.slow, [], { signal: controller.signal });
      setTimeout(() => controller.abort('stopped by the user'), 500);
      await expect(pending).rejects.toThrow(/cancelled/);
      const after = await run('SELECT 1 AS ok');
      expect(Number(after.rows[0]!.ok)).toBe(1);
    }, 30_000);

    it('lists tables and columns', async () => {
      const tables = await connector.listTables!();
      expect(tables.some((table) => table.name === engine.table && table.schema === engine.schema)).toBe(true);
      const columns = await connector.listColumns!(engine.schema, engine.table);
      expect(columns.map((column) => column.name)).toEqual(['id', 'status', 'amount', 'ordered_on', 'placed_at', 'paid']);
    }, 60_000);

    it('never repeats the password in a failed sign-in', async () => {
      if (!config.password) return;
      const wrong = { ...config, password: `${config.password}-wrong-9f3` };
      const fresh = new ConnectionPoolManager();
      await expect(fresh.getConnector(wrong)).rejects.toSatisfy((error: Error) => !error.message.includes('-wrong-9f3'));
      await fresh.disconnectAll();
    }, 60_000);
  });
}
