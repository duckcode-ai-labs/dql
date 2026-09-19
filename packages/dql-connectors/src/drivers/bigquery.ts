import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, loadDependency, redactSecrets, sqlLiteral, withDeadline } from './shared.js';

/** The part of `@google-cloud/bigquery` this connector uses; the package is loaded at connect time. */
interface BigQueryField { name: string; type?: string; mode?: string }
interface BigQueryJob {
  id?: string;
  getQueryResults(options: Record<string, unknown>): Promise<[Record<string, unknown>[], unknown, { schema?: { fields?: BigQueryField[] }; totalRows?: string; pageToken?: string }?]>;
  cancel(): Promise<unknown>;
}
interface BigQueryDataset { id?: string }
interface BigQueryClient {
  projectId?: string;
  createQueryJob(options: Record<string, unknown>): Promise<[BigQueryJob, unknown]>;
  getDatasets(options?: Record<string, unknown>): Promise<[BigQueryDataset[], ...unknown[]]>;
}
interface BigQueryModule {
  BigQuery: new (options: Record<string, unknown>) => BigQueryClient;
}

/**
 * Google BigQuery. Credentials come from Application Default Credentials
 * (`gcloud auth application-default login`, a workload identity), a service
 * account key file, or pasted service account JSON.
 */
export class BigQueryConnector implements DatabaseConnector {
  readonly driverName = 'bigquery';
  private client: BigQueryClient | null = null;
  private location: string | undefined;
  private maximumBytesBilled: string | undefined;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const { BigQuery } = await loadDependency<BigQueryModule>('@google-cloud/bigquery', config);
    this.config = config;
    const options: Record<string, unknown> = {};
    if (config.projectId) options.projectId = config.projectId;
    const method = config.authMethod
      ?? (config.serviceAccountJson || config.credentials ? 'service_account_json' : config.keyFilename ? 'service_account_key_file' : 'application_default');
    if (method === 'service_account_key_file') {
      if (!config.keyFilename) throw new Error('BigQuery key-file sign-in needs the path to a service account JSON key.');
      options.keyFilename = config.keyFilename;
    } else if (method === 'service_account_json') {
      let credentials: Record<string, unknown> | undefined = config.credentials;
      if (config.serviceAccountJson) {
        try {
          credentials = JSON.parse(config.serviceAccountJson) as Record<string, unknown>;
        } catch {
          throw new Error('BigQuery service account JSON is not valid JSON.');
        }
      }
      if (!credentials) throw new Error('BigQuery service account sign-in needs the key JSON.');
      options.credentials = credentials;
      if (!options.projectId && typeof credentials.project_id === 'string') options.projectId = credentials.project_id;
    }
    if (config.host) {
      // A BigQuery-compatible endpoint (an emulator, or a private service connect address).
      options.apiEndpoint = config.host.replace(/\/+$/, '');
    }
    this.location = config.location;
    this.maximumBytesBilled = config.byteLimit ? String(Math.floor(config.byteLimit)) : undefined;
    this.client = new BigQuery(options);
    try {
      await this.execute('SELECT 1', undefined, { deadlineMs: Math.max(5_000, (config.timeout ?? 60) * 1000) });
    } catch (error) {
      this.client = null;
      throw new Error(`BigQuery connection failed: ${error instanceof Error ? error.message.replace(/^BigQuery query failed: /, '') : String(error)}`);
    }
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.client) throw new Error('BigQuery connector not connected. Call connect() first.');
    const client = this.client;
    const startedAt = performance.now();
    let job: BigQueryJob | undefined;
    let stopped = false;
    const cancel = () => {
      stopped = true;
      return job?.cancel().catch(() => undefined);
    };
    try {
      return await withDeadline('BigQuery', options, async () => {
        const request: Record<string, unknown> = { query: sql, useLegacySql: false };
        if (this.location) request.location = this.location;
        if (this.maximumBytesBilled) request.maximumBytesBilled = this.maximumBytesBilled;
        if (options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)) request.jobTimeoutMs = String(Math.max(1_000, Math.ceil(options.deadlineMs)));
        if (params && params.length > 0) {
          // Positional `?` parameters; a NULL needs a declared type.
          request.params = params.map((value) => (value instanceof Date ? value.toISOString() : value));
          request.types = params.map((value) => (value === null || value === undefined ? 'STRING' : undefined));
        }
        [job] = await client.createQueryJob(request);
        if (stopped) await cancel();
        const readOptions: Record<string, unknown> = { autoPaginate: false, wrapIntegers: false };
        if (options.maxRows !== undefined) readOptions.maxResults = options.maxRows + 1;
        if (options.deadlineMs !== undefined) readOptions.timeoutMs = Math.max(1_000, Math.ceil(options.deadlineMs));
        const [rawRows, , response] = await job.getQueryResults(readOptions);
        const fields = response?.schema?.fields ?? [];
        const columns: ColumnMeta[] = fields.length > 0
          ? fields.map((field) => ({ name: field.name, type: mapBigQueryType(field.type, field.mode), driverType: field.type ?? 'unknown' }))
          : Object.keys(rawRows[0] ?? {}).map((name) => ({ name, type: 'unknown' as ColumnType, driverType: 'unknown' }));
        const rows = rawRows.map((row) => {
          const out: Row = {};
          for (const [key, value] of Object.entries(row)) out[key] = plainBigQueryValue(value);
          return out;
        });
        const more = Boolean(response?.pageToken) || (response?.totalRows !== undefined && Number(response.totalRows) > rows.length);
        return boundedResult(columns, rows, startedAt, options, {
          ...(job.id ? { queryId: job.id } : {}),
          ...(options.maxRows !== undefined && more && rows.length >= options.maxRows ? { truncated: true } : {}),
        });
      }, cancel);
    } catch (error) {
      throw new Error(`BigQuery query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async datasets(): Promise<string[]> {
    if (!this.client) throw new Error('BigQuery connector not connected.');
    const [datasets] = await this.client.getDatasets();
    return (datasets ?? []).map((dataset) => String(dataset.id ?? '')).filter(Boolean);
  }

  async listTables(): Promise<TableInfo[]> {
    const tables: TableInfo[] = [];
    for (const dataset of await this.datasets()) {
      const result = await this.execute(
        `SELECT table_schema, table_name, table_type FROM ${quoteIdentifier(dataset)}.INFORMATION_SCHEMA.TABLES ORDER BY table_name`,
      );
      for (const row of result.rows) {
        tables.push({
          schema: String(row['table_schema'] ?? dataset),
          name: String(row['table_name'] ?? ''),
          type: String(row['table_type'] ?? 'BASE TABLE'),
        });
      }
    }
    return tables;
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const datasets = schema ? [schema] : await this.datasets();
    const columns: ColumnInfo[] = [];
    for (const dataset of datasets) {
      let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position FROM ${quoteIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS`;
      if (table) sql += ` WHERE table_name = ${bigQueryString(table)}`;
      sql += ` ORDER BY table_name, ordinal_position`;
      const result = await this.execute(sql);
      for (const row of result.rows) {
        columns.push({
          schema: String(row['table_schema'] ?? dataset),
          table: String(row['table_name'] ?? ''),
          name: String(row['column_name'] ?? ''),
          dataType: String(row['data_type'] ?? ''),
          ordinalPosition: Number(row['ordinal_position'] ?? 0),
        });
      }
    }
    return columns;
  }
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '\\`')}\``;
}

/** BigQuery strings escape with a backslash; a doubled quote is not an escape there. */
function bigQueryString(value: string): string {
  return sqlLiteral(value, 'backslash');
}

/**
 * BigQuery wraps DATE / DATETIME / TIMESTAMP / NUMERIC in objects. The answer
 * is their text (or number): `{ value: '2024-01-31' }` becomes '2024-01-31'.
 */
function plainBigQueryValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(plainBigQueryValue);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('value' in record && Object.keys(record).length === 1) return record.value;
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'Big') {
      const n = Number(String(value));
      return Number.isFinite(n) ? n : String(value);
    }
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) out[key] = plainBigQueryValue(nested);
    return out;
  }
  return value;
}

function mapBigQueryType(type: string | undefined, mode: string | undefined): ColumnType {
  if (mode === 'REPEATED') return 'unknown';
  switch ((type ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return 'number';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'datetime';
    case 'STRING':
    case 'BYTES':
    case 'JSON':
    case 'TIME':
      return 'string';
    default:
      return 'unknown';
  }
}
