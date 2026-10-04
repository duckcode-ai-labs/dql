import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor, QueryResult } from '@duckcodeailabs/dql-connectors';
import { EXPORT_MAX_ROWS, startLocalServer } from '../local-runtime.js';

/** A file from an export is the whole result (up to a maximum), never the screen's first 500 rows without a word. */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(rowCount: number) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-export-size-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'exports', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
  const sql: string[] = [];
  const result = () => ({ columns: [{ name: 'n', type: 'integer' }], rows: Array.from({ length: rowCount }, (_, n) => ({ n })), rowCount, executionTime: 1 }) as unknown as QueryResult;
  const executor = {
    async executeQuery(this: QueryExecutor, text: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(text, [], config); },
    executePositional: async (text: string) => { sql.push(text); return result(); },
    getConnector: async () => ({ execute: async () => result(), disconnect: async () => undefined }),
    disconnect: async () => undefined,
  } as unknown as QueryExecutor;
  const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
  const exported = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/query/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT n FROM t', format: 'json' }) });
    return { status: response.status, rowCount: response.headers.get('x-dql-row-count'), text: await response.text() };
  };
  return { exported, sql };
}

describe('exports hold the whole result', () => {
  it('writes every row of a result larger than the screen shows', async () => {
    const { exported, sql } = await start(933);
    const file = await exported();
    expect(file.status).toBe(200);
    expect((JSON.parse(file.text) as unknown[]).length).toBe(933);
    expect(file.rowCount).toBe('933');
    expect(sql.at(-1)).toMatch(new RegExp(`LIMIT ${EXPORT_MAX_ROWS + 1}`, 'i'));
  });

  it('refuses a result larger than a file holds, with a way forward', async () => {
    const { exported } = await start(EXPORT_MAX_ROWS + 1);
    const file = await exported();
    expect(file.status).toBe(413);
    expect(JSON.parse(file.text)).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });
});
