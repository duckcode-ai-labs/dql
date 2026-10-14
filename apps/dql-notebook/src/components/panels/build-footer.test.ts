import { describe, expect, it } from 'vitest';
import { buildCatalogFooter } from './build-footer';

describe('Build sidebar status line', () => {
  it('names what each count counts instead of reporting 0 tables for a working project', () => {
    expect(buildCatalogFooter({ provider: 'dql', dbtModels: 18, warehouseTables: 12, metrics: 9 }))
      .toBe('DQL semantic layer synced · 18 dbt models · 12 warehouse tables · 9 metrics');
  });

  it('leaves out counts that have not been read yet and keeps singular nouns right', () => {
    expect(buildCatalogFooter({ provider: 'dql', dbtModels: 18, warehouseTables: 0, metrics: 9 }))
      .toBe('DQL semantic layer synced · 18 dbt models · 9 metrics');
    expect(buildCatalogFooter({ provider: 'dbt', warehouseTables: 1, metrics: 1 }))
      .toBe('dbt synced · 1 warehouse table · 1 metric');
    expect(buildCatalogFooter({ metrics: 0 })).toBe('dbt synced · 0 metrics');
  });
});
