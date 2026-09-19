import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { boundedResult, inlineParameters, loadDependency, redactSecrets, sqlLiteral, withDeadline } from './shared.js';

/** The part of `@aws-sdk/client-athena` this connector uses; the package is loaded at connect time. */
interface AthenaDatum { VarCharValue?: string }
interface AthenaColumnInfo { Name?: string; Type?: string }
interface AthenaModule {
  AthenaClient: new (config: Record<string, unknown>) => { send(command: unknown): Promise<any>; destroy?(): void };
  StartQueryExecutionCommand: new (input: Record<string, unknown>) => unknown;
  GetQueryExecutionCommand: new (input: Record<string, unknown>) => unknown;
  GetQueryResultsCommand: new (input: Record<string, unknown>) => unknown;
  StopQueryExecutionCommand: new (input: Record<string, unknown>) => unknown;
}

const PAGE_SIZE = 1000;

/**
 * Amazon Athena. Credentials come from the AWS default chain (environment,
 * SSO, instance role), a named profile, or an access key pair.
 */
export class AthenaConnector implements DatabaseConnector {
  readonly driverName = 'athena';
  private client: { send(command: unknown): Promise<any>; destroy?(): void } | null = null;
  private athena: AthenaModule | null = null;
  private database?: string;
  private catalog?: string;
  private outputLocation?: string;
  private workgroup?: string;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    this.athena = await loadDependency<AthenaModule>('@aws-sdk/client-athena', config);
    this.config = config;
    const region = config.region ?? 'us-east-1';
    const clientConfig: Record<string, unknown> = { region };
    const method = config.authMethod ?? (config.accessKeyId ? 'aws_access_key' : config.profile ? 'aws_profile' : 'aws_default');
    if (method === 'aws_access_key') {
      if (!config.accessKeyId || !config.secretAccessKey) throw new Error('Athena access-key sign-in needs an access key id and a secret access key.');
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      };
    } else if (method === 'aws_profile') {
      if (!config.profile) throw new Error('Athena profile sign-in needs a profile name from ~/.aws/config.');
      clientConfig.profile = config.profile;
    }
    this.client = new this.athena.AthenaClient(clientConfig);
    this.database = config.database ?? config.schema;
    this.catalog = config.catalog;
    this.outputLocation = config.outputLocation;
    this.workgroup = config.workgroup;
    await this.execute('SELECT 1', undefined, { deadlineMs: Math.max(5_000, (config.timeout ?? 60) * 1000) });
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.client || !this.athena) throw new Error('Athena connector not connected. Call connect() first.');
    const client = this.client;
    const athena = this.athena;
    const startedAt = performance.now();
    let queryExecutionId: string | undefined;
    let stopped = false;
    const cancel = () => {
      stopped = true;
      if (queryExecutionId) {
        return client.send(new athena.StopQueryExecutionCommand({ QueryExecutionId: queryExecutionId })).catch(() => undefined);
      }
      return undefined;
    };
    const text = inlineParameters(sql.trim().replace(/;\s*$/, ''), params);
    try {
      return await withDeadline('Athena', options, async () => {
        const context: Record<string, string> = {};
        if (this.database) context.Database = this.database;
        if (this.catalog) context.Catalog = this.catalog;
        const started = await client.send(new athena.StartQueryExecutionCommand({
          QueryString: text,
          ...(Object.keys(context).length ? { QueryExecutionContext: context } : {}),
          ...(this.outputLocation ? { ResultConfiguration: { OutputLocation: this.outputLocation } } : {}),
          ...(this.workgroup ? { WorkGroup: this.workgroup } : {}),
        }));
        queryExecutionId = started.QueryExecutionId;
        if (!queryExecutionId) throw new Error('Athena did not return a query execution id.');
        if (stopped) await cancel();

        let wait = 200;
        let statementType: string | undefined;
        while (true) {
          const status = await client.send(new athena.GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
          const state = status.QueryExecution?.Status?.State;
          statementType = status.QueryExecution?.StatementType;
          if (state === 'SUCCEEDED') break;
          if (state === 'FAILED' || state === 'CANCELLED') {
            throw new Error(status.QueryExecution?.Status?.StateChangeReason ?? `query ${String(state).toLowerCase()}`);
          }
          if (stopped) throw new Error('query was stopped');
          await delay(wait);
          wait = Math.min(1_000, Math.round(wait * 1.5));
        }

        const rows: Row[] = [];
        let columns: ColumnMeta[] = [];
        let types: string[] = [];
        let nextToken: string | undefined;
        let first = true;
        let truncated = false;
        do {
          const page = await client.send(new athena.GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, NextToken: nextToken, MaxResults: PAGE_SIZE }));
          if (columns.length === 0) {
            const info = (page.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []) as AthenaColumnInfo[];
            columns = info.map((column) => ({ name: String(column.Name ?? ''), type: mapAthenaType(String(column.Type ?? '')), driverType: String(column.Type ?? '') }));
            types = info.map((column) => String(column.Type ?? '').toLowerCase());
          }
          const pageRows = (page.ResultSet?.Rows ?? []) as Array<{ Data?: AthenaDatum[] }>;
          // A SELECT's first result row repeats the column names.
          const skip = first && statementType === 'DML' ? 1 : 0;
          first = false;
          for (const entry of pageRows.slice(skip)) {
            const data = entry.Data ?? [];
            rows.push(Object.fromEntries(columns.map((column, index) => [column.name, athenaValue(data[index]?.VarCharValue, types[index] ?? '')])));
          }
          nextToken = page.NextToken;
          if (nextToken && options.maxRows !== undefined && rows.length > options.maxRows) {
            truncated = true;
            break;
          }
        } while (nextToken);
        return boundedResult(columns, rows, startedAt, options, { queryId: queryExecutionId, ...(truncated ? { truncated } : {}) });
      }, cancel);
    } catch (error) {
      throw new Error(`Athena query failed: ${redactSecrets(error instanceof Error ? error.message : String(error), this.config!)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client?.destroy?.();
    this.client = null;
    this.athena = null;
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
    const where = this.database ? `table_schema = ${sqlLiteral(this.database)}` : `table_schema <> 'information_schema'`;
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? 'BASE TABLE'),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    const db = schema ?? this.database;
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position FROM information_schema.columns WHERE `;
    sql += db ? `table_schema = ${sqlLiteral(db)}` : `table_schema <> 'information_schema'`;
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

/** Athena returns every value as text; numbers and booleans are restored from the column type. */
function athenaValue(value: string | undefined, type: string): unknown {
  if (value === undefined) return null;
  if (/^(tinyint|smallint|integer|int|bigint|real|float|double|decimal)/.test(type)) {
    const n = Number(value);
    return Number.isFinite(n) && (!/^bigint/.test(type) || Number.isSafeInteger(n)) ? n : value;
  }
  if (type === 'boolean') return value === 'true';
  return value;
}

function mapAthenaType(driverType: string): ColumnType {
  const lower = driverType.toLowerCase();
  if (lower === 'boolean') return 'boolean';
  if (/^(tinyint|smallint|integer|int|bigint|real|float|double|decimal)/.test(lower)) return 'number';
  if (lower === 'date') return 'date';
  if (lower.startsWith('timestamp')) return 'datetime';
  if (/^(varchar|char|string)/.test(lower)) return 'string';
  return 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
