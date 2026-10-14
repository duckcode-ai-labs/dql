import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import type { DatasetDescriptor, TileQuery } from '@zlens/core';
import { compileDatasetTileQuery } from './tile-query-compiler.js';
import { readEnv } from '@zlens/core';

/**
 * RFC 0009 step 3 exit check: every calculation, run on real DuckDB, matches
 * an independent computation from the raw rows. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT), like the other real-DuckDB tests.
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

const descriptor = {
  version: 1,
  id: 'app:block:commerce:order-lines',
  kind: 'block',
  sourceRevision: 'sha256:source',
  snapshotId: 'snapshot-1',
  contractRef: { kind: 'block_source', id: 'commerce::block::order_lines', fingerprint: 'sha256:contract' },
  binding: { sourceQualifiedId: 'commerce::block::order_lines', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract', state: 'valid' },
  label: 'Order lines',
  lifecycle: 'certified',
  trust: 'certified',
  grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof' },
  fields: [
    { kind: 'physical', name: 'order_line_id', qualifiedId: 'ol.order_line_id', type: 'string', role: 'key', status: 'approved' },
    { kind: 'physical', name: 'ordered_at', qualifiedId: 'ol.ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'month', 'quarter', 'year'], primary: true } },
    { kind: 'physical', name: 'region', qualifiedId: 'ol.region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'net_amount', qualifiedId: 'ol.net_amount', type: 'number', role: 'attribute', status: 'approved' },
    { kind: 'measure', name: 'revenue', qualifiedId: 'ol.m.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
    { kind: 'measure', name: 'orders', qualifiedId: 'ol.m.orders', aggregation: 'count_distinct', from: 'order_line_id', dependsOn: ['order_line_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'having'],
  execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

interface Line { id: string; month: string; region: string; amount: number }

/** 18 months × 3 regions, uneven lines per month; EU has no March 2025. */
function lines(): Line[] {
  const out: Line[] = [];
  const regions = ['US', 'EU', 'APAC'];
  let id = 0;
  for (let index = 0; index < 18; index += 1) {
    const year = 2025 + Math.floor(index / 12);
    const month = `${year}-${String((index % 12) + 1).padStart(2, '0')}`;
    regions.forEach((region, r) => {
      if (region === 'EU' && month === '2025-03') return;
      const count = 1 + ((index + r) % 3);
      for (let line = 0; line < count; line += 1) {
        id += 1;
        out.push({ id: `OL-${id}`, month, region, amount: 10 + ((index * 7 + r * 13 + line * 5) % 40) });
      }
    });
  }
  return out;
}

describe('tile calculations on real DuckDB', () => {
  duckDbIt('match an independent computation from the raw rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-tile-calcs-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(root, 'calcs.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    try {
      const data = lines();
      await executor.executeQuery('CREATE TABLE order_lines (order_line_id VARCHAR, ordered_at TIMESTAMP, region VARCHAR, net_amount DOUBLE)', [], {}, connection);
      await executor.executeQuery(
        `INSERT INTO order_lines VALUES ${data.map((line) => `('${line.id}', TIMESTAMP '${line.month}-15 10:00:00', '${line.region}', ${line.amount})`).join(', ')}`,
        [], {}, connection,
      );

      const query: TileQuery = {
        dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }],
        measures: [{ measure: 'revenue' }, { measure: 'orders' }],
        calculations: [
          { id: 'per_order', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'orders' } } },
          { id: 'us_only', expr: { measure: 'revenue', where: [{ field: 'region', op: 'eq', values: ['US'] }] } },
          { id: 'less_ten', expr: { op: '-', left: { measure: 'revenue' }, right: { number: 10 } } },
          { id: 'share', quick: { kind: 'percent_of_total', of: 'revenue' } },
          { id: 'share_in_month', quick: { kind: 'percent_of_total', of: 'revenue', within: 'ordered_at_month' } },
          { id: 'running', quick: { kind: 'running_total', of: 'revenue' } },
          { id: 'change', quick: { kind: 'difference', of: 'revenue' } },
          { id: 'change_pct', quick: { kind: 'percent_difference', of: 'revenue' } },
          { id: 'place', quick: { kind: 'rank', of: 'revenue', within: 'ordered_at_month' } },
          { id: 'avg3', quick: { kind: 'moving_average', of: 'revenue' } },
          { id: 'yoy', quick: { kind: 'year_over_year', of: 'revenue' } },
          { id: 'per_order_change', quick: { kind: 'difference', of: 'per_order' } },
        ],
      };
      const compiled = compileDatasetTileQuery({ descriptor, query, driver: 'duckdb', sourceSql: 'SELECT * FROM order_lines' });
      const result = await executor.executeQuery(compiled.sql, compiled.sqlParams, compiled.variables, connection);

      // Independent computation from the raw lines.
      const groups = new Map<string, { region: string; month: string; revenue: number; orders: number }>();
      for (const line of data) {
        const key = `${line.region}|${line.month}`;
        const group = groups.get(key) ?? { region: line.region, month: line.month, revenue: 0, orders: 0 };
        group.revenue += line.amount;
        group.orders += 1;
        groups.set(key, group);
      }
      const total = [...groups.values()].reduce((sum, group) => sum + group.revenue, 0);
      const series = (region: string) => [...groups.values()].filter((group) => group.region === region).sort((a, b) => a.month.localeCompare(b.month));
      const monthTotal = (month: string) => [...groups.values()].filter((group) => group.month === month).reduce((sum, group) => sum + group.revenue, 0);

      expect(result.rows).toHaveLength(groups.size);
      for (const row of result.rows as Array<Record<string, unknown>>) {
        const month = new Date(String(row.ordered_at_month instanceof Date ? row.ordered_at_month.toISOString() : row.ordered_at_month)).toISOString().slice(0, 7);
        const region = String(row.region);
        const group = groups.get(`${region}|${month}`)!;
        const history = series(region);
        const position = history.findIndex((entry) => entry.month === month);
        const previous = position > 0 ? history[position - 1]! : undefined;
        const lastYear = history.find((entry) => entry.month === `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`);
        const window = history.slice(Math.max(0, position - 2), position + 1);
        const peers = [...groups.values()].filter((entry) => entry.month === month);
        const label = `${region} ${month}`;

        expect(Number(row.revenue), label).toBeCloseTo(group.revenue, 9);
        expect(Number(row.per_order), label).toBeCloseTo(group.revenue / group.orders, 9);
        if (region === 'US') expect(Number(row.us_only), label).toBeCloseTo(group.revenue, 9);
        else expect(row.us_only, label).toBeNull();
        expect(Number(row.less_ten), label).toBeCloseTo(group.revenue - 10, 9);
        expect(Number(row.share), label).toBeCloseTo(group.revenue / total, 12);
        expect(Number(row.share_in_month), label).toBeCloseTo(group.revenue / monthTotal(month), 12);
        expect(Number(row.running), label).toBeCloseTo(history.slice(0, position + 1).reduce((sum, entry) => sum + entry.revenue, 0), 9);
        if (previous) {
          expect(Number(row.change), label).toBeCloseTo(group.revenue - previous.revenue, 9);
          expect(Number(row.change_pct), label).toBeCloseTo((group.revenue - previous.revenue) / Math.abs(previous.revenue), 12);
          expect(Number(row.per_order_change), label).toBeCloseTo(group.revenue / group.orders - previous.revenue / previous.orders, 9);
        } else {
          expect(row.change, label).toBeNull();
          expect(row.change_pct, label).toBeNull();
        }
        expect(Number(row.place), label).toBe(1 + peers.filter((entry) => entry.revenue > group.revenue).length);
        expect(Number(row.avg3), label).toBeCloseTo(window.reduce((sum, entry) => sum + entry.revenue, 0) / window.length, 9);
        if (lastYear) expect(Number(row.yoy), label).toBeCloseTo((group.revenue - lastYear.revenue) / Math.abs(lastYear.revenue), 12);
        else expect(row.yoy, label).toBeNull();
      }
      // EU has no March 2025, so its March 2026 has nothing to compare with — never a shifted month.
      const euMarch = (result.rows as Array<Record<string, unknown>>).find((row) => row.region === 'EU' && new Date(String(row.ordered_at_month instanceof Date ? row.ordered_at_month.toISOString() : row.ordered_at_month)).toISOString().startsWith('2026-03'));
      expect(euMarch?.yoy).toBeNull();

      // A share of the total stays a share of every group when only the top rows are shown.
      const top = compileDatasetTileQuery({
        descriptor,
        query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], calculations: [{ id: 'share', quick: { kind: 'percent_of_total', of: 'revenue' } }], orderBy: [{ alias: 'revenue', direction: 'desc' }], limit: 1 },
        driver: 'duckdb',
        sourceSql: 'SELECT * FROM order_lines',
      });
      const topResult = await executor.executeQuery(top.sql, top.sqlParams, top.variables, connection);
      const byRegion = ['US', 'EU', 'APAC'].map((region) => ({ region, revenue: data.filter((line) => line.region === region).reduce((sum, line) => sum + line.amount, 0) })).sort((a, b) => b.revenue - a.revenue);
      expect(topResult.rows).toHaveLength(1);
      expect(Number((topResult.rows[0] as Record<string, unknown>).share)).toBeCloseTo(byRegion[0]!.revenue / total, 12);
    } finally {
      await executor.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  duckDbIt('recompute pivot totals in the warehouse, so a distinct count total is not a sum of cells', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-tile-totals-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(root, 'totals.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    try {
      await executor.executeQuery('CREATE TABLE order_lines (order_line_id VARCHAR, ordered_at TIMESTAMP, region VARCHAR, customer_id VARCHAR, net_amount DOUBLE)', [], {}, connection);
      // Customers C1 and C2 buy in both regions and both months.
      const lines = [
        ['OL-1', '2026-01-10', 'US', 'C1', 10], ['OL-2', '2026-01-11', 'US', 'C2', 20], ['OL-3', '2026-02-10', 'US', 'C1', 30],
        ['OL-4', '2026-01-12', 'EU', 'C1', 5], ['OL-5', '2026-02-12', 'EU', 'C2', 15], ['OL-6', '2026-02-13', 'EU', 'C3', 25],
      ] as const;
      await executor.executeQuery(`INSERT INTO order_lines VALUES ${lines.map(([id, at, region, customer, amount]) => `('${id}', TIMESTAMP '${at} 09:00:00', '${region}', '${customer}', ${amount})`).join(', ')}`, [], {}, connection);
      const withCustomers = {
        ...descriptor,
        fields: [
          ...descriptor.fields,
          { kind: 'physical', name: 'customer_id', qualifiedId: 'ol.customer_id', type: 'string', role: 'dimension', status: 'approved' },
          { kind: 'measure', name: 'customers', qualifiedId: 'ol.m.customers', aggregation: 'count_distinct', from: 'customer_id', dependsOn: ['customer_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
        ],
      } as unknown as DatasetDescriptor;
      const compiled = compileDatasetTileQuery({
        descriptor: withCustomers,
        query: {
          dimensions: [{ field: 'region' }, { field: 'ordered_at', timeGrain: 'month' }],
          measures: [{ measure: 'revenue' }, { measure: 'customers' }],
          calculations: [{ id: 'per_customer', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'customers' } } }],
          rollups: [['region'], ['ordered_at_month'], []],
        },
        driver: 'duckdb',
        sourceSql: 'SELECT * FROM order_lines',
      });
      const result = await executor.executeQuery(compiled.sql, compiled.sqlParams, compiled.variables, connection);
      const rows = result.rows as Array<Record<string, unknown>>;
      const find = (region: string | null, month: string | null) => rows.find((row) => {
        const rowMonth = row.ordered_at_month === null ? null : new Date(String(row.ordered_at_month instanceof Date ? row.ordered_at_month.toISOString() : row.ordered_at_month)).toISOString().slice(0, 7);
        const regionTotal = Number(row.__total_region) === 1;
        const monthTotal = Number(row.__total_ordered_at_month) === 1;
        return (region === null ? regionTotal : !regionTotal && row.region === region) && (month === null ? monthTotal : !monthTotal && rowMonth === month);
      });
      // 4 cells, 2 region totals, 2 month totals, 1 grand total.
      expect(rows).toHaveLength(9);
      expect(Number(find('US', '2026-01')?.customers)).toBe(2);
      expect(Number(find('US', null)?.customers)).toBe(2);
      expect(Number(find('EU', null)?.customers)).toBe(3);
      // Summing the region totals would say 5; the warehouse counts 3 customers.
      expect(Number(find(null, null)?.customers)).toBe(3);
      expect(Number(find(null, null)?.revenue)).toBe(105);
      expect(Number(find(null, '2026-02')?.customers)).toBe(3);
      // A ratio's total is the ratio of totals, not an average of ratios.
      expect(Number(find(null, null)?.per_customer)).toBeCloseTo(105 / 3, 9);
    } finally {
      await executor.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
