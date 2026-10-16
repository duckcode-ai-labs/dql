import { describe, expect, it } from 'vitest';
import { lineageSourcesLabel, lineageSourcesOf } from './lineage-sources';

// Node shapes as GET /api/lineage returns them for the two jaffle samples.
const dbtModel = { type: 'dbt_model', metadata: { uniqueId: 'model.jaffle_shop.order_items' } };
const dbtSource = { type: 'dbt_source', metadata: { uniqueId: 'source.jaffle_shop.ecom.raw_items' } };
const dbtEntity = { type: 'dql_entity', metadata: { dbtUniqueId: 'model.jaffle_shop.customers' } };
const warehouseEntity = { type: 'dql_entity', metadata: { dbtUniqueId: 'warehouse.dev.customers' } };
const block = { type: 'block', metadata: { filePath: 'domains/commerce/blocks/monthly_revenue.dql' } };
const domain = { type: 'domain', metadata: {} };

describe('the lineage status bar names what the graph was built from', () => {
  it('a warehouse-first project without dbt never mentions dbt (jaffle-shop-warehouse)', () => {
    const sources = lineageSourcesOf([domain, warehouseEntity, { type: 'notebook' }]);
    expect(sources).toEqual({ dbtManifest: false, warehouseCatalog: true });
    expect(lineageSourcesLabel(sources)).toBe('Compiled from the synced warehouse catalog');
    expect(lineageSourcesLabel(sources)).not.toMatch(/dbt/);
  });

  it('a dbt project names the dbt manifest (jaffle-shop-duckdb)', () => {
    const sources = lineageSourcesOf([dbtModel, dbtSource, dbtEntity, block, domain]);
    expect(lineageSourcesLabel(sources)).toBe('Compiled from the dbt manifest');
  });

  it('a hybrid project names both', () => {
    expect(lineageSourcesLabel(lineageSourcesOf([dbtModel, dbtEntity, warehouseEntity]))).toBe('Compiled from the dbt manifest and the synced warehouse catalog');
  });

  it('an entity bound to a dbt node is dbt even when no dbt node is shown', () => {
    expect(lineageSourcesOf([dbtEntity])).toEqual({ dbtManifest: true, warehouseCatalog: false });
  });

  it('a project with neither names its own files', () => {
    expect(lineageSourcesLabel(lineageSourcesOf([block, domain]))).toBe('Compiled from the project files');
  });
});
