import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor, TileQuery } from '@zlens/core';
import {
  buildDatasetComparisonPlan,
  executeDatasetComparisonPlan,
} from './period-comparison.js';

function descriptor(kind: 'block' | 'semantic' = 'block'): DatasetDescriptor {
  return {
    version: 1,
    id: kind === 'block' ? 'app:block:commerce:orders' : 'app:semantic:commerce:orders',
    kind,
    sourceRevision: 'sha256:source-v1',
    snapshotId: 'snapshot-1',
    contractRef: {
      kind: kind === 'block' ? 'block_source' : 'semantic_model',
      id: kind === 'block' ? 'commerce::block::orders' : 'semantic:commerce:model:orders',
      fingerprint: 'sha256:contract-v1',
    },
    binding: {
      sourceQualifiedId: kind === 'block' ? 'commerce::block::orders' : 'semantic:commerce:model:orders',
      sourceRevision: 'sha256:source-v1',
      contractFingerprint: 'sha256:contract-v1',
      state: 'valid',
    },
    label: 'Orders',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['commerce:entity:order_line'], keyFields: ['order_line_id'] },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'commerce:field:order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'commerce:field:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      { kind: 'physical', name: 'region', qualifiedId: 'commerce:field:region', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'net_amount', qualifiedId: 'commerce:field:net_amount', type: 'number', role: 'attribute', status: 'approved' },
      {
        kind: 'measure',
        name: 'revenue',
        qualifiedId: 'commerce:measure:revenue',
        ...(kind === 'semantic' ? { metricId: 'semantic:commerce:metric:revenue', semanticReference: 'revenue' } : {}),
        aggregation: 'sum',
        from: 'net_amount',
        dependsOn: ['net_amount'],
        additivity: { entities: 'additive', time: 'additive' },
        allowedAggs: ['sum'],
        format: { kind: 'currency', currency: 'USD' },
        status: 'approved',
      },
    ],
    operations: ['filter', 'group', 'trend', 'compare', 'having'],
    execution: kind === 'semantic' ? { route: 'semantic', adapterId: 'native' } : { route: 'governed_sql' },
  };
}

function comparisonQuery(overrides: Partial<TileQuery> = {}): TileQuery {
  return {
    dimensions: [],
    measures: [{ measure: 'revenue' }],
    comparison: {
      version: 1,
      timeField: 'order_date',
      timeRole: 'event_time',
      calendarId: 'calendar:gregorian',
      timezone: 'America/Chicago',
      grain: 'month',
      completenessPolicy: 'closed_period',
      periods: [
        { id: 'feb_2026', kind: 'absolute', start: '2026-02-01T06:00:00.000Z', end: '2026-03-01T06:00:00.000Z' },
        { id: 'jan_2026', kind: 'absolute', start: '2026-01-01T06:00:00.000Z', end: '2026-02-01T06:00:00.000Z' },
      ],
      basePeriodId: 'feb_2026',
      comparisonPeriodIds: ['jan_2026'],
      alignment: 'calendar_period',
      outputs: ['value', 'absolute_delta', 'percent_delta'],
      zeroDenominatorPolicy: 'null',
    },
    ...overrides,
  };
}

function plan(query = comparisonQuery(), kind: 'block' | 'semantic' = 'block') {
  return buildDatasetComparisonPlan({
    descriptor: descriptor(kind),
    query,
    snapshotId: 'snapshot-1',
    referenceInstant: '2026-03-15T12:00:00.000Z',
  });
}

describe('Dataset period comparison bridge', () => {
  it('maps explicit governed periods through compatibility, resolution, and the decimal execution graph', () => {
    const built = plan();
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;

    expect(built.frame.timeContext?.periods).toEqual([
      expect.objectContaining({ id: 'feb_2026', start: '2026-02-01T06:00:00.000Z', end: '2026-03-01T06:00:00.000Z' }),
      expect.objectContaining({ id: 'jan_2026', start: '2026-01-01T06:00:00.000Z', end: '2026-02-01T06:00:00.000Z' }),
    ]);
    expect(built.graph.nodes.map((node) => node.kind)).toEqual([
      'source_invocation',
      'source_invocation',
      'align_periods',
      'calculate_comparison',
      'project_validate',
    ]);
    expect(built.periodQueries).toEqual([
      expect.objectContaining({
        periodId: 'feb_2026',
        outputAlias: 'revenue__feb_2026',
        query: expect.objectContaining({
          comparison: undefined,
          orderBy: undefined,
          limit: undefined,
          filters: expect.arrayContaining([
            { field: 'order_date', op: 'gte', values: ['2026-02-01'] },
            { field: 'order_date', op: 'lt', values: ['2026-03-01'] },
          ]),
        }),
      }),
      expect.objectContaining({ periodId: 'jan_2026', outputAlias: 'revenue__jan_2026' }),
    ]);

    const result = executeDatasetComparisonPlan({
      plan: built,
      sourceResults: {
        'source:feb_2026': {
          columns: ['revenue__feb_2026'],
          rows: [{ revenue__feb_2026: '30' }],
          receiptFingerprint: 'receipt-feb',
        },
        'source:jan_2026': {
          columns: ['revenue__jan_2026'],
          rows: [{ revenue__jan_2026: '60' }],
          receiptFingerprint: 'receipt-jan',
        },
      },
    });
    expect(result).toMatchObject({
      status: 'completed',
      columns: ['revenue__feb_2026', 'revenue__jan_2026', 'revenue__delta__jan_2026', 'revenue__percent_delta__jan_2026'],
      rows: [{
        revenue__feb_2026: '30',
        revenue__jan_2026: '60',
        revenue__delta__jan_2026: '-30',
        revenue__percent_delta__jan_2026: '-50',
      }],
    });
  });

  it('preserves missing versus observed-zero comparison values and zero-denominator policy', () => {
    const built = plan();
    if (built.status !== 'ready') throw new Error(built.reason);
    const zero = executeDatasetComparisonPlan({
      plan: built,
      sourceResults: {
        'source:feb_2026': { columns: ['revenue__feb_2026'], rows: [{ revenue__feb_2026: '10' }], receiptFingerprint: 'receipt-feb' },
        'source:jan_2026': { columns: ['revenue__jan_2026'], rows: [{ revenue__jan_2026: '0' }], receiptFingerprint: 'receipt-jan' },
      },
    });
    expect(zero).toMatchObject({
      status: 'completed',
      rows: [{ revenue__delta__jan_2026: '10', revenue__percent_delta__jan_2026: null }],
    });

    const missing = executeDatasetComparisonPlan({
      plan: built,
      sourceResults: {
        'source:feb_2026': { columns: ['revenue__feb_2026'], rows: [{ revenue__feb_2026: '10' }], receiptFingerprint: 'receipt-feb' },
        'source:jan_2026': { columns: ['revenue__jan_2026'], rows: [], receiptFingerprint: 'receipt-jan' },
      },
    });
    expect(missing).toMatchObject({
      status: 'completed',
      rows: [{ revenue__jan_2026: null, revenue__delta__jan_2026: null, revenue__percent_delta__jan_2026: null }],
    });
  });

  it('refuses output-truncating comparison query shapes and retains the exact semantic adapter identity', () => {
    expect(plan(comparisonQuery({ limit: 5 }))).toMatchObject({
      status: 'blocked',
      code: 'COMPARISON_QUERY_UNSUPPORTED',
    });
    expect(plan(comparisonQuery({ dimensions: [{ field: 'order_date', timeGrain: 'month' }] }))).toMatchObject({
      status: 'blocked',
      code: 'COMPARISON_QUERY_UNSUPPORTED',
    });
    const semantic = plan(comparisonQuery(), 'semantic');
    expect(semantic).toMatchObject({
      status: 'ready',
      graph: { route: 'semantic', adapterId: 'native' },
    });
  });

  it('preserves local calendar dates for DATE fields while retaining exact instants for timestamps', () => {
    const auckland = comparisonQuery({
      comparison: {
        ...comparisonQuery().comparison!,
        timezone: 'Pacific/Auckland',
        periods: [
          { id: 'march', kind: 'absolute', start: '2026-02-28T11:00:00.000Z', end: '2026-03-31T11:00:00.000Z' },
          { id: 'february', kind: 'absolute', start: '2026-01-31T11:00:00.000Z', end: '2026-02-28T11:00:00.000Z' },
        ],
        basePeriodId: 'march',
        comparisonPeriodIds: ['february'],
      },
    });
    const datePlan = plan(auckland);
    expect(datePlan).toMatchObject({ status: 'ready' });
    if (datePlan.status !== 'ready') return;
    expect(datePlan.periodQueries[0]?.query.filters).toEqual(expect.arrayContaining([
      { field: 'order_date', op: 'gte', values: ['2026-03-01'] },
      { field: 'order_date', op: 'lt', values: ['2026-04-01'] },
    ]));

    const timestampDescriptor = descriptor();
    timestampDescriptor.fields = timestampDescriptor.fields.map((field) => field.kind === 'physical' && field.name === 'order_date'
      ? { ...field, type: 'timestamp' as const }
      : field);
    const timestampPlan = buildDatasetComparisonPlan({
      descriptor: timestampDescriptor,
      query: auckland,
      snapshotId: 'snapshot-1',
      referenceInstant: '2026-03-15T12:00:00.000Z',
    });
    expect(timestampPlan).toMatchObject({ status: 'ready' });
    if (timestampPlan.status !== 'ready') return;
    expect(timestampPlan.periodQueries[0]?.query.filters).toEqual(expect.arrayContaining([
      { field: 'order_date', op: 'gte', values: ['2026-02-28T11:00:00.000Z'] },
      { field: 'order_date', op: 'lt', values: ['2026-03-31T11:00:00.000Z'] },
    ]));
  });
});
