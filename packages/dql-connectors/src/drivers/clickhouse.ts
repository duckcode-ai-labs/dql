import { randomUUID } from 'node:crypto';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, deadlineSeconds, inlineParameters, isReadOnlyQuery, redactSecrets, sqlLiteral, withDeadline } from './shared.js';

interface ClickHousePayload {
  meta?: Array<{ name: string; type: string }>;
  data?: Row[];
  rows?: number;
  rows_before_limit_at_least?: number;
}

/**
 * ClickHouse and ClickHouse Cloud over the HTTP interface. No client
 * library: the server's own settings bound the rows and the run time.
 */
export class ClickHouseConnector implements DatabaseConnector {
  readonly driverName = 'clickhouse';
  private endpoint: string | null = null;
  private headers: Record<string, string> = {};
  private database: string | undefined;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    const https = config.sslMode ? config.sslMode !== 'disable' : config.ssl === true;
    const host = (config.host ?? 'localhost').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const port = config.port ?? (https ? 8443 : 8123);
    this.endpoint = `${https ? 'https' : 'http'}://${host}:${port}/`;
    this.database = config.database;
    this.headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-ClickHouse-User': config.username ?? 'default',
      ...(config.password ? { 'X-ClickHouse-Key': config.password } : {}),
    };
    await this.execute('SELECT 1', undefined, { deadlineMs: Math.max(1_000, (config.timeout ?? 30) * 1000) });
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.endpoint) throw new Error('ClickHouse connector not connected. Call connect() first.');
    const startedAt = performance.now();
    const queryId = `dql-${randomUUID()}`;
    const text = inlineParameters(sql.trim().replace(/;\s*$/, ''), params, 'backslash');
    const url = new URL(this.endpoint);
    url.searchParams.set('query_id', queryId);
    url.searchParams.set('default_format', 'JSON');
    // 64-bit integers arrive quoted (a JSON number cannot hold them all) and
    // become numbers below only when exact.
    url.searchParams.set('output_format_json_quote_64bit_integers', '1');
    url.searchParams.set('output_format_json_quote_decimals', '0');
    if (this.database) url.searchParams.set('database', this.database);
    const seconds = deadlineSeconds(options);
    if (seconds !== undefined) url.searchParams.set('max_execution_time', String(seconds));
    const bounded = options.maxRows !== undefined && isReadOnlyQuery(text);
    if (bounded) {
      // The server stops after one row more than the caller can take.
      url.searchParams.set('max_result_rows', String(options.maxRows! + 1));
      url.searchParams.set('result_overflow_mode', 'break');
    }
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      return this.kill(queryId);
    };
    try {
      return await withDeadline('ClickHouse', options, async () => {
        const response = await fetch(url, { method: 'POST', headers: this.headers, body: text, signal: controller.signal });
        const body = await response.text();
        if (!response.ok) throw new Error(body.trim().slice(0, 1_000) || `HTTP ${response.status}`);
        if (!body.trim()) return { columns: [], rows: [], rowCount: 0, executionTimeMs: performance.now() - startedAt, queryId };
        const payload = JSON.parse(body) as ClickHousePayload;
        const columns: ColumnMeta[] = (payload.meta ?? []).map((column) => ({
          name: column.name,
          type: mapColumnType(column.type),
          driverType: column.type,
        }));
        const wide = (payload.meta ?? []).filter((column) => /^(Nullable\()?U?Int(64|128|256)/.test(column.type)).map((column) => column.name);
        const rows = wide.length === 0 ? payload.data ?? [] : (payload.data ?? []).map((row) => {
          const out: Row = { ...row };
          for (const name of wide) {
            const value = out[name];
            if (typeof value === 'string' && Number.isSafeInteger(Number(value))) out[name] = Number(value);
          }
          return out;
        });
        return boundedResult(columns, rows, startedAt, options, { queryId });
      }, cancel);
    } catch (error) {
      throw new Error(`ClickHouse query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    }
  }

  private async kill(queryId: string): Promise<void> {
    if (!this.endpoint) return;
    const url = new URL(this.endpoint);
    await fetch(url, { method: 'POST', headers: this.headers, body: `KILL QUERY WHERE query_id = ${sqlLiteral(queryId, 'backslash')} ASYNC` }).catch(() => undefined);
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

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT database, name, engine FROM system.tables
       WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA') AND NOT is_temporary
       ORDER BY database, name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['database'] ?? ''),
      name: String(row['name'] ?? ''),
      type: /View$/.test(String(row['engine'] ?? '')) ? 'VIEW' : 'BASE TABLE',
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT database, table, name, type, position FROM system.columns
       WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')`;
    if (schema) sql += ` AND database = ${sqlLiteral(schema, 'backslash')}`;
    if (table) sql += ` AND table = ${sqlLiteral(table, 'backslash')}`;
    sql += ` ORDER BY database, table, position`;
    const result = await this.execute(sql);
    return result.rows.map((row) => ({
      schema: String(row['database'] ?? ''),
      table: String(row['table'] ?? ''),
      name: String(row['name'] ?? ''),
      dataType: String(row['type'] ?? ''),
      ordinalPosition: Number(row['position'] ?? 0),
    }));
  }
}

function mapColumnType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase().replace(/^(nullable|lowcardinality)\((.*)\)$/, '$2').replace(/^(nullable)\((.*)\)$/, '$2');
  if (lower === 'bool' || lower === 'boolean') return 'boolean';
  if (/^(u?int\d+|float\d+|decimal)/.test(lower)) return 'number';
  if (/^date(32)?$/.test(lower)) return 'date';
  if (lower.startsWith('datetime')) return 'datetime';
  if (/^(string|fixedstring|uuid|enum|ipv[46])/.test(lower)) return 'string';
  return 'unknown';
}
