import { describe, expect, it } from 'vitest';
import { buildStoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import { drawCanvasTile } from './CanvasPageFrame';

const item = (i: string, type: string, title = 'Tile') => ({ i, x: 0, y: 0, w: 6, h: 4, title, viz: { type } }) as never;
const tile = (tileId: string, extra: Record<string, unknown>) => ({ tileId, status: 'ok', ...extra }) as never;

describe('tiles drawn into a governed HTML page (RFC 0008 step 9)', () => {
  it('draws a chart as SVG, a KPI as its bound value, and a table with escaped cells', () => {
    const trend = tile('trend', { result: { columns: ['month', 'revenue'], rows: [{ month: '2026-02-01', revenue: 30 }, { month: '2026-03-01', revenue: 55 }], rowCount: 2, executionTime: 1 } });
    expect(drawCanvasTile(item('trend', 'line', 'Revenue by month'), trend, {}, 'paper', 600)).toMatch(/<p class="dql-tile-title">Revenue by month<\/p><svg/);

    const kpiTile = tile('kpi', { result: { columns: ['revenue'], rows: [{ revenue: 145 }], rowCount: 1, executionTime: 1, columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] } });
    const catalog = buildStoryBindingCatalog([kpiTile]);
    expect(drawCanvasTile(item('kpi', 'single_value', 'Revenue'), kpiTile, catalog, 'paper', 600)).toContain('<div class="dql-tile-kpi">$145</div>');

    const table = tile('t', { result: { columns: ['name', 'note'], rows: [{ name: '<b>x</b>', note: '<script>alert(1)</script>' }, { name: 'y', note: 'z' }, { name: 'q', note: 'w' }], rowCount: 3, executionTime: 1 } });
    const html = drawCanvasTile(item('t', 'table', 'Notes <i>'), table, {}, 'paper', 600);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Notes &lt;i&gt;');
  });

  it('says why a tile is empty instead of drawing stale data', () => {
    expect(drawCanvasTile(item('gone', 'bar'), undefined, {}, 'paper', 600)).toContain('no result in this run');
    expect(drawCanvasTile(item('bad', 'bar'), tile('bad', { status: 'error', error: 'Warehouse <down>' }), {}, 'paper', 600)).toContain('Warehouse &lt;down&gt;');
  });

  it('summarises a driver tile with its members', () => {
    const driver = tile('why', { driver: { summary: 'Revenue rose by 25.', dimensions: [{ label: 'Region', members: [{ label: 'US', delta: '25', role: 'driver', status: 'both' }] }] } });
    expect(drawCanvasTile(item('why', 'waterfall', 'Why'), driver, {}, 'paper', 600)).toBe('<p class="dql-tile-title">Why</p><p>Revenue rose by 25.</p><ol><li>US: +25</li></ol>');
  });
});
