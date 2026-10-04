import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';

interface DatabricksStatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  manifest?: {
    schema?: { columns?: Array<{ name: string; type_text?: string; type_name?: string }> };
    chunks?: Array<{ chunk_index?: number; row_count?: number; row_offset?: number }>;
    total_chunk_count?: number;
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: DatabricksResultChunk;
  data_array?: unknown[][];
  next_chunk_index?: number;
  next_chunk_internal_link?: string;
  external_links?: DatabricksExternalLink[];
}

interface DatabricksResultChunk {
  data_array?: unknown[][];
  next_chunk_index?: number;
  next_chunk_internal_link?: string;
  external_links?: DatabricksExternalLink[];
}

interface DatabricksExternalLink {
  next_chunk_index?: number;
  next_chunk_internal_link?: string;
  external_link?: string;
}

export class DatabricksConnector implements DatabaseConnector {
  readonly driverName = 'databricks';
  private baseUrl: string | null = null;
  private token: string | null = null;
  private warehouseId: string | null = null;
  private catalog?: string;
  private schema?: string;
  private waitTimeout?: string;
  private byteLimit?: number;

  async connect(config: ConnectionConfig): Promise<void> {
    if (!config.host) {
      throw new Error('Databricks connection requires a host.');
    }
    if (!(config.token ?? config.password)) {
      throw new Error('Databricks connection requires a token.');
    }
    if (!(config.warehouse ?? config.httpPath)) {
      throw new Error('Databricks connection requires a warehouse ID or SQL warehouse HTTP path.');
    }

    this.baseUrl = normalizeDatabricksHost(config.host);
    this.token = config.token ?? config.password ?? null;
    this.warehouseId = resolveDatabricksWarehouseId(config.warehouse ?? config.httpPath) ?? null;
    this.catalog = config.catalog ?? config.database;
    this.schema = config.schema;
    this.waitTimeout = config.waitTimeout ?? '50s';
    this.byteLimit = config.byteLimit;

    if (!this.warehouseId) {
      throw new Error('Databricks connection requires a SQL warehouse ID. Paste the Warehouse ID or an HTTP path like /sql/1.0/warehouses/<id>.');
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.baseUrl || !this.token || !this.warehouseId) {
      throw new Error('Databricks connector not connected. Call connect() first.');
    }
    // `?` placeholders become the Statement Execution API's named parameters: values never enter the text.
    const bound = params && params.length > 0 ? databricksNamedParameters(sql, params) : { statement: sql, parameters: undefined };

    const startTime = performance.now();
    const response = await fetch(`${this.baseUrl}/api/2.0/sql/statements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        statement: bound.statement,
        ...(bound.parameters ? { parameters: bound.parameters } : {}),
        warehouse_id: this.warehouseId,
        catalog: this.catalog,
        schema: this.schema,
        format: 'JSON_ARRAY',
        disposition: 'INLINE',
        wait_timeout: this.waitTimeout,
        byte_limit: this.byteLimit,
      }),
    });

    if (!response.ok) {
      throw new Error(`Databricks query failed: ${await response.text()}`);
    }

    let payload = await response.json() as DatabricksStatementResponse;
    while (payload.status?.state === 'PENDING' || payload.status?.state === 'RUNNING') {
      await delay(500);
      const poll = await fetch(`${this.baseUrl}/api/2.0/sql/statements/${payload.statement_id}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!poll.ok) {
        throw new Error(`Databricks polling failed: ${await poll.text()}`);
      }
      payload = await poll.json() as DatabricksStatementResponse;
    }

    if (payload.status?.error?.message) {
      throw new Error(`Databricks query failed: ${payload.status.error.message}`);
    }
    if (payload.status?.state && payload.status.state !== 'SUCCEEDED') {
      throw new Error(`Databricks query did not complete. Final state: ${payload.status.state}.`);
    }

    const columns: ColumnMeta[] = (payload.manifest?.schema?.columns ?? []).map((column) => ({
      name: column.name,
      type: mapWarehouseType(column.type_text ?? column.type_name ?? ''),
      driverType: column.type_text ?? column.type_name ?? '',
    }));
    const dataArray = await this.collectRowsFromChunks(payload);
    const rows = dataArray.map((row) => Object.fromEntries(columns.map((column, index) => [column.name, row[index]])) as Row);

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - startTime,
    };
  }

  async disconnect(): Promise<void> {
    this.baseUrl = null;
    this.token = null;
    this.warehouseId = null;
    this.waitTimeout = undefined;
    this.byteLimit = undefined;
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
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    // Names travel as named parameters, never inside the statement's text (Spark reads backslashes in strings).
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema')`;
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

  private async collectRowsFromChunks(payload: DatabricksStatementResponse): Promise<unknown[][]> {
    const rows = [...extractDataArray(payload)];
    let nextChunk = extractNextChunkLink(payload);
    const seen = new Set<string>();

    while (nextChunk) {
      if (seen.has(nextChunk)) {
        throw new Error(`Databricks returned a repeated result chunk link: ${nextChunk}`);
      }
      seen.add(nextChunk);

      const chunk = await this.fetchChunk(nextChunk);
      rows.push(...extractDataArray(chunk));
      nextChunk = extractNextChunkLink(chunk);
    }

    if (rows.length === 0 && hasExternalLinks(payload)) {
      throw new Error(
        'Databricks returned external result links instead of inline JSON rows. Re-run the query with a LIMIT or lower byte limit before adding it to DQL.',
      );
    }

    return rows;
  }

  private async fetchChunk(internalLink: string): Promise<DatabricksStatementResponse> {
    if (!this.baseUrl || !this.token) {
      throw new Error('Databricks connector not connected. Call connect() first.');
    }

    const url = internalLink.startsWith('http')
      ? internalLink
      : `${this.baseUrl}${internalLink.startsWith('/') ? internalLink : `/${internalLink}`}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`Databricks chunk fetch failed: ${await response.text()}`);
    }
    return await response.json() as DatabricksStatementResponse;
  }
}

export function normalizeDatabricksHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return withProtocol.replace(/\/+$/, '');
  }
}

export function resolveDatabricksWarehouseId(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const path = /^https?:\/\//i.test(raw)
    ? safeUrlPath(raw)
    : raw;
  const match = path.match(/\/sql\/1\.0\/warehouses\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : raw;
}

function safeUrlPath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function extractDataArray(payload: DatabricksStatementResponse): unknown[][] {
  return payload.result?.data_array ?? payload.data_array ?? [];
}

function extractNextChunkLink(payload: DatabricksStatementResponse): string | undefined {
  return payload.result?.next_chunk_internal_link
    ?? payload.next_chunk_internal_link
    ?? payload.result?.external_links?.[0]?.next_chunk_internal_link
    ?? payload.external_links?.[0]?.next_chunk_internal_link;
}

function hasExternalLinks(payload: DatabricksStatementResponse): boolean {
  return Boolean(payload.result?.external_links?.length || payload.external_links?.length);
}

function mapWarehouseType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower.includes('int') || lower.includes('decimal') || lower.includes('double') || lower.includes('float')) return 'number';
  if (lower === 'date') return 'date';
  if (lower.includes('timestamp')) return 'datetime';
  if (lower === 'boolean') return 'boolean';
  if (lower.includes('string') || lower.includes('char')) return 'string';
  return 'unknown';
}

/** A named parameter of the Databricks SQL Statement Execution API (`:name` in the statement). */
export interface DatabricksParameter {
  name: string;
  value?: string;
  type?: string;
}

/**
 * A statement with `?` placeholders as the Statement Execution API takes it: each placeholder outside strings,
 * quoted names and comments becomes `:dql_pN`, and its value goes in `parameters` (typed; null leaves `value` out).
 */
export function databricksNamedParameters(sql: string, params: unknown[]): { statement: string; parameters: DatabricksParameter[] } {
  let statement = '';
  let used = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < sql.length && sql[end] !== char) end += char !== '`' && sql[end] === '\\' ? 2 : 1;
      statement += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end < 0 ? sql.length : end;
      statement += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end < 0 ? sql.length : end + 2;
      statement += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '?') {
      used += 1;
      statement += `:dql_p${used}`;
      index += 1;
      continue;
    }
    statement += char;
    index += 1;
  }
  if (used !== params.length) throw new Error(`The statement has ${used} placeholder${used === 1 ? '' : 's'} for ${params.length} value${params.length === 1 ? '' : 's'}.`);
  const parameters = params.map((value, position): DatabricksParameter => {
    const name = `dql_p${position + 1}`;
    if (value === null || value === undefined) return { name };
    if (typeof value === 'boolean') return { name, value: value ? 'true' : 'false', type: 'BOOLEAN' };
    if (typeof value === 'bigint') return { name, value: value.toString(), type: 'BIGINT' };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`A parameter value of ${value} cannot be sent to Databricks.`);
      return { name, value: String(value), type: Number.isSafeInteger(value) ? 'BIGINT' : 'DOUBLE' };
    }
    if (value instanceof Date) return { name, value: value.toISOString(), type: 'TIMESTAMP' };
    return { name, value: typeof value === 'string' ? value : JSON.stringify(value), type: 'STRING' };
  });
  return { statement, parameters };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
