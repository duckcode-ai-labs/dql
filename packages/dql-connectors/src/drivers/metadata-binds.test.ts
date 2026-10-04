import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnector } from '../connector.js';
import type { QueryResult } from '../result-types.js';
import { AthenaConnector } from './athena.js';
import { BigQueryConnector } from './bigquery.js';
import { ClickHouseConnector } from './clickhouse.js';
import { DatabricksConnector, databricksNamedParameters } from './databricks.js';
import { DuckDBConnector } from './duckdb.js';
import { FabricConnector } from './fabric.js';
import { MSSQLConnector } from './mssql.js';
import { MySQLConnector } from './mysql.js';
import { PostgreSQLConnector } from './postgresql.js';
import { RedshiftConnector } from './redshift.js';
import { inlineParameters } from './shared.js';
import { SnowflakeConnector } from './snowflake.js';
import { SQLiteConnector } from './sqlite.js';
import { TrinoConnector } from './trino.js';

/**
 * A table's or schema's name reaches each engine's catalog lookup (listColumns, listTables) as a bound value, never
 * inside the statement's text: a name holding quotes or backslashes cannot change the statement. Each engine's
 * generated SQL is recorded with its values.
 */
const SCHEMA = "sch'em\\a";
const TABLE = "ta'b\\le --";
const EMPTY: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };

type Recorded = Array<{ sql: string; params: unknown[] }>;

function recording(connector: DatabaseConnector, rows: QueryResult['rows'] = []): Recorded {
  const calls: Recorded = [];
  (connector as unknown as { execute: DatabaseConnector['execute'] }).execute = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { ...EMPTY, rows };
  };
  return calls;
}

function expectBound(calls: Recorded, names: string[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    for (const name of names) expect(call.sql, call.sql).not.toContain(name);
    expect(call.sql).not.toMatch(/sch'|ta'b|\\a|\\le/);
  }
  expect(calls.flatMap((call) => call.params)).toEqual(expect.arrayContaining(names));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('catalog lookups bind names on every engine', () => {
  it.each([
    ['snowflake', () => new SnowflakeConnector()],
    ['postgresql', () => new PostgreSQLConnector()],
    ['redshift', () => new RedshiftConnector()],
    ['mysql', () => new MySQLConnector()],
    ['duckdb', () => new DuckDBConnector()],
    ['mssql', () => new MSSQLConnector()],
    ['fabric', () => new FabricConnector()],
    ['trino', () => new TrinoConnector()],
    ['athena', () => new AthenaConnector()],
    ['clickhouse', () => new ClickHouseConnector()],
  ] as const)('%s: listColumns carries the schema and table names only as bound values', async (_driver, make) => {
    const connector = make();
    if (connector instanceof TrinoConnector) (connector as unknown as { catalog: string }).catalog = 'hive';
    const calls = recording(connector);
    await connector.listColumns!(SCHEMA, TABLE);
    expectBound(calls, [SCHEMA, TABLE]);
  });

  it('bigquery: the table name is a query parameter, and a dataset name with quotes or backslashes is refused', async () => {
    const connector = new BigQueryConnector();
    const calls = recording(connector);
    await connector.listColumns('analytics', TABLE);
    expectBound(calls, [TABLE]);
    expect(calls[0]!.sql).toContain('`analytics`.INFORMATION_SCHEMA.COLUMNS');
    await expect(connector.listColumns('an`a\\lytics', TABLE)).rejects.toThrow(/dataset names/);
    expect(calls).toHaveLength(1);
  });

  it('sqlite: each table is described through pragma_table_info with its name bound', async () => {
    const connector = new SQLiteConnector();
    const calls: Recorded = [];
    (connector as unknown as { execute: DatabaseConnector['execute'] }).execute = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { ...EMPTY, rows: /sqlite_master/.test(sql) ? [{ name: TABLE, type: 'table' }] : [{ name: 'a', type: 'TEXT', cid: 0 }] };
    };
    const columns = await connector.listColumns(undefined, TABLE);
    expect(columns).toEqual([{ schema: 'main', table: TABLE, name: 'a', dataType: 'TEXT', ordinalPosition: 1 }]);
    const describe = calls.find((call) => /pragma_table_info/.test(call.sql))!;
    expect(describe.sql).toBe('SELECT name, type, cid FROM pragma_table_info(?)');
    expect(describe.params).toEqual([TABLE]);
  });

  it('databricks: the names are named parameters of the statement API, never in the statement', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [] } }, result: { data_array: [] } }), { status: 200 });
    });
    const connector = new DatabricksConnector();
    await connector.connect({ driver: 'databricks', host: 'adb-1.azuredatabricks.net', token: 'test-token', warehouse: 'w1' });
    await connector.listColumns(SCHEMA, TABLE);
    expect(bodies).toHaveLength(1);
    const statement = String(bodies[0]!.statement);
    expect(statement).toContain('table_schema = :dql_p1');
    expect(statement).toContain('table_name = :dql_p2');
    expect(statement).not.toMatch(/sch'|ta'b/);
    expect(bodies[0]!.parameters).toEqual([{ name: 'dql_p1', value: SCHEMA, type: 'STRING' }, { name: 'dql_p2', value: TABLE, type: 'STRING' }]);
  });

  it('databricks: placeholders in strings, quoted names and comments are left alone; values are typed; a count mismatch is refused', () => {
    const bound = databricksNamedParameters("SELECT '?' AS q, `a?` FROM t -- ?\nWHERE x = ? AND y = ? /* ? */ AND z = ? AND w = ?", ['a', 2, 2.5, null]);
    expect(bound.statement).toBe("SELECT '?' AS q, `a?` FROM t -- ?\nWHERE x = :dql_p1 AND y = :dql_p2 /* ? */ AND z = :dql_p3 AND w = :dql_p4");
    expect(bound.parameters).toEqual([
      { name: 'dql_p1', value: 'a', type: 'STRING' },
      { name: 'dql_p2', value: '2', type: 'BIGINT' },
      { name: 'dql_p3', value: '2.5', type: 'DOUBLE' },
      { name: 'dql_p4' },
    ]);
    expect(() => databricksNamedParameters('SELECT ?', [])).toThrow(/placeholder/);
  });

  it('engines without binding on their API take each value as a literal in their own escaping', () => {
    // Trino and Athena strings take no backslash escapes: a doubled quote is the whole escape.
    expect(inlineParameters('SELECT 1 WHERE n = ?', [TABLE])).toBe("SELECT 1 WHERE n = 'ta''b\\le --'");
    // ClickHouse reads backslashes: both the quote and the backslash are escaped.
    expect(inlineParameters('SELECT 1 WHERE n = ?', [TABLE], 'backslash')).toBe("SELECT 1 WHERE n = 'ta\\'b\\\\le --'");
  });
});
