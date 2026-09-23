import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLiteConnector } from './sqlite.js';

// better-sqlite3 as a project's .dql/connectors would provide it: the CLI's copy.
const moduleSearchPaths = [resolve(__dirname, '../../../../apps/cli')];

// A statement that runs for minutes: counting to a billion.
const SLOW = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT COUNT(*) AS c FROM n';

describe('the SQLite connector', () => {
  const connectors: SQLiteConnector[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const connector of connectors.splice(0)) await connector.disconnect();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const fileDatabase = async (isolation?: 'worker' | 'inline') => {
    const root = mkdtempSync(join(tmpdir(), 'dql-sqlite-'));
    roots.push(root);
    const file = join(root, 'shop.sqlite');
    // Build the file with a writable connection, then open it read-only.
    const Database = (await import(join(moduleSearchPaths[0]!, 'node_modules', 'better-sqlite3', 'lib', 'index.js'))).default as new (path: string) => { exec(sql: string): void; close(): void };
    const db = new Database(file);
    db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO orders SELECT i, i * 1.5 FROM n;`);
    db.close();
    const connector = new SQLiteConnector();
    await connector.connect({ driver: 'sqlite', filepath: file, moduleSearchPaths, ...(isolation ? { sqliteQueryIsolation: isolation } : {}) });
    connectors.push(connector);
    return connector;
  };

  it('runs a file-backed query on its own thread: rows come back and reading stops at the row limit', async () => {
    const connector = await fileDatabase();
    const all = await connector.execute('SELECT id, amount FROM orders ORDER BY id');
    expect(all.rowCount).toBe(2000);
    expect(all.rows[1]).toEqual({ id: 2, amount: 3 });
    expect(all.columns.map((column) => column.name)).toEqual(['id', 'amount']);
    const capped = await connector.execute('SELECT id FROM orders ORDER BY id', [], { maxRows: 10 });
    expect(capped.rowCount).toBe(10);
    expect(capped.truncated).toBe(true);
    const bound = await connector.execute('SELECT COUNT(*) AS n FROM orders WHERE amount > ?', [2997]);
    expect(bound.rows).toEqual([{ n: 2 }]);
  });

  it('a slow query stops at its deadline, the runtime stays responsive meanwhile, and the next query runs', async () => {
    const connector = await fileDatabase();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    await expect(connector.execute(SLOW, [], { deadlineMs: 400 })).rejects.toThrow(/deadline|SQLite/i);
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The event loop kept running while SQLite worked: timers fired.
    expect(ticks).toBeGreaterThan(5);
    const after = await connector.execute('SELECT COUNT(*) AS n FROM orders');
    expect(after.rows).toEqual([{ n: 2000 }]);
  }, 20_000);

  it('a cancelled query stops too', async () => {
    const connector = await fileDatabase();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('the user cancelled')), 200);
    await expect(connector.execute(SLOW, [], { signal: controller.signal })).rejects.toThrow();
    expect((await connector.execute('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  }, 20_000);

  it('inline mode and in-memory databases stay on the calling thread and still stop reading at the row limit', async () => {
    const inline = await fileDatabase('inline');
    const capped = await inline.execute('SELECT id FROM orders ORDER BY id', [], { maxRows: 3 });
    expect(capped.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(capped.truncated).toBe(true);
    const memory = new SQLiteConnector();
    await memory.connect({ driver: 'sqlite', filepath: ':memory:', moduleSearchPaths });
    connectors.push(memory);
    expect((await memory.execute('SELECT 2 AS two')).rows).toEqual([{ two: 2 }]);
  });
});
