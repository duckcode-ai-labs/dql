/**
 * The thread a file-backed SQLite connection runs its queries on.
 *
 * better-sqlite3 is synchronous: a query runs to its end on the thread that
 * called it. On the runtime's own thread one slow query (an aggregate over a
 * million-row table) froze the whole server, so no deadline, cancellation or
 * other request could run until it finished. Here it blocks only this thread,
 * which the connector terminates when the deadline passes.
 *
 * The database is opened once, read-only, and every query reads rows one at a
 * time, stopping at the row and byte limits instead of reading everything and
 * trimming afterwards.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';

interface Statement {
  readonly reader: boolean;
  iterate(...params: unknown[]): Iterable<Record<string, unknown>>;
  columns(): Array<{ name: string; type: string | null }>;
  run(...params: unknown[]): { changes: number };
}
interface Database { prepare(sql: string): Statement; close(): void }
type DatabaseConstructor = new (filepath: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => Database;

export type WorkerRequest =
  | { type: 'open'; filepath: string; moduleSearchPaths?: string[] }
  | { type: 'query'; id: number; sql: string; params?: unknown[]; maxRows?: number; maxBytes?: number };

export type WorkerReply =
  | { type: 'opened' }
  | { type: 'result'; id: number; columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>>; rowCount: number; executionTimeMs: number; truncated?: boolean }
  | { type: 'error'; id?: number; message: string };

const port = parentPort;
let db: Database | undefined;

function load(moduleSearchPaths: string[] | undefined): DatabaseConstructor {
  for (const base of moduleSearchPaths ?? []) {
    try {
      const loaded = createRequire(join(base, 'package.json'))('better-sqlite3') as { default?: DatabaseConstructor };
      return (loaded.default ?? loaded) as DatabaseConstructor;
    } catch {
      // The next configured location, then the connector's own.
    }
  }
  const loaded = createRequire(import.meta.url)('better-sqlite3') as { default?: DatabaseConstructor };
  return (loaded.default ?? loaded) as DatabaseConstructor;
}

function valueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

function query(request: Extract<WorkerRequest, { type: 'query' }>): WorkerReply {
  if (!db) throw new Error('the SQLite database is not open');
  const started = performance.now();
  const statement = db.prepare(request.sql);
  const params = request.params ?? [];
  if (!statement.reader) {
    const result = statement.run(...params);
    return { type: 'result', id: request.id, columns: [], rows: [], rowCount: result.changes, executionTimeMs: performance.now() - started };
  }
  const maxRows = request.maxRows ?? Number.POSITIVE_INFINITY;
  const maxBytes = request.maxBytes ?? Number.POSITIVE_INFINITY;
  const rows: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let truncated = false;
  for (const row of statement.iterate(...params)) {
    if (rows.length >= maxRows) { truncated = true; break; }
    // Bytes are counted as rows arrive, never by re-serialising the lot.
    if (Number.isFinite(maxBytes)) {
      bytes += Buffer.byteLength(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? '', 'utf8');
      if (bytes > maxBytes && rows.length > 0) { truncated = true; break; }
    }
    rows.push(row);
  }
  const columns = statement.columns().map(({ name }) => ({ name, type: valueType(rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name] ?? null) }));
  return { type: 'result', id: request.id, columns, rows, rowCount: rows.length, executionTimeMs: performance.now() - started, ...(truncated ? { truncated: true } : {}) };
}

port?.on('message', (request: WorkerRequest) => {
  try {
    if (request.type === 'open') {
      const Database = load(request.moduleSearchPaths);
      db = new Database(request.filepath, { readonly: true, fileMustExist: true });
      port.postMessage({ type: 'opened' } satisfies WorkerReply);
      return;
    }
    port.postMessage(query(request));
  } catch (error) {
    port.postMessage({ type: 'error', ...(request.type === 'query' ? { id: request.id } : {}), message: error instanceof Error ? error.message : String(error) } satisfies WorkerReply);
  }
});
