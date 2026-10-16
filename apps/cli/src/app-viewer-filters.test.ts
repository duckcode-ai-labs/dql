import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import {
  parseDashboardViewerFilters,
  viewerFilterBindingsForBlockTile,
  viewerFilterVariables,
} from './app-viewer-filters.js';
import { createAppPackage } from './apps-api.js';
import { startLocalServer } from './local-runtime.js';

const page = {
  filters: [{ id: 'region', type: 'select' as const, bindsTo: 'region' }],
  params: [],
  layout: { kind: 'grid' as const, cols: 12, rowHeight: 80, items: [
    { i: 'products', x: 0, y: 0, w: 6, h: 4 },
    { i: 'trend', x: 6, y: 0, w: 6, h: 4 },
  ] },
};

describe('viewer filter request parsing', () => {
  it('accepts a column, its value and the tiles it narrows', () => {
    const parsed = parseDashboardViewerFilters([{ column: 'product_name', values: ['tangaroo'], tileIds: ['products'] }], page as never);
    expect(parsed).toEqual({ ok: true, filters: [{ column: 'product_name', values: ['tangaroo'], tileIds: ['products'] }] });
    if (!parsed.ok) return;
    expect(viewerFilterVariables(parsed.filters)).toEqual({ product_name: 'tangaroo' });
  });

  it('treats a missing field as no viewer filters', () => {
    expect(parseDashboardViewerFilters(undefined, page as never)).toEqual({ ok: true, filters: [] });
  });

  it.each([
    ['a column that is SQL, not a name', [{ column: 'name) OR 1=1 --', values: ['x'], tileIds: ['products'] }]],
    ['an empty value', [{ column: 'product_name', values: [''], tileIds: ['products'] }]],
    ['no value', [{ column: 'product_name', values: [], tileIds: ['products'] }]],
    ['an object value', [{ column: 'product_name', values: [{ raw: 'x' }], tileIds: ['products'] }]],
    ['a tile that is not on the page', [{ column: 'product_name', values: ['x'], tileIds: ['elsewhere'] }]],
    ['a column the page already declares', [{ column: 'region', values: ['EMEA'], tileIds: ['products'] }]],
    ['the same column twice', [
      { column: 'product_name', values: ['a'], tileIds: ['products'] },
      { column: 'PRODUCT_NAME', values: ['b'], tileIds: ['products'] },
    ]],
  ])('refuses %s', (_label, value) => {
    expect(parseDashboardViewerFilters(value, page as never).ok).toBe(false);
  });
});

describe('viewer filter tile binding', () => {
  const filters = [{ column: 'product_name', values: ['tangaroo'], tileIds: ['products'] }];

  it('binds a tile the viewer was told it narrows when its SQL proves the column', () => {
    expect(viewerFilterBindingsForBlockTile({
      tileId: 'products',
      sql: 'SELECT product_name, SUM(price) AS revenue FROM sales GROUP BY 1',
      filters,
    })).toEqual([{ filter: 'product_name', binding: 'product_name', mode: 'predicate' }]);
  });

  it('never binds a tile outside the list the viewer was shown', () => {
    expect(viewerFilterBindingsForBlockTile({
      tileId: 'trend',
      sql: 'SELECT product_name, SUM(price) AS revenue FROM sales GROUP BY 1',
      filters,
    })).toEqual([]);
  });

  it('refuses a measure even when the browser names the tile', () => {
    expect(viewerFilterBindingsForBlockTile({
      tileId: 'products',
      sql: 'SELECT region, SUM(product_name) AS product_name FROM sales GROUP BY 1',
      filters,
    })).toEqual([]);
  });

  it('accepts a computed column the block declares as a dimension', () => {
    expect(viewerFilterBindingsForBlockTile({
      tileId: 'products',
      sql: "SELECT date_trunc('month', ordered_at) AS product_name, COUNT(*) AS n FROM sales GROUP BY 1",
      declaredDimensions: ['product_name'],
      filters,
    })).toEqual([{ filter: 'product_name', binding: 'product_name', mode: 'predicate' }]);
  });
});

describe('App page run with a viewer filter', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function project(): { root: string; productsTile: string; trendTile: string } {
    const root = mkdtempSync(join(tmpdir(), 'zlens-viewer-filter-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'dql.config.json'), '{}\n');
    const blockDir = join(root, 'blocks', 'commerce');
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, 'product-revenue.dql'), `block "Product revenue" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "owner@local"
  query = """
SELECT product_name, SUM(price) AS revenue FROM sales GROUP BY 1
  """
  visualization { chart = "bar" }
}\n`);
    writeFileSync(join(blockDir, 'monthly-revenue.dql'), `block "Monthly revenue" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "owner@local"
  query = """
SELECT date_trunc('month', ordered_at) AS month, SUM(price) AS revenue FROM sales GROUP BY 1
  """
  visualization { chart = "line" }
}\n`);
    const created = createAppPackage(root, {
      name: 'Viewer Filter App',
      domain: 'commerce',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: ['Product revenue', 'Monthly revenue'],
    });
    if (!created.ok) throw new Error(created.error);
    const dashboard = JSON.parse(readFileSync(join(root, 'apps/viewer-filter-app/dashboards/overview.dqld'), 'utf-8')) as {
      layout: { items: Array<{ i: string; block?: { blockId?: string; ref?: string } }> };
    };
    const tileFor = (name: string) => dashboard.layout.items.find((item) => JSON.stringify(item.block ?? {}).includes(name))!.i;
    return { root, productsTile: tileFor('Product revenue'), trendTile: tileFor('Monthly revenue') };
  }

  async function run(root: string, body: unknown): Promise<{ status: number; payload: any; sql: string[] }> {
    const sql: string[] = [];
    const executor = {
      executeQuery: vi.fn(async (statement: string) => {
        sql.push(statement);
        return statement.includes('product_name')
          ? { columns: ['product_name', 'revenue'], rows: [{ product_name: 'tangaroo', revenue: 10 }], rowCount: 1, sql: statement }
          : { columns: ['month', 'revenue'], rows: [{ month: '2024-01-01', revenue: 99 }], rowCount: 1, sql: statement };
      }),
    } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: root,
        projectRoot: root,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/apps/viewer-filter-app/dashboards/overview/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json(), sql };
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    }
  }

  it('narrows the tiles that return the column and says which it left whole', async () => {
    const { root, productsTile, trendTile } = project();
    const { status, payload, sql } = await run(root, {
      variables: { product_name: 'tangaroo' },
      viewerFilters: [{ column: 'product_name', values: ['tangaroo'], tileIds: [productsTile] }],
    });
    expect(status, JSON.stringify(payload)).toBe(200);
    const products = payload.tiles.find((tile: { tileId: string }) => tile.tileId === productsTile);
    const trend = payload.tiles.find((tile: { tileId: string }) => tile.tileId === trendTile);
    expect(products.status).toBe('ok');
    expect(products.filters.applied).toEqual([expect.objectContaining({ filter: 'product_name', mode: 'predicate' })]);
    expect(products.artifact.sql).toContain('_dql_filter.product_name = $');
    expect(trend.status).toBe('ok');
    expect(trend.filters.applied).toEqual([]);
    expect(trend.filters.skipped).toEqual([expect.objectContaining({ filter: 'product_name' })]);
    // The value is a bound parameter, never SQL text.
    expect(sql.join('\n')).not.toContain('tangaroo');
  });

  it('runs the whole page again once the viewer filter is cleared', async () => {
    const { root, productsTile } = project();
    const { status, payload } = await run(root, { variables: {} });
    expect(status).toBe(200);
    const products = payload.tiles.find((tile: { tileId: string }) => tile.tileId === productsTile);
    expect(products.filters.applied).toEqual([]);
    expect(products.artifact.sql).not.toContain('_dql_filter');
  });

  it('refuses a malformed viewer filter instead of running unfiltered', async () => {
    const { root, productsTile } = project();
    const { status, payload } = await run(root, {
      viewerFilters: [{ column: 'product_name; DROP TABLE sales', values: ['x'], tileIds: [productsTile] }],
    });
    expect(status).toBe(400);
    expect(payload.error).toMatch(/plain result column/);
  });
});
