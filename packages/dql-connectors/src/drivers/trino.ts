import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, inlineParameters, redactSecrets, sqlLiteral, withDeadline } from './shared.js';

interface TrinoPayload {
  id?: string;
  data?: unknown[][];
  columns?: Array<{ name: string; type: string }>;
  nextUri?: string;
  error?: { message?: string; errorName?: string; errorCode?: number };
}

const RETRY_STATUSES = new Set([502, 503, 504]);

/**
 * Trino and Starburst over the client REST protocol (`/v1/statement`). No
 * client library: the protocol is plain HTTP, so nothing extra is installed.
 */
export class TrinoConnector implements DatabaseConnector {
  readonly driverName = 'trino';
  private endpoint: string | null = null;
  private headers: Record<string, string> = {};
  private catalog: string | undefined;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    const https = config.sslMode ? config.sslMode !== 'disable' : config.ssl === true;
    const host = (config.host ?? 'localhost').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const port = config.port ?? (https ? 443 : 8080);
    this.endpoint = `${https ? 'https' : 'http'}://${host}:${port}`;
    this.catalog = config.catalog ?? config.database;
    this.headers = {
      'X-Trino-User': config.username ?? 'dql',
      'X-Trino-Source': config.application ?? 'dql',
      'Content-Type': 'text/plain; charset=utf-8',
      ...(this.catalog ? { 'X-Trino-Catalog': this.catalog } : {}),
      ...(config.schema ? { 'X-Trino-Schema': config.schema } : {}),
    };
    if (config.authMethod === 'token' && config.token) {
      this.headers.Authorization = `Bearer ${config.token}`;
    } else if (config.username && config.password) {
      if (!https) throw new Error('Trino accepts a password only over HTTPS. Turn on SSL for this connection.');
      this.headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    }
    await this.execute('SELECT 1', undefined, { deadlineMs: Math.max(1_000, (config.timeout ?? 30) * 1000) });
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.endpoint) throw new Error('Trino connector not connected. Call connect() first.');
    const endpoint = this.endpoint;
    const startedAt = performance.now();
    const controller = new AbortController();
    let pendingUri: string | undefined;
    const cancel = () => {
      controller.abort();
      // DELETE on the next page asks the coordinator to stop the query.
      if (pendingUri) return fetch(pendingUri, { method: 'DELETE', headers: this.headers }).catch(() => undefined);
      return undefined;
    };
    const text = inlineParameters(sql.trim().replace(/;\s*$/, ''), params);
    try {
      return await withDeadline('Trino', options, async () => {
        let payload = await this.request(`${endpoint}/v1/statement`, { method: 'POST', body: text }, controller.signal);
        const rows: Row[] = [];
        let columns: ColumnMeta[] = [];
        let truncated = false;
        while (true) {
          if (payload.error) throw new Error(payload.error.message ?? payload.error.errorName ?? 'query failed');
          if (payload.columns && columns.length === 0) {
            columns = payload.columns.map((column) => ({ name: column.name, type: mapTrinoType(column.type), driverType: column.type }));
          }
          for (const values of payload.data ?? []) {
            rows.push(Object.fromEntries(columns.map((column, index) => [column.name, plainTrinoValue(values[index], column.driverType)])));
          }
          pendingUri = payload.nextUri;
          if (!payload.nextUri) break;
          if (options.maxRows !== undefined && rows.length > options.maxRows) {
            // Enough rows to answer and prove the cut: stop the query.
            truncated = true;
            await fetch(payload.nextUri, { method: 'DELETE', headers: this.headers }).catch(() => undefined);
            break;
          }
          payload = await this.request(payload.nextUri, { method: 'GET' }, controller.signal);
        }
        return boundedResult(columns, rows, startedAt, options, { ...(payload.id ? { queryId: payload.id } : {}), ...(truncated ? { truncated } : {}) });
      }, cancel);
    } catch (error) {
      throw new Error(`Trino query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    }
  }

  private async request(url: string, init: { method: string; body?: string }, signal: AbortSignal): Promise<TrinoPayload> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { ...init, headers: this.headers, signal });
      if (RETRY_STATUSES.has(response.status) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        continue;
      }
      if (response.status === 401) throw new Error('Trino rejected the credentials (401).');
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return await response.json() as TrinoPayload;
    }
  }

  async disconnect(): Promise<void> {
    this.endpoint = null;
    this.headers = {};
  }

  async ping(): Promise<boolean> {
    try {
      await this.execute('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  private informationSchema(): string {
    if (!this.catalog) throw new Error('Choose a Trino catalog for this connection to list its tables.');
    return `${quoteIdentifier(this.catalog)}.information_schema`;
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type
       FROM ${this.informationSchema()}.tables
       WHERE table_schema <> 'information_schema'
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
       FROM ${this.informationSchema()}.columns
       WHERE table_schema <> 'information_schema'`;
    if (schema) sql += ` AND table_schema = ${sqlLiteral(schema)}`;
    if (table) sql += ` AND table_name = ${sqlLiteral(table)}`;
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql);
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      table: String(row['table_name'] ?? ''),
      name: String(row['column_name'] ?? ''),
      dataType: String(row['data_type'] ?? ''),
      ordinalPosition: Number(row['ordinal_position'] ?? 0),
    }));
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** BIGINT and DECIMAL arrive as JSON numbers or text; keep them numeric when exact. */
function plainTrinoValue(value: unknown, type: string): unknown {
  if (typeof value === 'string' && /^(decimal|bigint)/i.test(type)) {
    const n = Number(value);
    return Number.isFinite(n) && (!/^bigint/i.test(type) || Number.isSafeInteger(n)) ? n : value;
  }
  return value;
}

function mapTrinoType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower === 'boolean') return 'boolean';
  if (/^(tinyint|smallint|integer|bigint|real|double|decimal)/.test(lower)) return 'number';
  if (lower === 'date') return 'date';
  if (lower.startsWith('timestamp')) return 'datetime';
  if (/^(varchar|char|uuid|json|varbinary)/.test(lower)) return 'string';
  return 'unknown';
}
