import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DQLContext } from '../context.js';
import { getTableSchema, searchMetadata, validateSql } from '../tools/metadata.js';

function writeProject(root: string): void {
  // A dbt project config + manifest where order_items lives at dev.order_items.
  writeFileSync(
    join(root, 'dql.config.json'),
    JSON.stringify({ project: 'p', dbt: { projectDir: '.' }, dbtManifestPath: 'target/manifest.json' }),
    'utf-8',
  );
  writeFileSync(join(root, 'dbt_project.yml'), 'name: jaffle_shop\n', 'utf-8');
  mkdirSync(join(root, 'target'), { recursive: true });
  const manifest = {
    metadata: { project_name: 'jaffle_shop' },
    nodes: {
      'model.jaffle_shop.order_items': {
        resource_type: 'model',
        name: 'order_items',
        schema: 'dev',
        original_file_path: 'models/marts/order_items.sql',
        config: { materialized: 'table' },
        tags: [],
        depends_on: { nodes: ['model.jaffle_shop.stg_orders'] },
        columns: { order_id: { name: 'order_id' }, amount: { name: 'amount' } },
        meta: {},
      },
      'model.jaffle_shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        schema: 'dev',
        original_file_path: 'models/staging/stg_orders.sql',
        config: { materialized: 'view' },
        tags: [],
        depends_on: { nodes: [] },
        columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' } },
        meta: {},
      },
    },
    sources: {},
    exposures: {},
  };
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

describe('MCP grounded-SQL metadata tools (spec 15.5)', () => {
  let root: string;
  let ctx: DQLContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-metadata-'));
    writeProject(root);
    ctx = new DQLContext({ projectRoot: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('search_metadata returns qualified relations + ref forms', async () => {
    const result = await searchMetadata(ctx, { query: 'order items' });
    const orderItems = result.tables.find((t) => t.name === 'order_items')!;
    expect(orderItems.qualifiedRelation).toBe('dev.order_items');
    expect(orderItems.refForm).toBe("{{ ref('order_items') }}");
  });

  it('get_table_schema resolves a bare name to its qualified relation + join keys', () => {
    const result = getTableSchema(ctx, { table: 'order_items' });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.qualifiedRelation).toBe('dev.order_items');
      expect(result.columns.map((c) => c.name)).toContain('amount');
      expect(result.joinKeys.length).toBeGreaterThan(0);
    }
  });

  it('validate_sql passes a known relation and flags an unknown one', async () => {
    const ok = await validateSql(ctx, { sql: 'SELECT amount FROM dev.order_items' });
    expect(ok.ok).toBe(true);

    const bad = await validateSql(ctx, { sql: 'SELECT * FROM made_up_table' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('unknown_relation');
  });
});

describe('grounding tools in a database-only project (no dbt, warehouse catalog only)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-metadata-warehouse-'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'w', manifestVersion: 3, modeling: { mode: 'warehouse-first' } }), 'utf-8');
    mkdirSync(join(root, '.dql'), { recursive: true });
    writeFileSync(join(root, '.dql', 'warehouse-catalog.json'), JSON.stringify({
      version: 1,
      driver: 'duckdb',
      connectionId: 'default',
      scopes: [{ catalogOrDatabase: 'jaffle_shop', schemas: ['dev'] }],
      capturedAt: '2026-10-01T00:00:00.000Z',
      fingerprint: 'x',
      relations: [
        { id: 'warehouse.jaffle_shop.dev.orders', database: 'jaffle_shop', schema: 'dev', name: 'orders', relation: 'dev.orders', kind: 'table', primaryKey: ['order_id'], columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'location_id', type: 'VARCHAR' }, { name: 'order_total', type: 'DECIMAL' }] },
        { id: 'warehouse.jaffle_shop.dev.locations', database: 'jaffle_shop', schema: 'dev', name: 'locations', relation: 'dev.locations', kind: 'table', primaryKey: ['location_id'], columns: [{ name: 'location_id', type: 'VARCHAR' }, { name: 'location_name', type: 'VARCHAR' }] },
      ],
    }), 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('search_metadata, get_table_schema and validate_sql read the synced warehouse catalog', async () => {
    const ctx = new DQLContext({ projectRoot: root });
    const found = await searchMetadata(ctx, { query: 'orders by store location' });
    expect(found).toMatchObject({ tables: expect.arrayContaining([expect.objectContaining({ name: 'orders', qualifiedRelation: 'dev.orders' })]) });
    expect(getTableSchema(ctx, { table: 'orders' })).toMatchObject({
      found: true,
      qualifiedRelation: 'dev.orders',
      columns: expect.arrayContaining([expect.objectContaining({ name: 'location_id', type: 'VARCHAR' })]),
    });
    const valid = await validateSql(ctx, { sql: 'select location_id, sum(order_total) from dev.orders group by 1' });
    expect(valid).toMatchObject({ ok: true });
    const invalid = await validateSql(ctx, { sql: 'select nope from dev.orders' });
    expect(invalid).toMatchObject({ ok: false, offending: { column: 'nope' } });
  });

  it('says how to get a schema when there is neither a dbt manifest nor a catalog', async () => {
    rmSync(join(root, '.dql', 'warehouse-catalog.json'));
    const ctx = new DQLContext({ projectRoot: root });
    const out = await validateSql(ctx, { sql: 'select 1' });
    expect(out).toMatchObject({ ok: false, code: 'no_schema' });
    expect((out as { error: string }).error).toMatch(/zlens sync warehouse/);
  });
});
