import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010: with a host, a block's last Block Studio run (its row count and columns, decided by the runner's row
 * rules) is the person's who ran it: kept in their own folder and shown back only to them. Without a host, the one
 * project-wide record as before.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const BLOCK = 'block "claims" {\n  domain = "claims"\n  type = "custom"\n  query = """SELECT region FROM claims"""\n}\n';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(hosted: boolean) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-runs-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'runs', connections: { default: { driver: 'duckdb', filepath: ':memory:' } } }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'blocks', 'claims.dql'), BLOCK);
  const rows = [{ region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }];
  const executor = { executeQuery: async () => ({ columns: [{ name: 'region', type: 'VARCHAR' }], rows, rowCount: rows.length, executionTime: 1 }) } as unknown as QueryExecutor;
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0,
    ...(hosted ? { hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  return { call, projectRoot };
}

describe('a block\'s last Block Studio run', () => {
  it('with a host, is kept for the person who ran it and shown only to them', async () => {
    const { call, projectRoot } = await serve(true);
    const ran = await call('priya', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' });
    expect(ran.status, ran.text.slice(0, 300)).toBe(200);
    expect((await call('priya', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toMatchObject({ rowCount: 7 });
    expect((await call('dan', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toBeUndefined();
    expect(existsSync(join(projectRoot, '.dql', 'runs', 'block-studio'))).toBe(false);
    expect(readdirSync(join(projectRoot, '.dql', 'local', 'private', 'block-studio-runs'))).toHaveLength(1);
  });

  it('without a host, is the one project-wide record as before', async () => {
    const { call, projectRoot } = await serve(false);
    expect((await call('', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' })).status).toBe(200);
    expect((await call('', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toMatchObject({ rowCount: 7 });
    expect(readdirSync(join(projectRoot, '.dql', 'runs', 'block-studio'))).toHaveLength(1);
  });
});
