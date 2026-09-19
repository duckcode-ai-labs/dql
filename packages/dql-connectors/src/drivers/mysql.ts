import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, isReadOnlyQuery, loadDependency, plainRow, redactSecrets, tlsMode, tlsOptions, withDeadline } from './shared.js';

/** The part of `mysql2/promise` this connector uses; the package is loaded at connect time. */
interface MySqlField { name: string; columnType?: number; type?: number }
interface MySqlConnection {
  threadId: number | null;
  query(options: { sql: string; values?: unknown[]; rowsAsArray?: boolean }): Promise<[unknown, MySqlField[] | undefined]>;
  release(): void;
  destroy(): void;
}
interface MySqlPool {
  getConnection(): Promise<MySqlConnection>;
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}
interface MySqlModule {
  createPool(config: Record<string, unknown>): MySqlPool;
}

const DUPLICATE_COLUMN = 1060;

/** MySQL and MariaDB over `mysql2`. */
export class MySQLConnector implements DatabaseConnector {
  readonly driverName = 'mysql';
  private pool: MySqlPool | null = null;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const mysql = await loadDependency<MySqlModule>('mysql2/promise', config);
    this.config = config;
    const ssl = tlsOptions(config, tlsMode(config, undefined)) || undefined;
    const poolConfig: Record<string, unknown> = {
      ...(config.connectionString
        ? { uri: config.connectionString }
        : {
            host: config.host ?? 'localhost',
            port: config.port ?? 3306,
            database: config.database,
            user: config.username,
            password: config.password,
          }),
      ...(ssl ? { ssl } : {}),
      waitForConnections: true,
      connectionLimit: 8,
      queueLimit: 0,
      connectTimeout: Math.max(1_000, (config.timeout ?? 20) * 1000),
      // Analytics reads numbers as numbers and calendar days as the text the
      // server stored: a DATE turned into a local JS Date shifts across zones.
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: ['DATE'],
      timezone: 'Z',
    };
    this.pool = mysql.createPool(poolConfig);
    const connection = await this.pool.getConnection().catch((error: unknown) => {
      throw new Error(`MySQL connection failed: ${redactSecrets(error instanceof Error ? error.message : String(error), config)}`);
    });
    connection.release();
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.pool) throw new Error('MySQL connector not connected. Call connect() first.');
    const pool = this.pool;
    const startedAt = performance.now();
    const connection = await pool.getConnection();
    let broken = false;
    const cancel = () => {
      broken = true;
      const threadId = connection.threadId;
      if (threadId) return pool.query(`KILL QUERY ${Number(threadId)}`).catch(() => undefined);
      return undefined;
    };
    const values = params && params.length > 0 ? params : undefined;
    try {
      return await withDeadline('MySQL', options, async () => {
        if (options.maxRows !== undefined && isReadOnlyQuery(sql)) {
          // The server stops after one row more than the caller can take, so
          // a cut is known. A statement whose columns repeat a name cannot be
          // a derived table; it runs unwrapped and is cut here instead.
          try {
            const bounded = `SELECT * FROM (${stripTerminator(sql)}) AS dql_bounded LIMIT ${options.maxRows + 1}`;
            return this.toResult(await connection.query({ sql: bounded, values }), startedAt, options);
          } catch (error) {
            if ((error as { errno?: number }).errno !== DUPLICATE_COLUMN) throw error;
          }
        }
        return this.toResult(await connection.query({ sql, values }), startedAt, options);
      }, cancel);
    } catch (error) {
      throw new Error(`MySQL query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    } finally {
      if (broken) connection.destroy();
      else connection.release();
    }
  }

  private toResult([rows, fields]: [unknown, MySqlField[] | undefined], startedAt: number, options: QueryExecutionOptions): QueryResult {
    if (!Array.isArray(rows)) {
      return { columns: [], rows: [], rowCount: Number((rows as { affectedRows?: number })?.affectedRows ?? 0), executionTimeMs: performance.now() - startedAt };
    }
    const columns: ColumnMeta[] = (fields ?? []).map((field) => {
      const typeId = field.columnType ?? field.type ?? -1;
      return { name: field.name, type: mapMySQLType(typeId), driverType: String(typeId) };
    });
    return boundedResult(columns, (rows as Row[]).map(plainRow), startedAt, options);
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.end();
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT table_schema AS table_schema, table_name AS table_name, table_type AS table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT table_schema AS table_schema, table_name AS table_name, column_name AS column_name,
       data_type AS data_type, ordinal_position AS ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND table_schema = ?`;
    }
    if (table) {
      params.push(table);
      sql += ` AND table_name = ?`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql, params);
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      table: String(row['table_name'] ?? ''),
      name: String(row['column_name'] ?? ''),
      dataType: String(row['data_type'] ?? ''),
      ordinalPosition: Number(row['ordinal_position'] ?? 0),
    }));
  }
}

function stripTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

// See https://dev.mysql.com/doc/dev/mysql-server/latest/field__types_8h.html
function mapMySQLType(typeId: number): ColumnType {
  switch (typeId) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 8:
    case 9:
    case 13:
    case 246:
      return 'number';
    case 10:
    case 14:
      return 'date';
    case 7:
    case 12:
      return 'datetime';
    case 16:
      return 'boolean';
    case 15:
    case 245:
    case 247:
    case 252:
    case 253:
    case 254:
      return 'string';
    default:
      return 'unknown';
  }
}
