import type { DatabaseConnector, ConnectionConfig, DriverName, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, deadlineSeconds, isReadOnlyQuery, loadDependency, plainRow, redactSecrets, tlsMode, tlsOptions, withDeadline, type TlsMode } from './shared.js';
import { iamSignIn, isAwsAuth } from './aws.js';

/** The part of `pg` this connector uses; the package is loaded at connect time. */
interface PgField { name: string; dataTypeID: number }
interface PgQueryResult { rows: Row[]; fields?: PgField[]; rowCount: number | null }
interface PgTypes { getTypeParser(oid: number, format?: string): (value: string) => unknown }
interface PgQueryConfig { text: string; values?: unknown[]; types?: PgTypes }
interface PgPoolClient {
  processID?: number;
  query(config: PgQueryConfig | string, values?: unknown[]): Promise<PgQueryResult>;
  release(destroy?: boolean | Error): void;
}
interface PgPool {
  connect(): Promise<PgPoolClient>;
  query(config: PgQueryConfig | string, values?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
  types: PgTypes;
}

// Type OIDs whose default `pg` parsing loses meaning for analytics: bigint and
// numeric arrive as text, and DATE / TIMESTAMP are turned into local-time JS
// Dates, which shifts a calendar day across time zones.
const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const TIMESTAMP = 1114;

export class PostgreSQLConnector implements DatabaseConnector {
  readonly driverName: DriverName = 'postgresql';
  protected engine = 'PostgreSQL';
  private pool: PgPool | null = null;
  private types: PgTypes | undefined;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const pg = await loadDependency<PgModule>('pg', config);
    this.config = config;
    this.types = analyticsTypes(pg.types);
    const iam = isAwsAuth(config.authMethod) ? await iamSignIn(config, this.driverName === 'redshift' ? 'redshift' : 'postgresql') : null;
    // IAM tokens are only accepted over TLS.
    const ssl = tlsOptions(config, tlsMode(config, iam ? 'require' : this.defaultTls()));
    const poolConfig: Record<string, unknown> = config.connectionString
      ? { connectionString: config.connectionString, ...(ssl !== undefined ? { ssl } : {}) }
      : {
          host: config.host ?? 'localhost',
          port: config.port ?? this.defaultPort(),
          database: config.database,
          user: iam ? iam.user : config.username,
          // `pg` calls a password function for every new connection, so a
          // short-lived IAM token is fetched fresh rather than reused.
          password: iam ? iam.password : config.password,
          ...(ssl !== undefined ? { ssl } : {}),
        };
    poolConfig.max = 8;
    poolConfig.idleTimeoutMillis = 30_000;
    poolConfig.connectionTimeoutMillis = Math.max(1_000, (config.timeout ?? 20) * 1000);
    poolConfig.application_name = config.application ?? 'dql';
    this.pool = new pg.Pool(poolConfig);
    // An idle client dropped by the server must not crash the process.
    this.pool.on('error', () => undefined);
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new Error(`${this.engine} connection failed: ${redactSecrets(error instanceof Error ? error.message : String(error), config)}`);
    });
    client.release();
  }

  protected defaultPort(): number {
    return 5432;
  }

  protected defaultTls(): TlsMode | undefined {
    return undefined;
  }

  protected cursorKind(): string {
    return 'NO SCROLL CURSOR';
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.pool) throw new Error(`${this.engine} connector not connected. Call connect() first.`);
    const pool = this.pool;
    const startedAt = performance.now();
    const client = await pool.connect();
    let broken = false;
    const cancel = () => {
      // A second session asks the server to stop the first one's statement.
      const pid = client.processID;
      broken = true;
      if (pid) return pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
      return undefined;
    };
    try {
      return await withDeadline(this.engine, options, async () => {
        const values = params && params.length > 0 ? params : undefined;
        const timeout = deadlineSeconds(options);
        const bounded = options.maxRows !== undefined && isReadOnlyQuery(sql);
        if (!bounded) {
          if (timeout !== undefined) await client.query(`SET statement_timeout = ${timeout * 1000}`);
          try {
            const result = await client.query({ text: sql, values, types: this.types });
            return this.toResult(result, startedAt, options);
          } finally {
            if (timeout !== undefined) await client.query('SET statement_timeout = 0').catch(() => { broken = true; });
          }
        }
        // A read-only statement is fetched through a cursor inside a read-only
        // transaction, so the server stops after the rows the caller can take.
        await client.query('BEGIN READ ONLY');
        try {
          if (timeout !== undefined) await client.query(`SET LOCAL statement_timeout = ${timeout * 1000}`);
          await client.query({ text: `DECLARE dql_cursor ${this.cursorKind()} FOR ${stripTerminator(sql)}`, values, types: this.types });
          const result = await client.query({ text: `FETCH FORWARD ${options.maxRows! + 1} FROM dql_cursor`, types: this.types });
          return this.toResult(result, startedAt, options);
        } finally {
          await client.query('ROLLBACK').catch(() => { broken = true; });
        }
      }, cancel);
    } catch (error) {
      throw new Error(`${this.engine} query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    } finally {
      client.release(broken || undefined);
    }
  }

  private toResult(result: PgQueryResult, startedAt: number, options: QueryExecutionOptions): QueryResult {
    const columns: ColumnMeta[] = (result.fields ?? []).map((field) => ({
      name: field.name,
      type: mapPgType(field.dataTypeID),
      driverType: String(field.dataTypeID),
    }));
    if (!result.fields || result.fields.length === 0) {
      return { columns: [], rows: [], rowCount: result.rowCount ?? 0, executionTimeMs: performance.now() - startedAt };
    }
    return boundedResult(columns, (result.rows ?? []).map(plainRow), startedAt, options);
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
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_internal')
         AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_internal')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND table_schema = $${params.length}`;
    }
    if (table) {
      params.push(table);
      sql += ` AND table_name = $${params.length}`;
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

function analyticsTypes(base: PgTypes): PgTypes {
  return {
    getTypeParser(oid: number, format?: string) {
      if (format === 'binary') return base.getTypeParser(oid, format);
      switch (oid) {
        case INT8:
          return (value: string) => {
            const n = Number(value);
            return Number.isSafeInteger(n) ? n : value;
          };
        case NUMERIC:
          return (value: string) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : value;
          };
        case DATE:
        case TIMESTAMP:
          return (value: string) => value;
        default:
          return base.getTypeParser(oid, format);
      }
    },
  };
}

function stripTerminator(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

function mapPgType(oid: number): ColumnType {
  switch (oid) {
    case 16:
      return 'boolean';
    case 20:
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
    case 790:
    case 1700:
      return 'number';
    case 1082:
      return 'date';
    case 1114:
    case 1184:
      return 'datetime';
    case 18:
    case 19:
    case 25:
    case 1042:
    case 1043:
    case 2950:
    case 114:
    case 3802:
      return 'string';
    default:
      return 'unknown';
  }
}
