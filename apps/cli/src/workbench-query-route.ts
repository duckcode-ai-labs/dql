import { resolve } from 'node:path';
import { QueryExecutor, type ConnectionConfig, type QueryExecutionOptions, type QueryResult } from '@zlens/connectors';
import { findRunningNotebook, serverTokenFor, type RunningNotebook } from './schedule/notebook-runtime.js';

/**
 * CLI QUERIES ON A DUCKDB FILE THE WORKBENCH HOLDS.
 *
 * DuckDB lets one process at a time open a database file: once `zlens
 * notebook` has run a query on `jaffle_shop.duckdb`, `zlens certify`, `zlens
 * model discover --validate` and `zlens sync warehouse` failed with "Could not
 * set lock on file". Opening the file read-only does not help: DuckDB refuses a
 * read-only open while another process holds it for writing (checked on the
 * sample with two processes).
 *
 * So a CLI command on a DuckDB file sends its queries to the workbench that
 * announced itself for this project (`.dql/local/notebook.json`, the same
 * route `zlens schedule run` uses for App pages), and the workbench runs them
 * on the database it already has open. Only read-only statements go this way
 * (the workbench refuses anything else); every other driver, and a DuckDB
 * project with no workbench running, runs locally as before.
 */
export const WORKBENCH_QUERY_PATH = '/api/runtime/cli-query';

export interface WorkbenchQueryRouteOptions {
  find?: (projectRoot: string) => Promise<RunningNotebook | null>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Called once, when the first query goes to the workbench (for a one-line note on stderr). */
  onRoute?: (via: string) => void;
}

export function isDuckDBFileConnection(connection: ConnectionConfig): boolean {
  const file = connection.filepath?.trim();
  return connection.driver === 'duckdb' && Boolean(file) && file !== ':memory:';
}

export class WorkbenchRoutedQueryExecutor extends QueryExecutor {
  private notebook: Promise<RunningNotebook | null> | undefined;
  private announced = false;

  constructor(private readonly projectRoot: string, private readonly options: WorkbenchQueryRouteOptions = {}) {
    super();
  }

  /** Whether queries on this connection go to a running workbench. */
  async routesTo(config: ConnectionConfig): Promise<boolean> {
    return isDuckDBFileConnection(config) && Boolean(await this.runningNotebook());
  }

  private runningNotebook(): Promise<RunningNotebook | null> {
    return (this.notebook ??= (this.options.find ?? findRunningNotebook)(resolve(this.projectRoot)).catch(() => null));
  }

  override async executePositional(
    sql: string,
    paramValues: unknown[],
    config: ConnectionConfig,
    options?: QueryExecutionOptions,
  ): Promise<QueryResult> {
    if (!isDuckDBFileConnection(config)) return super.executePositional(sql, paramValues, config, options);
    const notebook = await this.runningNotebook();
    if (!notebook) return super.executePositional(sql, paramValues, config, options);
    if (!this.announced) {
      this.announced = true;
      this.options.onRoute?.(`zlens notebook (pid ${notebook.descriptor.pid}) at ${notebook.url}`);
    }
    return runOnWorkbench(notebook, sql, paramValues, config, options, this.options);
  }
}

async function runOnWorkbench(
  notebook: RunningNotebook,
  sql: string,
  paramValues: unknown[],
  connection: ConnectionConfig,
  options: QueryExecutionOptions | undefined,
  route: WorkbenchQueryRouteOptions,
): Promise<QueryResult> {
  const token = serverTokenFor(notebook.loopback, route.env);
  const holder = `zlens notebook (pid ${notebook.descriptor.pid}) at ${notebook.url}`;
  if (!notebook.loopback && !token) {
    throw new Error(`${holder} has ${connection.filepath} open and answers API calls only with its token. Set ZLENS_SERVER_TOKEN to the same value here, or stop it (Ctrl+C in its terminal), and run this again.`);
  }
  const { signal, ...limits } = options ?? {};
  const response = await (route.fetchImpl ?? fetch)(`${notebook.url}${WORKBENCH_QUERY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      sql,
      params: paramValues ?? [],
      connection,
      options: Object.fromEntries(Object.entries(limits).filter(([key, value]) => ['maxRows', 'maxBytes', 'batchSize', 'deadlineMs'].includes(key) && typeof value === 'number')),
    }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({})) as Partial<QueryResult> & { error?: unknown };
  // An older workbench has no such route: it answers 404 or 405 in plain text.
  if ((response.status === 404 || response.status === 405) && payload.error === undefined) {
    throw new Error(`${holder} has ${connection.filepath} open, and it is an older ZLens that cannot run this command's queries. Stop it (Ctrl+C in its terminal) and run this again, then start the workbench again.`);
  }
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`${message} (ran through ${holder}, which has ${connection.filepath} open)`);
  }
  return {
    columns: Array.isArray(payload.columns) ? payload.columns : [],
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    rowCount: typeof payload.rowCount === 'number' ? payload.rowCount : Array.isArray(payload.rows) ? payload.rows.length : 0,
    executionTimeMs: typeof payload.executionTimeMs === 'number' ? payload.executionTimeMs : 0,
    ...(payload.truncated ? { truncated: true } : {}),
  };
}
