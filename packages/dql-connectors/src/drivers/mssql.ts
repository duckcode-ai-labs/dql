import type { DatabaseConnector, ConnectionConfig, DriverName, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, loadDependency, plainRow, readPem, redactSecrets, tlsMode, withDeadline } from './shared.js';

/** The part of `mssql` (tedious) this connector uses; the package is loaded at connect time. */
interface MssqlColumn { name?: string; index?: number; type?: { declaration?: string } }
interface MssqlRequest {
  stream: boolean;
  input(name: string, value: unknown): MssqlRequest;
  query(sql: string): unknown;
  cancel(): void;
  on(event: 'recordset', listener: (columns: Record<string, MssqlColumn>) => void): MssqlRequest;
  on(event: 'row', listener: (row: Row) => void): MssqlRequest;
  on(event: 'error', listener: (error: Error) => void): MssqlRequest;
  on(event: 'done', listener: (result: { rowsAffected?: number[] }) => void): MssqlRequest;
}
interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown> | string) => MssqlPool;
}

/**
 * SQL Server, Azure SQL and Microsoft Fabric over `mssql`. Each connector
 * owns its own pool: the package's global `sql.connect` would make every
 * connection in the process share the first one's server.
 */
export class MSSQLConnector implements DatabaseConnector {
  readonly driverName: DriverName = 'mssql';
  protected engine = 'SQL Server';
  private pool: MssqlPool | null = null;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const mssql = await loadDependency<MssqlModule>('mssql', config);
    this.config = config;
    const pool = config.connectionString
      ? new mssql.ConnectionPool(config.connectionString)
      : new mssql.ConnectionPool(this.poolConfig(config));
    pool.on('error', () => undefined);
    try {
      this.pool = await pool.connect();
    } catch (error) {
      throw new Error(`${this.engine} connection failed: ${redactSecrets(error instanceof Error ? error.message : String(error), config)}`);
    }
  }

  protected poolConfig(config: ConnectionConfig): Record<string, unknown> {
    // Encrypted and certificate-checked by default, as Microsoft's own
    // drivers now do; a self-signed server needs "trust server certificate".
    const mode = tlsMode(config, 'verify-full');
    const ca = readPem(config.sslRootCert);
    return {
      server: config.host ?? 'localhost',
      port: config.port ?? 1433,
      database: config.database,
      ...authentication(config),
      connectionTimeout: Math.max(1_000, (config.timeout ?? 30) * 1000),
      // The executor's deadline is the real limit; this only stops a
      // statement nobody is waiting for.
      requestTimeout: 15 * 60 * 1000,
      options: {
        encrypt: mode !== 'disable',
        trustServerCertificate: config.trustServerCertificate ?? mode === 'require',
        ...(config.tlsServername ? { serverName: config.tlsServername } : {}),
        ...(ca ? { cryptoCredentialsDetails: { ca } } : {}),
        appName: config.application ?? 'dql',
        useUTC: true,
      },
      pool: { max: 8, min: 0, idleTimeoutMillis: 30_000 },
    };
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.pool) throw new Error(`${this.engine} connector not connected. Call connect() first.`);
    const startedAt = performance.now();
    const request = this.pool.request();
    request.stream = true;
    let text = sql;
    if (params && params.length > 0) {
      params.forEach((value, index) => request.input(`p${index + 1}`, value));
      text = sql.replace(/\$(\d+)/g, (_match, num: string) => `@p${num}`);
    }
    const limit = options.maxRows;
    try {
      return await withDeadline(this.engine, options, () => new Promise<QueryResult>((resolve, reject) => {
        let columns: ColumnMeta[] = [];
        let sets = 0;
        const rows: Row[] = [];
        let cut = false;
        request.on('recordset', (described) => {
          // Only the first result set is the answer; later ones are ignored.
          sets += 1;
          if (sets > 1) return;
          columns = Object.values(described)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((column) => ({
              name: String(column.name ?? ''),
              type: mapMSSQLType(column.type?.declaration ?? ''),
              driverType: column.type?.declaration ?? 'unknown',
            }));
        });
        let settled = false;
        const finish = (rowsAffected?: number) => {
          if (settled) return;
          settled = true;
          if (columns.length === 0 && rows.length === 0) {
            resolve({ columns: [], rows: [], rowCount: rowsAffected ?? 0, executionTimeMs: performance.now() - startedAt });
            return;
          }
          const dates = columns.filter((column) => column.type === 'date').map((column) => column.name);
          const plain = rows.map((row) => {
            const out = plainRow(row);
            // A DATE arrives as UTC midnight; the answer is the calendar day.
            for (const name of dates) if (typeof out[name] === 'string') out[name] = (out[name] as string).slice(0, 10);
            return out;
          });
          resolve(boundedResult(columns, plain, startedAt, options, cut ? { truncated: true } : {}));
        };
        request.on('row', (row) => {
          if (cut || sets > 1) return;
          rows.push(row);
          if (limit !== undefined && rows.length > limit) {
            // One row past the limit proves the cut; the server stops here.
            cut = true;
            request.cancel();
            finish();
          }
        });
        request.on('error', (error) => {
          if (cut || settled) return;
          settled = true;
          reject(error);
        });
        request.on('done', (result) => finish(result?.rowsAffected?.[0]));
        request.query(text);
      }), () => request.cancel());
    } catch (error) {
      throw new Error(`${this.engine} query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.close();
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.execute('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'sys')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
       COLUMN_NAME AS column_name, DATA_TYPE AS data_type, ORDINAL_POSITION AS ordinal_position
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'sys')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND TABLE_SCHEMA = $${params.length}`;
    }
    if (table) {
      params.push(table);
      sql += ` AND TABLE_NAME = $${params.length}`;
    }
    sql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
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

/**
 * SQL login, or Microsoft Entra ID: the default credential chain (az login,
 * managed identity, environment) or a service principal secret.
 */
function authentication(config: ConnectionConfig): Record<string, unknown> {
  switch (config.authMethod) {
    case 'azure_default':
      return { authentication: { type: 'azure-active-directory-default', options: config.oauthClientId ? { clientId: config.oauthClientId } : {} } };
    case 'azure_service_principal':
      return {
        authentication: {
          type: 'azure-active-directory-service-principal-secret',
          options: { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret, tenantId: config.tenantId },
        },
      };
    case 'azure_password':
      return {
        authentication: {
          type: 'azure-active-directory-password',
          options: { userName: config.username, password: config.password, clientId: config.oauthClientId, tenantId: config.tenantId },
        },
      };
    default:
      return { user: config.username, password: config.password };
  }
}

function mapMSSQLType(declaration: string): ColumnType {
  const lower = (declaration ?? '').toLowerCase();
  if (lower === 'bit') return 'boolean';
  if (['int', 'bigint', 'smallint', 'tinyint', 'float', 'real', 'decimal', 'numeric', 'money', 'smallmoney'].some((t) => lower.includes(t))) {
    return 'number';
  }
  if (lower === 'date') return 'date';
  if (['datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'time'].some((t) => lower.includes(t))) return 'datetime';
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'xml', 'uniqueidentifier'].some((t) => lower.includes(t))) {
    return 'string';
  }
  return 'unknown';
}
