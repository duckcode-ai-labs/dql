import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseConnector,
  QueryExecutor,
  SQLParamSpec,
  TableInfo,
} from '@zlens/connectors';
import { buildParamValues, normalizeSQLPlaceholders } from '@zlens/connectors';

/**
 * A REAL warehouse for the golden harness, without a DuckDB binary.
 *
 * The Ask battery answers every SELECT with rows shaped like its projection,
 * which proves the machine ran and nothing about whether the answer is right.
 * The golden harness needs actual numbers, so this executor loads a committed
 * seed (`seeds/seed.json`, the same shape `scripts/seed-eval-warehouse.mjs`
 * consumes) into better-sqlite3 and executes the server's SQL against it.
 *
 * Two shims make dbt-flavoured SQL run on sqlite; both are documented here
 * because a reader of a failing test must know what the engine is NOT:
 *   1. Three-part relation names (`"jaffle_shop"."dev"."orders"`) collapse to
 *      the last two parts. Each seed schema is an ATTACHed in-memory database,
 *      so `dev.orders` resolves; the catalog segment has no sqlite equivalent.
 *   2. `information_schema.tables` / `.columns` are emulated from the seed so
 *      the runtime-schema introspection tiers see the same relations a
 *      warehouse would report.
 * DuckDB functions the fixtures use (`date_trunc`, `median`) are registered
 * as user functions. Anything else DuckDB-specific fails loudly, which is the
 * point: the harness measures the SQL the product actually emitted.
 */

interface SeedColumn { name: string; type: string }
interface SeedTable { columns: SeedColumn[]; rows: Record<string, unknown>[] }
export interface GoldenSeed { tables: Record<string, SeedTable> }

const SQLITE_TYPE: Record<string, string> = {
  text: 'TEXT', int: 'INTEGER', decimal: 'REAL', bool: 'INTEGER', timestamp: 'TEXT',
};
const INFORMATION_SCHEMA_TYPE: Record<string, string> = {
  text: 'VARCHAR', int: 'INTEGER', decimal: 'DOUBLE', bool: 'BOOLEAN', timestamp: 'TIMESTAMP',
};

const require = createRequire(import.meta.url);

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `"a"."b"."c"` and `a.b.c` become `"b"."c"` / `b.c`; two-part names are untouched. */
export function collapseCatalogPrefix(sql: string): string {
  return sql.replace(
    /("?)([A-Za-z_][A-Za-z0-9_]*)\1\.("?)([A-Za-z_][A-Za-z0-9_]*)\3\.("?)([A-Za-z_][A-Za-z0-9_]*)\5/g,
    (_match, _q1, _catalog, q2, schema, q3, table) => `${q2}${schema}${q2}.${q3}${table}${q3}`,
  );
}

function truncateDate(grain: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  switch (grain.toLowerCase()) {
    case 'year': return `${year}-01-01`;
    case 'quarter': {
      const quarterStart = Math.floor((Number(month) - 1) / 3) * 3 + 1;
      return `${year}-${String(quarterStart).padStart(2, '0')}-01`;
    }
    case 'month': return `${year}-${month}-01`;
    case 'week': {
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      const offset = (date.getUTCDay() + 6) % 7; // ISO week starts Monday
      date.setUTCDate(date.getUTCDate() - offset);
      return date.toISOString().slice(0, 10);
    }
    default: return `${year}-${month}-${day}`;
  }
}

export interface SeededSqliteExecutor extends QueryExecutor {
  /** The raw handle, for reference-SQL evaluation inside the harness. */
  readonly db: Database.Database;
  /** Every statement the server sent, verbatim (before shims), in order. */
  readonly log: string[];
  /** Run reference SQL and return plain rows. */
  query(sql: string): Record<string, unknown>[];
}

export function createSeededSqliteExecutor(seed: GoldenSeed): SeededSqliteExecutor {
  const BetterSqlite = require('better-sqlite3') as typeof Database;
  const db = new BetterSqlite(':memory:');
  const schemas = new Set<string>();
  for (const relation of Object.keys(seed.tables)) {
    const schema = relation.includes('.') ? relation.split('.')[0]! : 'main';
    if (schema !== 'main' && !schemas.has(schema)) {
      db.exec(`ATTACH DATABASE ':memory:' AS ${quote(schema)}`);
      schemas.add(schema);
    }
  }
  db.exec(`ATTACH DATABASE ':memory:' AS information_schema`);
  db.exec(`CREATE TABLE information_schema.tables (table_catalog TEXT, table_schema TEXT, table_name TEXT, table_type TEXT)`);
  db.exec(`CREATE TABLE information_schema.columns (table_catalog TEXT, table_schema TEXT, table_name TEXT, column_name TEXT, data_type TEXT, ordinal_position INTEGER, is_nullable TEXT)`);
  const insertTable = db.prepare(`INSERT INTO information_schema.tables VALUES (?, ?, ?, ?)`);
  const insertColumn = db.prepare(`INSERT INTO information_schema.columns VALUES (?, ?, ?, ?, ?, ?, ?)`);

  for (const [relation, definition] of Object.entries(seed.tables)) {
    const [schema, table] = relation.includes('.') ? relation.split('.') as [string, string] : ['main', relation];
    const qualified = `${quote(schema)}.${quote(table)}`;
    const columns = definition.columns.map((column) => `${quote(column.name)} ${SQLITE_TYPE[column.type] ?? 'TEXT'}`).join(', ');
    db.exec(`CREATE TABLE ${qualified} (${columns})`);
    const names = definition.columns.map((column) => column.name);
    const insert = db.prepare(`INSERT INTO ${qualified} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
    const load = db.transaction((rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        insert.run(names.map((name) => {
          const value = row[name];
          if (typeof value === 'boolean') return value ? 1 : 0;
          if (value === undefined) return null;
          return value as never;
        }));
      }
    });
    load(definition.rows);
    insertTable.run('jaffle_shop', schema, table, 'BASE TABLE');
    definition.columns.forEach((column, index) => {
      insertColumn.run('jaffle_shop', schema, table, column.name, INFORMATION_SCHEMA_TYPE[column.type] ?? 'VARCHAR', index + 1, 'YES');
    });
  }

  db.function('date_trunc', { deterministic: true }, (grain: unknown, value: unknown) => truncateDate(String(grain), value));
  db.aggregate('median', {
    start: () => [] as number[],
    step: (values: number[], next: unknown) => { if (typeof next === 'number') values.push(next); },
    result: (values: number[]) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    },
  });

  const log: string[] = [];

  const runSql = (sql: string, values?: unknown[], maxRows?: number) => {
    const started = performance.now();
    const statement = db.prepare(collapseCatalogPrefix(sql));
    if (!statement.reader) {
      const info = values ? statement.run(...(values as never[])) : statement.run();
      return { columns: [], rows: [], rowCount: info.changes, executionTimeMs: performance.now() - started };
    }
    const all = (values ? statement.all(...(values as never[])) : statement.all()) as Record<string, unknown>[];
    const rows = typeof maxRows === 'number' && maxRows >= 0 ? all.slice(0, maxRows) : all;
    const names = statement.columns().map((column) => column.name);
    const columns = names.map((name) => {
      const sample = rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name];
      const type = typeof sample === 'number' ? 'number' : typeof sample === 'string' ? 'string' : sample === undefined ? 'unknown' : 'unknown';
      return { name, type: type as 'number' | 'string' | 'unknown', driverType: 'sqlite' };
    });
    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - started,
      ...(rows.length < all.length ? { truncated: true } : {}),
    };
  };

  const connector: DatabaseConnector = {
    driverName: 'sqlite',
    connect: async () => {},
    execute: async (sql, params, options) => runSql(sql, params, options?.maxRows),
    disconnect: async () => {},
    ping: async () => true,
    listTables: async (): Promise<TableInfo[]> => Object.keys(seed.tables).map((relation) => {
      const [schema, name] = relation.includes('.') ? relation.split('.') as [string, string] : ['main', relation];
      return { schema, name, type: 'BASE TABLE' };
    }),
    listColumns: async (schema?: string, table?: string): Promise<ColumnInfo[]> => Object.entries(seed.tables)
      .filter(([relation]) => {
        const [relSchema, relTable] = relation.includes('.') ? relation.split('.') as [string, string] : ['main', relation];
        return (!schema || relSchema === schema) && (!table || relTable === table);
      })
      .flatMap(([relation, definition]) => {
        const [relSchema, relTable] = relation.includes('.') ? relation.split('.') as [string, string] : ['main', relation];
        return definition.columns.map((column, index) => ({
          schema: relSchema, table: relTable, name: column.name,
          dataType: INFORMATION_SCHEMA_TYPE[column.type] ?? 'VARCHAR', ordinalPosition: index + 1,
        }));
      }),
  };

  const executor = {
    db,
    log,
    query: (sql: string) => runSql(sql).rows,
    getConnector: async (_config: ConnectionConfig) => connector,
    executeQuery: async (sql: string, params: SQLParamSpec[], variables: Record<string, unknown>, config: ConnectionConfig) => {
      log.push(sql);
      const values = buildParamValues(params ?? [], variables ?? {});
      return runSql(normalizeSQLPlaceholders(sql, config?.driver ?? 'sqlite'), values.length ? values : undefined);
    },
    executePositional: async (sql: string, values: unknown[], config: ConnectionConfig, options?: { maxRows?: number }) => {
      log.push(sql);
      return runSql(normalizeSQLPlaceholders(sql, config?.driver ?? 'sqlite'), values?.length ? values : undefined, options?.maxRows);
    },
    disconnect: async () => { db.close(); },
  };
  return executor as unknown as SeededSqliteExecutor;
}
