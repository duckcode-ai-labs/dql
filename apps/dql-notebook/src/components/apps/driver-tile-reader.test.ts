import { describe, expect, it, vi } from 'vitest';
import { appCertificationRollup } from './app-certification';
import { dashboardFilterCoverage } from './dashboard-filters';

async function notices() {
  // DashboardRenderer reads window at import, as its other tests stub it.
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  const { dashboardTileFilterNotices } = await import('./DashboardRenderer');
  return dashboardTileFilterNotices;
}

const driverTile = {
  i: 'why', x: 0, y: 0, w: 12, h: 6, sourceId: 'src', sourceRevision: 'rev', viz: { type: 'waterfall' },
  trustState: 'certified', reviewStatus: 'certified', sourceClass: 'certified_block',
  driver: { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-03-01', comparison: 'previous_period', dimensions: ['*'] },
} as never;

describe('driver tiles in the reader (RFC 0008 step 7)', () => {
  it('are filtered through their Dataset binding and count as certified Dataset tiles', async () => {
    const dashboard = {
      id: 'overview', version: 3, metadata: { title: 'Overview' },
      datasets: [{ id: 'orders', sourceId: 'src', sourceRevision: 'rev' }],
      filters: [{ id: 'region', type: 'select', datasetBindings: { orders: { field: 'region' } } }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [driverTile] },
    } as never;
    expect(dashboardFilterCoverage(dashboard, 'region').applied).toEqual(['why']);
    expect((await notices())({ item: driverTile, activeVariables: { region: 'US' } }).unfilteredNotice).toBeNull();
    // Certified when its run says the Dataset is certified; the saved document alone never is.
    expect(appCertificationRollup([driverTile]).allCertified).toBe(false);
    expect(appCertificationRollup([driverTile], 0, [{ tileId: 'why', status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'exact' } } } as never]))
      .toMatchObject({ certified: 1, total: 1, allCertified: true });
  });
});
