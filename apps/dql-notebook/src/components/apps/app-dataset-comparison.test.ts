import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import {
  buildDatasetComparison,
  comparisonDateInput,
  datasetComparisonDraftFromQuery,
  datasetComparisonSummary,
  datasetComparisonTimeFields,
  defaultDatasetComparisonDraft,
} from './app-dataset-comparison';

function descriptor(operations: DatasetDescriptor['operations'] = ['filter', 'group', 'compare']): DatasetDescriptor {
  return {
    version: 1,
    id: 'app:block:commerce:orders', kind: 'block', sourceRevision: 'sha256:orders', snapshotId: 'snapshot-1',
    contractRef: { kind: 'block_source', id: 'commerce::orders', fingerprint: 'sha256:contract' },
    binding: { sourceQualifiedId: 'commerce::orders', sourceRevision: 'sha256:orders', contractFingerprint: 'sha256:contract', state: 'valid' },
    label: 'Orders', lifecycle: 'certified', trust: 'certified',
    grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
    fields: [
      { kind: 'physical', name: 'order_line_id', qualifiedId: 'field:order_line_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'order_date', qualifiedId: 'field:order_date', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
      { kind: 'measure', name: 'revenue', qualifiedId: 'measure:revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
    ],
    operations,
    execution: { route: 'governed_sql' },
  };
}

describe('Dataset comparison authoring controls (APP-060)', () => {
  it('persists exact IANA-zone start-inclusive/end-exclusive month bounds', () => {
    const result = buildDatasetComparison(descriptor(), {
      ...defaultDatasetComparisonDraft(descriptor()),
      timezone: 'America/Chicago', grain: 'month',
      baseStart: '2026-03-01', baseEnd: '2026-04-01',
      comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    });
    expect(result).toMatchObject({
      status: 'ready',
      comparison: {
        timeField: 'order_date', timeRole: 'event_time', calendarId: 'calendar:gregorian', timezone: 'America/Chicago', grain: 'month',
        periods: [
          { id: 'current_period', start: '2026-03-01T06:00:00.000Z', end: '2026-04-01T05:00:00.000Z' },
          { id: 'comparison_period', start: '2026-02-01T06:00:00.000Z', end: '2026-03-01T06:00:00.000Z' },
        ],
      },
    });
    expect(comparisonDateInput('2026-04-01T05:00:00.000Z', 'America/Chicago')).toBe('2026-04-01');
  });

  it('refuses unsupported comparison time fields, invalid dates, and unknown time zones', () => {
    expect(datasetComparisonTimeFields(descriptor(['filter', 'group']))).toEqual([]);
    expect(buildDatasetComparison(descriptor(), {
      ...defaultDatasetComparisonDraft(descriptor()),
      timeField: 'order_line_id', baseStart: '2026-03-01', baseEnd: '2026-04-01', comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    })).toMatchObject({ status: 'blocked', message: expect.stringContaining('approved time field') });
    expect(buildDatasetComparison(descriptor(), {
      ...defaultDatasetComparisonDraft(descriptor()),
      timezone: 'not/a-timezone', baseStart: '2026-03-01', baseEnd: '2026-04-01', comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    })).toMatchObject({ status: 'blocked', message: expect.stringContaining('IANA time zone') });
    expect(buildDatasetComparison(descriptor(), {
      ...defaultDatasetComparisonDraft(descriptor()),
      baseStart: '2026-03-01', baseEnd: '2026-03-01', comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    })).toMatchObject({ status: 'blocked', message: expect.stringContaining('end after') });
  });

  it('restores persisted comparison intent into editable local dates and a saved-view summary', () => {
    const built = buildDatasetComparison(descriptor(), {
      ...defaultDatasetComparisonDraft(descriptor()),
      timezone: 'Pacific/Auckland',
      baseStart: '2026-03-01', baseEnd: '2026-04-01',
      comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    });
    if (built.status !== 'ready') throw new Error(built.message);
    expect(datasetComparisonDraftFromQuery(descriptor(), built.comparison)).toMatchObject({
      timezone: 'Pacific/Auckland',
      baseStart: '2026-03-01', baseEnd: '2026-04-01',
      comparisonStart: '2026-02-01', comparisonEnd: '2026-03-01',
    });
    expect(datasetComparisonSummary(built.comparison)).toContain('2026-03-01 to before 2026-04-01');
    expect(datasetComparisonSummary(built.comparison)).toContain('Pacific/Auckland');
  });
});
