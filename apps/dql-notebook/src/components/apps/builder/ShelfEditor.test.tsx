import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import { ShelfEditor, describeEncodedChart } from './ShelfEditor';
import { TileQueryEditor } from './TileQueryEditor';
import { autoTileView, descriptorTimeField, vizTypeForEncoding } from './field-query';

const descriptor = {
  version: 1, id: 'orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
  fields: [
    { kind: 'physical', name: 'region', qualifiedId: 'f.region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'f.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
    { kind: 'measure', name: 'order_count', qualifiedId: 'm.order_count', aggregation: 'count_distinct', from: 'order_id', dependsOn: ['order_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'compare', 'having'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const isTime = descriptorTimeField(descriptor);
const lineByRegion: DashboardVizEncoding = {
  version: 1,
  columns: [{ dimension: 'order_date' }],
  rows: [{ measure: 'revenue' }],
  color: { dimension: 'region' },
  tooltip: [{ measure: 'order_count' }],
  fields: { 'measure:revenue': { label: 'Net revenue' } },
};
const query = { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] };

describe('shelves in Studio (RFC 0009 step 1)', () => {
  it('shows every shelf, the fields on it with their names and grains, and what the shelves draw', () => {
    const markup = renderToStaticMarkup(<ShelfEditor descriptor={descriptor} encoding={lineByRegion} query={query} disabled={false} onChange={() => undefined} />);
    for (const shelf of ['Columns', 'Rows', 'Colour', 'Size', 'Label', 'Tooltip', 'Detail']) expect(markup).toContain(`aria-label="${shelf} shelf"`);
    expect(markup).toContain('Order Date<em> · Month</em>');
    expect(markup).toContain('Net revenue');
    expect(markup).toContain('aria-label="Options for Net revenue on Rows"');
    expect(markup).toContain('aria-label="Remove Order Count from Tooltip"');
    expect(markup).toContain('draggable="true"');
    expect(markup).toContain('A line over Order Date, split by Region.');
  });

  it('reads the shelves into a chart type, keeping the author\'s choice when it still fits', () => {
    expect(vizTypeForEncoding(lineByRegion, isTime)).toBe('line');
    expect(vizTypeForEncoding(lineByRegion, isTime, 'area')).toBe('area');
    const bars: DashboardVizEncoding = { version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] };
    expect(vizTypeForEncoding(bars, isTime, 'stacked_bar')).toBe('stacked_bar');
    expect(vizTypeForEncoding(bars, isTime, 'donut')).toBe('donut');
    expect(vizTypeForEncoding(bars, isTime, 'single_value')).toBe('bar');
    expect(describeEncodedChart(bars, isTime)).toBe('Horizontal bars by Region.');
    const kpi: DashboardVizEncoding = { version: 1, columns: [], rows: [{ measure: 'revenue' }] };
    expect(vizTypeForEncoding(kpi, isTime)).toBe('single_value');
    expect(autoTileView({ dimensions: [], measures: [{ measure: 'revenue' }] }, kpi, isTime)).toBe('kpi');
    const crossed: DashboardVizEncoding = { version: 1, columns: [{ dimension: 'region' }, { measure: 'revenue' }], rows: [{ dimension: 'order_date' }] };
    expect(autoTileView({ dimensions: [{ field: 'region' }, { field: 'order_date' }], measures: [{ measure: 'revenue' }] }, crossed, isTime)).toBe('table');
  });

  it('leaves measures and grouping to the shelves in the filters editor', () => {
    const withShelves = renderToStaticMarkup(<TileQueryEditor descriptor={descriptor} query={query} disabled={false} onChange={() => undefined} idPrefix="s" shelves />);
    expect(withShelves).not.toContain('<legend>Measures</legend>');
    expect(withShelves).not.toContain('Group by');
    expect(withShelves).toContain('Compare periods');
    const without = renderToStaticMarkup(<TileQueryEditor descriptor={descriptor} query={query} disabled={false} onChange={() => undefined} idPrefix="t" />);
    expect(without).toContain('<legend>Measures</legend>');
  });
});
