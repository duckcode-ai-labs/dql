import { describe, expect, it, vi } from 'vitest';

async function load() {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  return import('./DashboardRenderer');
}

describe('a dashboard asks for a story only for a settled run', () => {
  it('a complete run is settled', async () => {
    const { dashboardRunIsSettled } = await load();
    expect(dashboardRunIsSettled({ partial: false, incomplete: false })).toBe(true);
    expect(dashboardRunIsSettled({})).toBe(true);
  });

  it('a stale, partial or incomplete run is not (a stale run records no evidence; its story is a 404)', async () => {
    const { dashboardRunIsSettled } = await load();
    expect(dashboardRunIsSettled({ stale: true })).toBe(false);
    expect(dashboardRunIsSettled({ partial: true })).toBe(false);
    expect(dashboardRunIsSettled({ incomplete: true })).toBe(false);
    expect(dashboardRunIsSettled(null)).toBe(false);
    expect(dashboardRunIsSettled(undefined)).toBe(false);
  });
});
