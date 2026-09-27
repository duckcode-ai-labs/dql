import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig, type QueryResult } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { inflateRawSync } from 'node:zlib';
import { destinationForAction, withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';
import { withRowPolicy, type DqlQueryContext } from './row-policy.js';

/**
 * RFC 0010 HH-17: where a statement's result goes. Exports are files made on
 * the server from a statement run for the export itself, so the host's row
 * policy hears `destination: 'export'` and decides what the file may hold.
 */
const here = dirname(fileURLToPath(import.meta.url));
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const withDuckDb = connectorRoot ? describe : describe.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');
// The App's own policies let these people run its page (HH-11 grants).
/** The entries of the zip archive an Excel export is. */
function unzip(archive: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + archive.readUInt16LE(offset + 28);
    out[archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')] = inflateRawSync(archive.subarray(start, start + size)).toString('utf8');
    offset = start + size;
  }
  return out;
}

const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', appGrants: { 'commerce-pilot': 'execute' }, source: 'host' };

describe('destinations on every statement (HH-17)', () => {
  it('reads the destination from the request\'s action, and a scheduled run\'s pass as a delivery', async () => {
    expect(['export', 'ask', 'research', 'schedule.manage', 'app.view', 'query.run'].map((action) => destinationForAction(action as never)))
      .toEqual(['export', 'model', 'model', 'delivery', 'person', 'person']);
    const seen: DqlQueryContext[] = [];
    const inner = { executePositional: async () => ({ columns: [], rows: [] }) as unknown as QueryResult } as unknown as QueryExecutor;
    const executor = withRowPolicy(inner, (query) => { seen.push(query); return { sql: query.sql }; });
    const connection = { driver: 'duckdb' } as ConnectionConfig;
    await withRequestContext({ principal: maria, requestId: 'r1', action: 'export' }, () => executor.executePositional('SELECT 1', [], connection));
    await withRequestContext({ principal: maria, requestId: 'r2', action: 'ask' }, () => executor.executePositional('SELECT 1', [], connection));
    await withRequestContext({ principal: maria, requestId: 'r3', action: 'app.view', destination: 'delivery' }, () => executor.executePositional('SELECT 1', [], connection));
    await executor.executePositional('SELECT 1', [], connection);
    expect(seen.map((query) => [query.destination, query.action])).toEqual([['export', 'export'], ['model', 'ask'], ['delivery', 'app.view'], [undefined, undefined]]);
  });
});

withDuckDb('exports as files, under the host\'s export rules (HH-17)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-exports-'));
  const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot ?? ''] };
  const executor = new QueryExecutor();
  const servers: Server[] = [];
  const seen: DqlQueryContext[] = [];
  let hosted = '';
  let local = '';
  const people: Record<string, DqlPrincipal> = {
    maria,
    // May see and export, but not run SQL of her own.
    priya: { id: 'u-priya', kind: 'person', email: 'priya@insurer.example', source: 'host' },
    // Her exports are refused outright.
    omar: { id: 'u-omar', kind: 'person', email: 'omar@insurer.example', appGrants: { 'commerce-pilot': 'execute' }, source: 'host' },
  };
  // A host that masks region in any file and refuses Omar's; on screen, region is shown.
  const hostHooks: DqlHostHooks = {
    resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
    authorize: (principal, action) => ({ allow: !(principal.id === 'u-priya' && action === 'query.run'), reason: 'Only analysts run their own SQL.' }),
    rowPolicy: (query) => {
      seen.push(query);
      if (query.destination !== 'export' || query.purpose === 'metadata') return { sql: query.sql };
      if (query.principal?.id === 'u-omar') return { refuse: 'Order lines may not leave DQL in a file.' };
      return { sql: query.sql.replace(/\bFROM\s+(?:"?main"?\.)?"?order_lines"?(?![\w"])/gi, `FROM (SELECT * EXCLUDE (region), '****' AS region FROM "main"."order_lines") AS "order_lines"`) };
    },
  };
  const call = async (base: string, person: string | null, path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(person ? { 'x-test-person': person } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, type: response.headers.get('content-type') ?? '', disposition: response.headers.get('content-disposition') ?? '', body: Buffer.from(await response.arrayBuffer()) };
  };
  const sql = 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region';

  beforeAll(async () => {
    cpSync(fixtureRoot, projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
    execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
    const hostedPort = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { servers.push(created); } });
    hosted = `http://127.0.0.1:${hostedPort}`;
    const localPort = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: new QueryExecutor(), connection, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    local = `http://127.0.0.1:${localPort}`;
  }, 120_000);

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    await executor.disconnect();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('exports SQL as CSV, JSON and Excel, run again for the file: the screen shows region, the file does not', async () => {
    // On screen first, so a cached result could only leak into the file if keys were shared.
    const screen = await call(hosted, 'maria', '/api/query', { sql });
    expect(screen.body.toString()).toContain('"CA"');
    const csv = await call(hosted, 'maria', '/api/query/export', { sql, format: 'csv', title: 'Orders by region' });
    expect(csv.status, csv.body.toString()).toBe(200);
    expect(csv.type).toBe('text/csv; charset=utf-8');
    expect(csv.disposition).toBe('attachment; filename="orders-by-region.csv"');
    expect(csv.body.toString()).toBe('region,n\r\n****,8\r\n');
    const json = await call(hosted, 'maria', '/api/query/export', { sql, format: 'json' });
    expect(JSON.parse(json.body.toString())).toEqual([{ region: '****', n: 8 }]);
    const xlsx = await call(hosted, 'maria', '/api/query/export', { sql, format: 'xlsx' });
    expect(xlsx.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(unzip(xlsx.body)['xl/worksheets/sheet1.xml']).toContain('<t xml:space="preserve">****</t>');
    const exported = seen.filter((query) => query.destination === 'export');
    expect(exported.length).toBeGreaterThanOrEqual(3);
    expect(exported.every((query) => query.action === 'export')).toBe(true);
    expect(seen.some((query) => query.destination === 'person' && query.action === 'query.run')).toBe(true);
  });

  it('refuses what the host refuses, a format it does not know, and SQL from someone who may not run SQL', async () => {
    const refused = await call(hosted, 'omar', '/api/query/export', { sql, format: 'csv' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body.toString())).toMatchObject({ error: 'Order lines may not leave DQL in a file.', code: 'EXPORT_REFUSED' });
    expect((await call(hosted, 'maria', '/api/query/export', { sql, format: 'html' })).status).toBe(400);
    const priya = await call(hosted, 'priya', '/api/query/export', { sql, format: 'csv' });
    expect(priya.status).toBe(403);
    expect(JSON.parse(priya.body.toString()).error).toBe('Only analysts run their own SQL.');
  });

  it('exports one tile of an App page, run again for the file', async () => {
    const run = await call(hosted, 'maria', '/api/apps/commerce-pilot/dashboards/overview/run', {});
    const tiles = JSON.parse(run.body.toString()).tiles as Array<{ tileId: string; status: string; result?: { rows: Array<Record<string, unknown>> } }>;
    const chart = tiles.find((tile) => tile.tileId === 'order-lines-dataset-chart')!;
    expect(chart.status, JSON.stringify(chart).slice(0, 600)).toBe('ok');
    expect(JSON.stringify(chart.result?.rows)).toMatch(/"(CA|US)"/);
    const file = await call(hosted, 'maria', '/api/apps/commerce-pilot/dashboards/overview/export', { tileId: 'order-lines-dataset-chart', format: 'csv' });
    expect(file.status, file.body.toString()).toBe(200);
    expect(file.disposition).toMatch(/^attachment; filename="[a-z0-9-]+\.csv"$/);
    expect(file.body.toString()).toContain('****');
    expect(file.body.toString()).not.toMatch(/(^|,)(CA|US)(,|\r)/m);
    const refused = await call(hosted, 'omar', '/api/apps/commerce-pilot/dashboards/overview/export', { tileId: 'order-lines-dataset-chart', format: 'csv' });
    expect(refused.status).toBe(422);
    expect(refused.body.toString()).toContain('may not leave DQL in a file');
    expect((await call(hosted, 'maria', '/api/apps/commerce-pilot/dashboards/overview/export', { format: 'csv' })).status).toBe(400);
  });

  it('without a host, exports what the person sees', async () => {
    const csv = await call(local, null, '/api/query/export', { sql, format: 'csv' });
    expect(csv.status, csv.body.toString()).toBe(200);
    expect(csv.body.toString()).toBe('region,n\r\nCA,3\r\nUS,5\r\n');
  });
});
