import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, Row } from '../result-types.js';
import { importConnectorDependency } from '../optional-dependency.js';
import { readEnv } from '../env.js';
import { assertCanStart, withDeadline } from './shared.js';
import type { WorkerReply, WorkerRequest } from './sqlite-query-worker.js';

/** The part of better-sqlite3 this connector uses; the package is loaded at runtime. */
interface SQLiteStatement {
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): Iterable<Row>;
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

/** The worker could not be started here; the connection runs its queries inline instead. */
class SQLiteWorkerUnavailable extends Error {}

/**
 * The worker script: the built `.js` beside this file, or (tests run the
 * TypeScript source) the package's built copy, or the `.ts` source itself on
 * a Node that strips types. Undefined when none can run.
 */
function workerScript(): { url: URL; execArgv?: string[] } | undefined {
  const sibling = new URL('./sqlite-query-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return { url: sibling };
  const built = new URL('../../dist/drivers/sqlite-query-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(built))) return { url: built };
  const source = new URL('./sqlite-query-worker.ts', import.meta.url);
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (existsSync(fileURLToPath(source)) && (major > 22 || (major === 22 && minor >= 6))) return { url: source, execArgv: ['--experimental-strip-types', '--no-warnings'] };
  return undefined;
}

/**
 * One long-lived thread per file-backed connection, where its queries run
 * (see sqlite-query-worker.ts). Queries run one at a time, in order. A query
 * past its deadline, or cancelled, terminates the thread: that is the only
 * way to stop a synchronous SQLite statement. The next query starts a fresh
 * one, which reopens the file.
 */
class SQLiteWorkerHost {
  private worker: Worker | undefined;
  private opened: Promise<void> | undefined;
  private pending = new Map<number, { resolve: (reply: Extract<WorkerReply, { type: 'result' }>) => void; reject: (error: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private next = 0;

  constructor(private readonly filepath: string, private readonly moduleSearchPaths: string[] | undefined) {}

  private start(): Promise<void> {
    if (this.opened) return this.opened;
    const script = workerScript();
    if (!script) return Promise.reject(new SQLiteWorkerUnavailable('no runnable SQLite worker script'));
    let worker: Worker;
    try {
      worker = new Worker(script.url, script.execArgv ? { execArgv: script.execArgv } : {});
    } catch (error) {
      return Promise.reject(new SQLiteWorkerUnavailable(error instanceof Error ? error.message : String(error)));
    }
    this.worker = worker;
    let isOpen = false;
    this.opened = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        // A worker that never opened the file could not run here at all.
        reject(isOpen ? error : new SQLiteWorkerUnavailable(error.message));
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
        if (this.worker === worker) { this.worker = undefined; this.opened = undefined; }
      };
      worker.on('message', (reply: WorkerReply) => {
        if (reply.type === 'opened') { isOpen = true; resolve(); return; }
        if (reply.id === undefined) { fail(new Error(reply.type === 'error' ? reply.message : 'the SQLite worker replied without a query')); return; }
        const waiting = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (!waiting) return;
        if (reply.type === 'error') waiting.reject(new Error(reply.message));
        else waiting.resolve(reply);
      });
      worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => { if (this.worker === worker) fail(new Error(`the SQLite worker exited (code ${code})`)); });
      worker.postMessage({ type: 'open', filepath: this.filepath, ...(this.moduleSearchPaths ? { moduleSearchPaths: this.moduleSearchPaths } : {}) } satisfies WorkerRequest);
    });
    return this.opened;
  }

  run(sql: string, params: unknown[] | undefined, options: QueryExecutionOptions): Promise<QueryResult> {
    assertCanStart('SQLite', options);
    // The deadline counts from the call, time spent waiting in line included.
    const deadlineAt = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : undefined;
    const task = this.queue.then(() => withDeadline('SQLite', { ...options, ...(deadlineAt !== undefined ? { deadlineMs: Math.max(0, deadlineAt - Date.now()) } : {}) }, async () => {
      await this.start();
      const id = this.next++;
      const reply = await new Promise<Extract<WorkerReply, { type: 'result' }>>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker!.postMessage({ type: 'query', id, sql, ...(params?.length ? { params } : {}), ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}), ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) } satisfies WorkerRequest);
      });
      const columns: ColumnMeta[] = reply.columns.map((column) => ({ name: column.name, type: column.type as ColumnMeta['type'], driverType: 'sqlite' }));
      return { columns, rows: reply.rows as Row[], rowCount: reply.rowCount, executionTimeMs: reply.executionTimeMs, ...(reply.truncated ? { truncated: true } : {}) };
    }, () => this.stop()));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Stop the thread and whatever it is running; the next query starts another. */
  stop(): Promise<number> | undefined {
    const worker = this.worker;
    this.worker = undefined;
    this.opened = undefined;
    for (const waiting of this.pending.values()) waiting.reject(new Error('the SQLite query was stopped'));
    this.pending.clear();
    return worker?.terminate();
  }
}

export class SQLiteConnector implements DatabaseConnector {
  readonly driverName = 'sqlite';
  private db: SQLiteDatabase | null = null;
  private host: SQLiteWorkerHost | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    const filepath = config.filepath ?? config.database ?? ':memory:';
    const Database = await loadDatabase(config);
    // A warehouse file is read, never changed: opening it read-only also
    // leaves its journal mode and sidecar files alone.
    this.db = filepath === ':memory:' ? new Database(filepath) : new Database(filepath, { readonly: true, fileMustExist: true });
    // A file-backed connection runs its queries on their own thread, so a
    // deadline can stop a slow one and nothing else waits on it. In-memory
    // databases live on this thread and stay here.
    const isolation = config.sqliteQueryIsolation ?? (readEnv('ZLENS_SQLITE_QUERY_ISOLATION') === 'inline' ? 'inline' : 'worker');
    this.host = filepath !== ':memory:' && isolation === 'worker' ? new SQLiteWorkerHost(filepath, config.moduleSearchPaths) : undefined;
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.db) {
      throw new Error('SQLite connector not connected. Call connect() first.');
    }
    if (this.host) {
      try {
        return await this.host.run(sql, params, options);
      } catch (error) {
        // A runtime that cannot start the worker keeps answering, inline.
        if (!(error instanceof SQLiteWorkerUnavailable)) throw error;
        this.host = undefined;
      }
    }
    assertCanStart('SQLite', options);

    const startTime = performance.now();
    const stmt = this.db.prepare(sql);

    if (stmt.reader) {
      // Rows are read one at a time and reading stops at the limit; the
      // statement is never read to its end only to be trimmed.
      const rows: Row[] = [];
      let truncated = false;
      for (const row of (params ? stmt.iterate(...params) : stmt.iterate())) {
        if (options.maxRows !== undefined && rows.length >= options.maxRows) { truncated = true; break; }
        rows.push(row);
      }
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
        ...(truncated ? { truncated: true } : {}),
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
    await this.host?.stop();
    this.host = undefined;
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
