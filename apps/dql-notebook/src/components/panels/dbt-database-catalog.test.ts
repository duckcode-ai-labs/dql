import { describe, expect, it } from 'vitest';
import type { DbtNodeAuthoringDetail } from '@zlens/core';
import {
  databaseObjectDisplayName,
  databaseObjectNamespace,
  dbtInventoryItemToTable,
  mergeDbtAndWarehouseColumns,
  mergeDbtDatabaseObjects,
  type PhysicalDbtInventoryItem,
} from './dbt-database-catalog';

function inventoryItem(overrides: Partial<PhysicalDbtInventoryItem> = {}): PhysicalDbtInventoryItem {
  return {
    uniqueId: 'model.shop.orders',
    resourceType: 'model',
    name: 'orders',
    relation: 'ANALYTICS.COMMERCE.ORDERS',
    identityFingerprint: 'orders-fingerprint',
    available: {
      description: true,
      columns: true,
      tests: false,
      catalogTypes: true,
      dqlMeta: false,
    },
    ...overrides,
  };
}

describe('bounded dbt database catalog helpers (CTX-005, PERF-001, UI-009)', () => {
  it('maps only the dbt relation identity into the editor schema contract', () => {
    const table = dbtInventoryItemToTable(inventoryItem({
      binding: { domain: 'commerce', owner: 'analytics', status: 'certified' },
    }));

    expect(table).toMatchObject({
      name: 'ANALYTICS.COMMERCE.ORDERS',
      path: 'ANALYTICS.COMMERCE.ORDERS',
      columns: [],
      source: 'database',
      objectType: 'dbt_model',
      dbtUniqueId: 'model.shop.orders',
      governance: { domain: 'commerce', owner: 'analytics', status: 'certified' },
    });
    expect(databaseObjectDisplayName(table.path)).toBe('ORDERS');
    expect(databaseObjectNamespace(table.path)).toBe('ANALYTICS.COMMERCE');
  });

  it('appends later pages without losing columns already loaded for one relation', () => {
    const first = dbtInventoryItemToTable(inventoryItem());
    first.columns = [{ name: 'ORDER_ID', type: 'NUMBER' }];
    const refreshedFirst = dbtInventoryItemToTable(inventoryItem());
    const second = dbtInventoryItemToTable(inventoryItem({
      uniqueId: 'source.shop.customers',
      resourceType: 'source',
      name: 'customers',
      relation: 'RAW.COMMERCE.CUSTOMERS',
    }));

    expect(mergeDbtDatabaseObjects([first], [refreshedFirst, second])).toEqual([
      expect.objectContaining({ dbtUniqueId: 'model.shop.orders', columns: [{ name: 'ORDER_ID', type: 'NUMBER' }] }),
      expect.objectContaining({ dbtUniqueId: 'source.shop.customers', objectType: 'dbt_source' }),
    ]);
  });

  it('merges dbt names with physical Snowflake types from one selected relation', () => {
    const detail: DbtNodeAuthoringDetail = {
      uniqueId: 'model.shop.orders',
      name: 'orders',
      resourceType: 'model',
      relation: 'ANALYTICS.COMMERCE.ORDERS',
      columns: [
        { name: 'ORDER_ID', tests: [] },
        { name: 'AMOUNT', type: 'DECIMAL(18,2)', tests: [] },
      ],
      tests: [],
    };

    expect(mergeDbtAndWarehouseColumns(detail, [
      { name: 'order_id', type: 'NUMBER' },
      { name: 'WAREHOUSE_ONLY', type: 'TIMESTAMP_NTZ' },
    ])).toEqual([
      { name: 'ORDER_ID', type: 'NUMBER' },
      { name: 'AMOUNT', type: 'DECIMAL(18,2)' },
      { name: 'WAREHOUSE_ONLY', type: 'TIMESTAMP_NTZ' },
    ]);
  });
});
