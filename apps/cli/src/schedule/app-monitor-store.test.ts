import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAppDocument } from '@zlens/core';
import { addPageMonitor, listPageMonitors, MonitorStoreError, removePageMonitor } from './app-monitor-store.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-monitor-store-'));
  roots.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
};
const appPath = (root: string) => join(root, 'apps/commerce-pilot/dql.app.json');

describe('page alerts stored in dql.app.json (RFC 0008 step 10)', () => {
  it('creates an alerts-only schedule for a page without one, keeping the rest of the file', () => {
    const root = project();
    const before = JSON.parse(readFileSync(appPath(root), 'utf8'));
    const added = addPageMonitor(root, 'commerce-pilot', {
      dashboardId: 'overview',
      binding: 'order-lines-dataset-kpi.revenue',
      when: { kind: 'threshold', op: '<', value: 100 },
      label: 'Revenue below plan',
      deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/x' }],
    });
    expect(added).toMatchObject({ scheduleId: 'alerts-overview', createdSchedule: true });
    const after = JSON.parse(readFileSync(appPath(root), 'utf8'));
    // Nothing else in the App changed.
    expect({ ...after, schedules: undefined }).toEqual({ ...before, schedules: undefined });
    expect(after.schedules).toEqual([{
      id: 'alerts-overview',
      cron: '0 8 * * *',
      dashboard: 'overview',
      deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/x' }],
      digest: false,
      description: 'Alerts for this page. Speaks only when a monitor fires.',
      monitors: [{ id: added.monitor.id, binding: 'order-lines-dataset-kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 }, label: 'Revenue below plan' }],
    }]);
    expect(loadAppDocument(appPath(root)).errors).toEqual([]);
    expect(listPageMonitors(root, 'commerce-pilot', 'overview')).toEqual([expect.objectContaining({ id: 'alerts-overview', digest: false, monitors: [expect.objectContaining({ label: 'Revenue below plan' })] })]);
    expect(listPageMonitors(root, 'commerce-pilot', 'order-detail')).toEqual([]);
  });

  it('adds to the page’s existing schedule, refuses duplicates and bad conditions, and removes', () => {
    const root = project();
    const app = JSON.parse(readFileSync(appPath(root), 'utf8'));
    app.schedules = [{ id: 'weekly', cron: '0 8 * * 1', dashboard: 'overview', deliver: [] }];
    writeFileSync(appPath(root), JSON.stringify(app, null, 2));
    const input = { dashboardId: 'overview', binding: 'order-lines-dataset-kpi-2.order_count', when: { kind: 'change', direction: 'down', percent: 20 } };
    const added = addPageMonitor(root, 'commerce-pilot', input);
    expect(added).toMatchObject({ scheduleId: 'weekly', createdSchedule: false });
    expect(() => addPageMonitor(root, 'commerce-pilot', input)).toThrow('already exists');
    expect(() => addPageMonitor(root, 'commerce-pilot', { ...input, when: { kind: 'change', direction: 'down', percent: -5 } })).toThrow(MonitorStoreError);
    expect(() => addPageMonitor(root, 'missing-app', input)).toThrow('not found');

    removePageMonitor(root, 'commerce-pilot', 'weekly', added.monitor.id);
    const after = JSON.parse(readFileSync(appPath(root), 'utf8'));
    expect(after.schedules).toEqual([{ id: 'weekly', cron: '0 8 * * 1', dashboard: 'overview', deliver: [] }]);
    expect(() => removePageMonitor(root, 'commerce-pilot', 'weekly', added.monitor.id)).toThrow('No alert');
  });
});
