import { describe, expect, it } from 'vitest';
import type { DashboardDriverDefinition, DatasetDescriptor } from '@zlens/core';
import { buildDatasetComparisonPlan } from './period-comparison.js';
import { foldDriverAnalysis, planDriverQueries } from './driver-analysis.js';
import { calendarComparisonBounds } from '../analytical-period-resolution.js';

const descriptor: DatasetDescriptor = {
  version: 1,
  id: 'app:block:commerce:orders',
  kind: 'block',
  sourceRevision: 'sha256:source-v1',
  snapshotId: 'snapshot-1',
  contractRef: { kind: 'block_source', id: 'commerce::block::orders', fingerprint: 'sha256:contract-v1' },
  binding: { sourceQualifiedId: 'commerce::block::orders', sourceRevision: 'sha256:source-v1', contractFingerprint: 'sha256:contract-v1', state: 'valid' },
  label: 'Orders',
  lifecycle: 'certified',
  trust: 'certified',
  grain: { entityIds: ['commerce:entity:order_line'], keyFields: ['order_line_id'] },
  fields: [
    { kind: 'physical', name: 'order_line_id', qualifiedId: 'commerce:field:order_line_id', type: 'string', role: 'key', status: 'approved' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'commerce:field:order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'physical', name: 'region', qualifiedId: 'commerce:field:region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'channel', qualifiedId: 'commerce:field:channel', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'net_amount', qualifiedId: 'commerce:field:net_amount', type: 'number', role: 'attribute', status: 'approved' },
    {
      kind: 'measure', name: 'revenue', qualifiedId: 'commerce:measure:revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'],
      additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
    },
  ],
  operations: ['filter', 'group', 'trend', 'compare', 'having'],
  execution: { route: 'governed_sql' },
};

const definition: DashboardDriverDefinition = {
  version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-03-01', comparison: 'previous_period',
  dimensions: ['region', 'channel', 'order_date', 'missing'], timezone: 'UTC',
};

describe('driver analysis (RFC 0008 step 7)', () => {
  it('works out the exact period bounds for the anchor and the period before it', () => {
    expect(calendarComparisonBounds({ anchor: '2026-03-15', grain: 'month', timezone: 'UTC', comparison: 'previous_period' })).toEqual({
      current: { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' },
      prior: { start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' },
    });
    expect(calendarComparisonBounds({ anchor: '2026-03-15', grain: 'month', timezone: 'America/Chicago', comparison: 'previous_year' })?.prior.start).toBe('2025-03-01T06:00:00.000Z');
    expect(calendarComparisonBounds({ anchor: '2026-13-01', grain: 'month', timezone: 'UTC', comparison: 'previous_period' })).toBeUndefined();
    expect(calendarComparisonBounds({ anchor: '2026-03-01', grain: 'month', timezone: 'Not/AZone', comparison: 'previous_period' })).toBeUndefined();
  });

  it('plans one governed comparison per usable dimension and says why others were left out', () => {
    const planned = planDriverQueries(definition, descriptor);
    expect(planned.status).toBe('ready');
    if (planned.status !== 'ready') return;
    expect(planned.plan.dimensions.map((entry) => entry.field)).toEqual(['region', 'channel']);
    expect(planned.plan.skipped.map((entry) => entry.field)).toEqual(['order_date', 'missing']);
    expect(planned.plan.additivity).toBe('additive');
    // Every planned query passes the same governed comparison planner the tiles use.
    for (const query of [planned.plan.total, ...planned.plan.dimensions.map((entry) => entry.query)]) {
      expect(buildDatasetComparisonPlan({ descriptor, query, snapshotId: 'snapshot-1', referenceInstant: '2026-09-23T00:00:00.000Z' }).status).toBe('ready');
    }
  });

  it('uses the Dataset\'s approved dimensions when asked for all of them', () => {
    const planned = planDriverQueries({ ...definition, dimensions: ['*'] }, descriptor);
    expect(planned.status === 'ready' && planned.plan.dimensions.map((entry) => entry.field)).toEqual(['region', 'channel']);
  });

  it('refuses a measure or grain the Dataset does not approve', () => {
    expect(planDriverQueries({ ...definition, measure: 'margin' }, descriptor).status).toBe('blocked');
    expect(planDriverQueries({ ...definition, grain: 'quarter' }, descriptor).status).toBe('blocked');
    expect(planDriverQueries({ ...definition, dimensions: ['order_date'] }, descriptor).status).toBe('blocked');
  });

  it('splits the change by member, ranks the sharper dimension first, and reconciles', () => {
    const planned = planDriverQueries(definition, descriptor);
    if (planned.status !== 'ready') throw new Error('plan');
    const row = (member: string, current: number, prior: number) => ({ member, value__current_period: current, value__comparison_period: prior, value__delta__comparison_period: current - prior });
    const analysis = foldDriverAnalysis({
      definition,
      plan: planned.plan,
      totalRows: [{ value__current_period: 90, value__comparison_period: 120, value__delta__comparison_period: -30 }],
      dimensionResults: [
        { field: 'region', rows: [row('US', 60, 60), row('EU', 30, 60)] },
        { field: 'channel', rows: [row('web', 50, 65), row('store', 40, 55)] },
      ],
    });
    expect(analysis.headline).toMatchObject({ current: '90', prior: '120', delta: '-30' });
    expect(analysis.dimensions.map((dimension) => dimension.field)).toEqual(['region', 'channel']);
    const region = analysis.dimensions[0]!;
    expect(region.reconciles).toBe(true);
    expect(region.concentration).toBe(1);
    expect(region.members[0]).toMatchObject({ label: 'EU', delta: '-30', role: 'driver' });
    expect(analysis.unavailable.map((entry) => entry.field)).toEqual(['order_date', 'missing']);
    expect(analysis.summary).toBe('Revenue fell by 30. The largest move was EU (region): −30, 100% of the change.');
  });

  it('folds a long tail into Other and reports a failed dimension without inventing numbers', () => {
    const planned = planDriverQueries({ ...definition, dimensions: ['region', 'channel'] }, descriptor);
    if (planned.status !== 'ready') throw new Error('plan');
    const members = Array.from({ length: 9 }, (_, index) => ({ member: `m${index}`, value__current_period: 10 + index, value__comparison_period: 10 }));
    const analysis = foldDriverAnalysis({
      definition,
      plan: planned.plan,
      totalRows: [{ value__current_period: members.reduce((sum, member) => sum + member.value__current_period, 0), value__comparison_period: 90 }],
      dimensionResults: [{ field: 'region', rows: members }, { field: 'channel', error: 'The warehouse timed out.' }],
    });
    const region = analysis.dimensions[0]!;
    expect(region.members).toHaveLength(7);
    expect(region.members.at(-1)).toMatchObject({ label: 'Other (3)', other: true });
    expect(region.memberCount).toBe(9);
    expect(analysis.unavailable).toEqual([{ field: 'channel', reason: 'its breakdown query did not run', detail: 'The warehouse timed out.' }]);
  });

  it('says so once when the comparison period has no data', () => {
    const planned = planDriverQueries(definition, descriptor);
    if (planned.status !== 'ready') throw new Error('plan');
    const analysis = foldDriverAnalysis({
      definition,
      plan: planned.plan,
      totalRows: [{ value__current_period: 40, value__comparison_period: null }],
      dimensionResults: [{ field: 'region', error: 'Source source:comparison_period is missing required outputs.' }],
    });
    expect(analysis.missingPeriod).toBe('prior');
    expect(analysis.dimensions).toEqual([]);
    expect(analysis.unavailable.map((entry) => entry.field)).toEqual(['order_date', 'missing']);
    expect(analysis.summary).toBe('There is no revenue in the comparison period, so there is no change to split.');
  });
});
