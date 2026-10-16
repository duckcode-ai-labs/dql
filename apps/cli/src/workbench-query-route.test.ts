import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { WorkbenchRoutedQueryExecutor, isDuckDBFileConnection } from './workbench-query-route.js';
import type { RunningNotebook } from './schedule/notebook-runtime.js';

// Launch blocker: with `zlens notebook` running, `zlens certify`,
// `zlens model discover --validate` and `zlens sync warehouse` failed with
// DuckDB's "Could not set lock on file". Their queries now run through the
// workbench that holds the file.
describe('CLI queries on a DuckDB file the workbench holds', () => {
  const roots: string[] = [];
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function workbench() {
    const root = mkdtempSync(join(tmpdir(), 'zlens-cli-query-'));
    roots.push(root);
    const file = join(root, 'warehouse.duckdb');
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'shop', connections: { default: { driver: 'duckdb', filepath: 'warehouse.duckdb' } }, defaultConnectionName: 'default' }));
    const executePositional = vi.fn(async (sql: string, params: unknown[]) => ({
      columns: [{ name: 'n', type: 'BIGINT' }], rows: Array.from({ length: 700 }, (_, index) => ({ n: index, sql, params })), rowCount: 700, executionTimeMs: 2,
    }));
    const executor = { executePositional, executeQuery: vi.fn() } as unknown as QueryExecutor;
    const port = await startLocalServer({
      rootDir: root, projectRoot: root, executor, connection: { driver: 'duckdb', filepath: file }, preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    const notebook: RunningNotebook = {
      url: `http://127.0.0.1:${port}`, loopback: true,
      descriptor: { version: 1, pid: 4242, host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, instanceId: 'test', startedAt: '', appSchedules: false },
    };
    return { root, file, notebook, executePositional };
  }

  it('sends a read-only statement to the workbench and returns every row, as the command would have read them', async () => {
    const { root, file, notebook, executePositional } = await workbench();
    const routed: string[] = [];
    const executor = new WorkbenchRoutedQueryExecutor(root, { find: async () => notebook, onRoute: (via) => routed.push(via) });
    const result = await executor.executePositional('SELECT COUNT(*) AS n FROM dev.orders WHERE order_id = ?', ['o1'], { driver: 'duckdb', filepath: file }, { maxRows: 20_000 });
    expect(result.rowCount).toBe(700);
    expect(result.rows).toHaveLength(700); // no notebook preview cap
    expect(result.columns).toEqual([{ name: 'n', type: 'BIGINT' }]);
    expect(executePositional).toHaveBeenCalledWith('SELECT COUNT(*) AS n FROM dev.orders WHERE order_id = ?', ['o1'], expect.objectContaining({ driver: 'duckdb', filepath: file }), { maxRows: 20_000 });
    expect(routed).toEqual([`zlens notebook (pid 4242) at ${notebook.url}`]);
    expect(await executor.routesTo({ driver: 'duckdb', filepath: file })).toBe(true);
  });

  it('refuses a statement that writes, and a file the project does not connect to', async () => {
    const { root, file, notebook, executePositional } = await workbench();
    const executor = new WorkbenchRoutedQueryExecutor(root, { find: async () => notebook });
    await expect(executor.executePositional('CREATE TABLE t (a INTEGER)', [], { driver: 'duckdb', filepath: file })).rejects.toThrow(/only supports read-only SELECT or WITH/);
    await expect(executor.executePositional('SELECT 1', [], { driver: 'duckdb', filepath: join(root, 'elsewhere.duckdb') })).rejects.toThrow(/only on a DuckDB file this project connects to/);
    expect(executePositional).not.toHaveBeenCalled();
  });

  it('leaves every other connection, and a project with no workbench, to run locally', async () => {
    const find = vi.fn(async () => null);
    const executor = new WorkbenchRoutedQueryExecutor('/project', { find });
    expect(isDuckDBFileConnection({ driver: 'snowflake' } as never)).toBe(false);
    expect(isDuckDBFileConnection({ driver: 'duckdb', filepath: ':memory:' })).toBe(false);
    expect(await executor.routesTo({ driver: 'snowflake' } as never)).toBe(false);
    expect(find).not.toHaveBeenCalled();
    expect(await executor.routesTo({ driver: 'duckdb', filepath: '/project/w.duckdb' })).toBe(false);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('says plainly what to do when the workbench holding the file is an older ZLens', async () => {
    const notebook: RunningNotebook = { url: 'http://127.0.0.1:1', loopback: true, descriptor: { version: 1, pid: 99, host: '127.0.0.1', port: 1, url: 'http://127.0.0.1:1', instanceId: 'old', startedAt: '', appSchedules: false } };
    const fetchImpl = vi.fn(async () => new Response('Method not allowed', { status: 405 })) as unknown as typeof fetch;
    const executor = new WorkbenchRoutedQueryExecutor('/project', { find: async () => notebook, fetchImpl });
    await expect(executor.executePositional('SELECT 1', [], { driver: 'duckdb', filepath: '/project/w.duckdb' }))
      .rejects.toThrow('zlens notebook (pid 99) at http://127.0.0.1:1 has /project/w.duckdb open, and it is an older ZLens that cannot run this command\'s queries. Stop it (Ctrl+C in its terminal)');
  });
});
