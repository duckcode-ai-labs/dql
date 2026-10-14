import { describe, expect, it } from 'vitest';
import type { AppAnalyticalContextV1, DatasetDescriptor, TileQuery } from '@zlens/core';
import { summarizeDatasetChartFacts } from './dataset-chart-fact-summary.js';

describe('Dataset chart fact summary', () => {
  it('derives complete two-month facts and a subtotal only for a declared additive measure', () => {
    const summary = summarizeDatasetChartFacts(chartContext({
      query: monthlyRevenueQuery(),
      columns: ['order_date_month', 'revenue'],
      rows: [
        { order_date_month: '2026-02-01', revenue: 30 },
        { order_date_month: '2026-03-01', revenue: 30 },
      ],
    }), descriptor());

    expect(summary).toMatchObject({
      coverage: 'complete_grouped',
      groupCount: 2,
      derivedRollupMeasures: ['revenue'],
    });
    expect(summary.text).toContain('order_date_month = 2026-02-01: revenue = 30');
    expect(summary.text).toContain('order_date_month = 2026-03-01: revenue = 30');
    expect(summary.text).toContain('Safe additive subtotal across these displayed groups: revenue = 60.');
    expect(summary.text).not.toContain('"rows"');
  });

  it('keeps declared non-additive and ratio-like measures as per-group facts without inventing a rollup', () => {
    const summary = summarizeDatasetChartFacts(chartContext({
      query: {
        dimensions: [{ field: 'order_date', timeGrain: 'month' }],
        measures: [
          { measure: 'order_count' },
          { measure: 'margin_rate' },
          { measure: 'average_order_value' },
        ],
      },
      columns: ['order_date_month', 'order_count', 'margin_rate', 'average_order_value'],
      rows: [
        { order_date_month: '2026-02-01', order_count: 2, margin_rate: 0.5, average_order_value: 15 },
        { order_date_month: '2026-03-01', order_count: 2, margin_rate: 0.75, average_order_value: 20 },
      ],
    }), descriptor());

    expect(summary).toMatchObject({ coverage: 'complete_grouped', derivedRollupMeasures: [] });
    expect(summary.text).toContain('order_count = 2, margin_rate = 0.5, average_order_value = 15');
    expect(summary.text).toContain('order_count = 2, margin_rate = 0.75, average_order_value = 20');
    expect(summary.text).not.toContain('Safe additive subtotal');
    expect(summary.text).not.toContain('order_count = 4');
    expect(summary.text).not.toContain('margin_rate = 1.25');
    expect(summary.text).not.toContain('average_order_value = 35');
  });

  it('honors a selected dimension declared non-additive by either field name or qualified ID', () => {
    const input = {
      query: monthlyRevenueQuery(),
      columns: ['order_date_month', 'revenue'],
      rows: [
        { order_date_month: '2026-02-01', revenue: 30 },
        { order_date_month: '2026-03-01', revenue: 30 },
      ],
    };
    const additive = summarizeDatasetChartFacts(chartContext(input), descriptor());
    expect(additive).toMatchObject({ coverage: 'complete_grouped', derivedRollupMeasures: ['revenue'] });
    expect(additive.text).toContain('revenue = 60');

    for (const identity of ['order_date', 'dimension:order_date']) {
      const nonAdditive = descriptor();
      const revenue = nonAdditive.fields.find((field): field is Extract<DatasetDescriptor['fields'][number], { kind: 'measure' }> => (
        field.kind === 'measure' && field.name === 'revenue'
      ));
      expect(revenue).toBeDefined();
      revenue!.additivity = { ...revenue!.additivity, nonAdditiveDimensionIds: [identity] };

      const summary = summarizeDatasetChartFacts(chartContext(input), nonAdditive);
      expect(summary).toMatchObject({ coverage: 'complete_grouped', derivedRollupMeasures: [] });
      expect(summary.text).toContain('order_date_month = 2026-02-01: revenue = 30');
      expect(summary.text).toContain('order_date_month = 2026-03-01: revenue = 30');
      expect(summary.text).not.toContain('Safe additive subtotal');
      expect(summary.text).not.toContain('revenue = 60');
    }
  });

  it('states coverage limits instead of leaking partial, oversized, or unsafe grouping values', () => {
    const partial = summarizeDatasetChartFacts(chartContext({
      query: monthlyRevenueQuery(),
      columns: ['order_date_month', 'revenue'],
      rows: [{ order_date_month: '2026-02-01', revenue: 30 }],
      rowCount: 2,
    }), descriptor());
    expect(partial).toMatchObject({ coverage: 'incomplete', derivedRollupMeasures: [] });
    expect(partial.text).toContain('1 of 2 materialized chart groups');
    expect(partial.text).not.toContain('2026-02-01');

    const unsafe = summarizeDatasetChartFacts(chartContext({
      query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'revenue' }] },
      columns: ['customer_id', 'revenue'],
      rows: [{ customer_id: 'customer-secret', revenue: 30 }],
    }), descriptor());
    expect(unsafe).toMatchObject({ coverage: 'unsafe_group', derivedRollupMeasures: [] });
    expect(unsafe.text).not.toContain('customer-secret');

    const oversized = summarizeDatasetChartFacts(chartContext({
      query: monthlyRevenueQuery(),
      columns: ['order_date_month', 'revenue'],
      rows: Array.from({ length: 13 }, (_unused, index) => ({ order_date_month: `2026-${String(index + 1).padStart(2, '0')}-01`, revenue: 1 })),
    }), descriptor());
    expect(oversized).toMatchObject({ coverage: 'too_large', derivedRollupMeasures: [] });
    expect(oversized.text).toContain('at most 12 chart groups');
    expect(oversized.text).not.toContain('2026-01-01');

    const missing = summarizeDatasetChartFacts(chartContext({
      query: monthlyRevenueQuery(),
      columns: ['order_date_month', 'revenue'],
      rows: [{ order_date_month: '2026-02-01' }],
    }), descriptor());
    expect(missing).toMatchObject({ coverage: 'unavailable', derivedRollupMeasures: [] });
    expect(missing.text).toContain('selected measure is missing');
    expect(missing.text).not.toContain('2026-02-01');

    const limited = summarizeDatasetChartFacts(chartContext({
      query: { ...monthlyRevenueQuery(), limit: 50 },
      columns: ['order_date_month', 'revenue'],
      rows: [
        { order_date_month: '2026-02-01', revenue: 30 },
        { order_date_month: '2026-03-01', revenue: 30 },
      ],
    }), descriptor());
    expect(limited).toMatchObject({ coverage: 'complete_grouped', derivedRollupMeasures: ['revenue'] });
    expect(limited.text).toContain('saved query bounds the displayed group set');
    expect(limited.text).toContain('revenue = 60');
  });
});

function monthlyRevenueQuery(): TileQuery {
  return {
    dimensions: [{ field: 'order_date', timeGrain: 'month' }],
    measures: [{ measure: 'revenue' }],
  };
}

function descriptor(): DatasetDescriptor {
  return {
    version: 1,
    id: 'commerce.order_lines',
    kind: 'block',
    sourceRevision: 'rev-1',
    snapshotId: 'snapshot-1',
    contractRef: { kind: 'block_source', id: 'commerce.order_lines', fingerprint: 'contract-1' },
    binding: {
      sourceQualifiedId: 'commerce.order_lines',
      sourceRevision: 'rev-1',
      contractFingerprint: 'contract-1',
      state: 'valid',
      activeTargetFingerprint: 'target-1',
    },
    label: 'Order lines',
    lifecycle: 'certified',
    trust: 'certified',
    grain: {
      entityIds: ['order_line'],
      keyFields: ['order_line_id'],
      keyEvidence: 'proof-1',
      timeGrain: 'day',
      timeBucketBy: 'order_date',
    },
    fields: [
      { kind: 'physical', name: 'order_date', qualifiedId: 'dimension:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['month'], baseGrain: 'day', primary: true } },
      { kind: 'physical', name: 'customer_id', qualifiedId: 'entity:customer_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      { kind: 'measure', name: 'order_count', qualifiedId: 'measure:order_count', aggregation: 'count_distinct', from: 'order_id', dependsOn: ['order_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
      { kind: 'measure', name: 'margin_rate', qualifiedId: 'measure:margin_rate', aggregation: 'ratio', numerator: 'margin', denominator: 'net_amount', dependsOn: ['margin', 'net_amount'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['ratio'], status: 'approved' },
      { kind: 'measure', name: 'average_order_value', qualifiedId: 'measure:average_order_value', aggregation: 'avg', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['avg'], status: 'approved' },
    ],
    operations: ['filter', 'group', 'trend'],
    execution: { route: 'certified' },
  };
}

function chartContext(input: {
  query: TileQuery;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
}): AppAnalyticalContextV1 {
  return {
    version: 1,
    appId: 'app-1',
    dashboardId: 'overview',
    tileId: 'monthly-revenue',
    runId: 'run-1',
    evidenceScope: 'full_dashboard',
    snapshotId: 'snapshot-1',
    dashboardFingerprint: 'dashboard-1',
    source: { sourceId: 'commerce.order_lines', sourceRevision: 'rev-1', contractFingerprint: 'contract-1', lifecycle: 'certified', trust: 'certified', targetFingerprint: 'target-1' },
    authoredQuery: input.query,
    authoredQueryFingerprint: 'query-1',
    executionQueryFingerprint: 'query-1',
    filterFingerprint: 'filter-1',
    parameterFingerprint: 'parameter-1',
    interactionFingerprint: 'interaction-1',
    executionFingerprint: 'execution-1',
    resultFingerprint: 'result-1',
    schemaFingerprint: 'schema-1',
    personaPolicyFingerprint: 'persona-1',
    effectiveFilters: { region: 'CA' },
    appliedFilters: [{ field: 'region', op: 'eq', values: ['CA'], placement: 'where' }],
    unboundFilters: [],
    result: {
      columns: input.columns,
      rows: input.rows,
      rowCount: input.rowCount ?? input.rows.length,
    },
  };
}
