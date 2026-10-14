import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { applyTableDatasetChoices } from './table-dataset.js';
import { readEnv } from '@zlens/core';

/**
 * Start from a table (RFC 0009, "15-minute first page"), end to end on real
 * DuckDB: list the tables, draft one checked against its rows, save it, and
 * find it in App Studio's sources as a certified Dataset. Needs a DuckDB
 * connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

async function call(base: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

describe('start from a table', () => {
  it('uses only the author\'s choice of numbers and formats from a request', () => {
    const proposal = {
      name: 'Orders', relation: 'orders', keyCandidates: [], fields: [],
      measures: [{ name: 'amount', label: 'Amount', aggregation: 'sum' as const, from: 'amount', format: 'currency' as const, currency: 'USD', include: true, reason: '' }],
    };
    const next = applyTableDatasetChoices(proposal, [{ name: 'amount', include: false, format: 'number', from: 'secret_column', aggregation: 'max' }, { name: 'injected', include: true }]);
    expect(next.measures).toEqual([{ ...proposal.measures[0], include: false, format: 'number' }]);
  });

  duckDbIt('lists tables, drafts a checked Dataset, saves it certified, and App Studio lists it', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-table-dataset-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const tables = await call(base, '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      expect(tables.body.source).toBe('live');
      const orderLines = tables.body.tables.find((table: { name: string }) => table.name === 'order_lines');
      expect(orderLines).toMatchObject({ relation: '"main"."order_lines"', columnCount: 8 });

      const draft = await call(base, '/api/app-datasets/tables/draft', { tableId: orderLines.id });
      expect(draft.status, draft.text).toBe(200);
      expect(draft.body.proposal.key).toEqual({ column: 'order_line_id', entity: 'order_line' });
      expect(draft.body.rows).toBeGreaterThan(0);

      const created = await call(base, '/api/app-datasets/tables/create', {
        tableId: orderLines.id,
        name: 'Order lines from table',
        domain: 'commerce',
        measures: [{ name: 'cost_amount', include: false, format: 'currency' }],
      });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ ok: true, status: 'certified', keyChecked: true });
      expect(created.body.sourceId).toEqual(expect.any(String));
      const source = readFileSync(join(projectRoot, created.body.path), 'utf-8');
      expect(source).toContain('status = "certified"');
      expect(source).toContain('keys = ["order_line_id"]');
      expect(source).not.toMatch(/cost_amount \{ agg/);

      const app = await call(base, '/api/app-builds', { name: 'First page', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank' });
      expect(app.status, app.text).toBe(201);
      const candidates = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const listed = candidates.body.items.find((item: { sourceId: string }) => item.sourceId === created.body.sourceId);
      expect(listed).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      expect(listed.capabilities.dataset.fields.filter((field: { kind: string }) => field.kind === 'measure').map((field: { name: string }) => field.name).sort())
        .toEqual(['customer_count', 'margin_amount', 'net_amount', 'order_count', 'order_line_count']);

      const again = await call(base, '/api/app-datasets/tables/create', { tableId: orderLines.id, name: 'Order lines from table', domain: 'commerce' });
      expect(again.status).toBe(409);
      expect(again.body.error).toContain('already exists');
      expect(existsSync(join(projectRoot, created.body.path))).toBe(true);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
