import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, Row } from '../result-types.js';
import { importConnectorDependency } from '../optional-dependency.js';

/** The part of better-sqlite3 this connector uses; the package is loaded at runtime. */
interface SQLiteStatement {
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}
interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  close(): void;
}
type SQLiteDatabaseConstructor = new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SQLiteDatabase;

let databaseCtor: SQLiteDatabaseConstructor | null = null;

async function loadDatabase(config: ConnectionConfig): Promise<SQLiteDatabaseConstructor> {
  if (!databaseCtor) {
    const loaded = await importConnectorDependency('better-sqlite3', config) as { default?: SQLiteDatabaseConstructor };
    databaseCtor = (loaded.default ?? loaded) as SQLiteDatabaseConstructor;
  }
  return databaseCtor;
}

export class SQLiteConnector implements DatabaseConnector {
  readonly driverName = 'sqlite';
  private db: SQLiteDatabase | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const filepath = config.filepath ?? config.database ?? ':memory:';
    const Database = await loadDatabase(config);
    // A warehouse file is read, never changed: opening it read-only also
    // leaves its journal mode and sidecar files alone.
    this.db = filepath === ':memory:' ? new Database(filepath) : new Database(filepath, { readonly: true, fileMustExist: true });
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.db) {
      throw new Error('SQLite connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const stmt = this.db.prepare(sql);

    if (stmt.reader) {
      const rows = (params ? stmt.all(...params) : stmt.all()) as Row[];
      const executionTimeMs = performance.now() - startTime;

      const columns: ColumnMeta[] =
        rows.length > 0
          ? Object.keys(rows[0]).map((name) => ({
              name,
              type: inferType(rows[0][name]),
              driverType: 'unknown',
            }))
          : [];

      return {
        columns,
        rows,
        rowCount: rows.length,
        executionTimeMs,
      };
    }

    const result = params ? stmt.run(...params) : stmt.run();
    const executionTimeMs = performance.now() - startTime;

    return {
      columns: [],
      rows: [],
      rowCount: result.changes,
      executionTimeMs,
    };
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return result.rows.map((row) => ({
      schema: 'main',
      name: String(row['name'] ?? ''),
      type: String(row['type'] ?? '') === 'table' ? 'BASE TABLE' : 'VIEW',
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const tables = await this.listTables();
    const filtered = table ? tables.filter((t) => t.name === table) : tables;
    const columns: ColumnInfo[] = [];
    for (const t of filtered) {
      // The table's name is a bind value of the table-valued pragma, never part of the statement's text.
      const result = await this.execute('SELECT name, type, cid FROM pragma_table_info(?)', [t.name]);
      for (const row of result.rows) {
        columns.push({
          schema: 'main',
          table: t.name,
          name: String(row['name'] ?? ''),
          dataType: String(row['type'] ?? 'TEXT'),
          ordinalPosition: Number(row['cid'] ?? 0) + 1,
        });
      }
    }
    return columns;
  }
}

function inferType(value: unknown): 'string' | 'number' | 'boolean' | 'null' | 'unknown' {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}
