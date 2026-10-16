import { describe, expect, it } from 'vitest';
import { applyAppBuildDraftOperations, createAppBuildDraft } from './app-build-draft.js';
import { parseDashboardDocument } from './dashboard-document.js';
import { buildStoryBindingCatalog, formatStoryValue, splitStoryText, validateStoryText } from './story-bindings.js';

const tiles = [
  { tileId: 'revenue', status: 'ok', result: { columns: ['revenue'], rows: [{ revenue: 130 }], columnsMeta: [{ name: 'revenue', kind: 'currency', unit: 'USD' }] } },
  { tileId: 'margin', status: 'ok', result: { columns: ['margin_rate'], rows: [{ margin_rate: 0.5154 }], columnsMeta: [{ name: 'margin_rate', kind: 'percent' }] } },
  { tileId: 'by-region', status: 'ok', result: { columns: ['region', 'revenue'], rows: [{ region: 'US', revenue: 70 }, { region: 'CA', revenue: 60 }] } },
  {
    tileId: 'why', status: 'ok', tileType: 'driver', result: { columnsMeta: [{ name: 'current', kind: 'currency', unit: 'USD' }] }, driver: {
      headline: { current: '40', prior: '30', delta: '10', percentDelta: '33.3333' },
      dimensions: [{ label: 'Region', members: [{ label: 'US', delta: '10', role: 'driver' }, { label: 'CA', delta: '0', role: 'flat' }] }],
    },
  },
  { tileId: 'broken', status: 'error' },
];

describe('story bindings (RFC 0008 step 8)', () => {
  it('binds the same members, values and leader whatever order the rows came back in', () => {
    // A grouped tile without ORDER BY returns rows in a different order on
    // each run; digests, monitors and story editions read these bindings.
    const rows = Array.from({ length: 25 }, (_, index) => ({
      sku: `SKU-${String(index + 1).padStart(2, '0')}`,
      revenue: index === 3 ? null : (index % 5) * 10 + index,
    }));
    // SKU-25 has the highest value (64); SKU-00 ties it for the lead.
    rows.push({ sku: 'SKU-00', revenue: 64 });
    const catalogFor = (ordered: typeof rows) => buildStoryBindingCatalog([{ tileId: 'skus', status: 'ok', result: { columns: ['sku', 'revenue'], rows: ordered } }]);
    const forward = catalogFor(rows);
    const reversed = catalogFor([...rows].reverse());
    const rotated = catalogFor([...rows.slice(11), ...rows.slice(0, 11)]);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
    // The member cap keeps the twenty largest values, not the first twenty rows.
    const members = Object.keys(forward).filter((key) => key.startsWith('skus.revenue['));
    expect(members).toHaveLength(20);
    expect(members).not.toContain('skus.revenue[SKU-04]');
    // Two members share the highest value; the member decides, not row position.
    expect(forward['skus.leader']).toMatchObject({ value: 'SKU-00' });
    expect(forward['skus.leader_value']).toMatchObject({ value: 64 });
  });

  it('resolves a repeated member to the same row in any order', () => {
    const rows = [{ region: 'US', revenue: 10 }, { region: 'US', revenue: 50 }, { region: 'CA', revenue: 20 }];
    const catalogFor = (ordered: typeof rows) => buildStoryBindingCatalog([{ tileId: 'r', status: 'ok', result: { columns: ['region', 'revenue'], rows: ordered } }]);
    expect(catalogFor([...rows].reverse())).toEqual(catalogFor(rows));
  });

  it('offers single values, members, leaders and driver results as bindings', () => {
    const catalog = buildStoryBindingCatalog(tiles, { revenue: 'Revenue' });
    expect(catalog['revenue.revenue']).toMatchObject({ value: 130, display: '$130', label: 'Revenue — revenue' });
    expect(catalog['margin.margin_rate']?.display).toBe('51.54%');
    expect(catalog['by-region.revenue[US]']?.value).toBe(70);
    expect(catalog['by-region.leader']?.display).toBe('US');
    const monthly = buildStoryBindingCatalog([{ tileId: 'm', status: 'ok', result: { columns: ['month', 'revenue'], rows: [{ month: '2026-01-01T00:00:00.000Z', revenue: 60 }, { month: '2026-03-01T00:00:00.000Z', revenue: 55 }] } }]);
    expect(monthly['m.leader']).toMatchObject({ value: '2026-01-01', display: 'Jan 2026' });
    expect(monthly['m.revenue[2026-03-01]']?.value).toBe(55);
    expect(catalog['why.change']?.display).toBe('+$10');
    expect(catalog['why.current']?.display).toBe('$40');
    expect(catalog['by-region.revenue[US]']?.display).toBe('70');
    expect(catalog['why.change_percent']?.display).toBe('+33.33%');
    expect(catalog['why.top_member']?.display).toBe('US');
    expect(Object.keys(catalog).some((key) => key.startsWith('broken'))).toBe(false);
  });

  it('refuses numbers written into the text and unknown bindings', () => {
    const keys = new Set(Object.keys(buildStoryBindingCatalog(tiles)));
    expect(validateStoryText('Revenue reached {{revenue.revenue}} in 2026, led by {{by-region.leader}} in Q1.', keys)).toEqual([]);
    const issues = validateStoryText('Revenue reached $130 (up 12%) and {{revenue.nope}}.', keys);
    expect(issues.map((issue) => [issue.code, issue.token])).toEqual([
      ['UNKNOWN_BINDING', 'revenue.nope'],
      ['NAKED_NUMBER', '$130'],
      ['NAKED_NUMBER', '12%'],
    ]);
  });

  it('splits text into prose and bindings for rendering', () => {
    expect(splitStoryText('Up {{why.change}} vs {{why.prior}}.')).toEqual([
      { kind: 'text', text: 'Up ' }, { kind: 'binding', key: 'why.change' }, { kind: 'text', text: ' vs ' }, { kind: 'binding', key: 'why.prior' }, { kind: 'text', text: '.' },
    ]);
    expect(formatStoryValue(2_450_000, { kind: 'currency', currency: 'USD' })).toBe('$2.5M');
    expect(formatStoryValue(null)).toBe('—');
  });

  it('keeps a story in the page file and refuses a literal number when saving', () => {
    const page = {
      version: 1, id: 'overview', metadata: { title: 'Overview' },
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'revenue', x: 0, y: 0, w: 4, h: 2, block: { blockId: 'revenue' }, viz: { type: 'kpi' } }] },
      narrative: { version: 1, presentation: 'story', blocks: [{ id: 'intro', kind: 'text', markdown: 'Revenue is {{revenue.revenue}}.' }, { id: 't1', kind: 'tile', tileId: 'revenue' }] },
    };
    const parsed = parseDashboardDocument(JSON.stringify(page));
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.narrative?.blocks).toHaveLength(2);
    const naked = parseDashboardDocument(JSON.stringify({ ...page, narrative: { ...page.narrative, blocks: [{ id: 'a', kind: 'text', markdown: 'Revenue is 130.' }] } }));
    expect(naked.errors.map((error) => error.message).join(' ')).toContain('"130" is a number written into the text');

    const draft = createAppBuildDraft({ id: 'story-draft', appId: 'story-app', authoringMode: 'manual', frame: { goal: 'Explain revenue', metrics: [], dimensions: [], filters: [] } });
    const withTile = applyAppBuildDraftOperations(draft, draft.revision, [{ type: 'upsert_page', page: { ...(parsed.document as object), narrative: undefined } as never }]);
    const withStory = applyAppBuildDraftOperations(withTile, withTile.revision, [{ type: 'set_narrative', pageId: 'overview', narrative: page.narrative as never }]);
    expect(withStory.pages[0]!.narrative?.presentation).toBe('story');
    expect(() => applyAppBuildDraftOperations(withStory, withStory.revision, [{
      type: 'set_narrative', pageId: 'overview', narrative: { version: 1, presentation: 'story', blocks: [{ id: 'a', kind: 'text', markdown: 'We sold 42 units.' }] },
    }])).toThrow(/"42" is a number/);
    const removed = applyAppBuildDraftOperations(withStory, withStory.revision, [{ type: 'remove_tile', pageId: 'overview', tileId: 'revenue' }]);
    expect(removed.pages[0]!.narrative?.blocks.map((block) => block.id)).toEqual(['intro']);
  });

  it('publishes a driver tile and a story that embeds it (RFC 0008 steps 7 and 8)', () => {
    const page = {
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'orders', sourceId: 'src', sourceRevision: 'rev', snapshotId: 'snap', contractFingerprint: 'fp' }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'why', x: 0, y: 0, w: 12, h: 6, sourceId: 'src', sourceRevision: 'rev', viz: { type: 'waterfall' }, title: 'Why revenue moved',
          driver: { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-03-01', comparison: 'previous_period', dimensions: ['*'] },
        }],
      },
      narrative: { version: 1, presentation: 'story', blocks: [{ id: 'a', kind: 'text', markdown: 'Revenue changed by {{why.change}}.' }, { id: 'b', kind: 'tile', tileId: 'why' }] },
    };
    const parsed = parseDashboardDocument(JSON.stringify(page));
    expect(parsed.errors).toEqual([]);
    expect(parsed.document?.layout.items[0]?.driver?.measure).toBe('revenue');
    const unbound = parseDashboardDocument(JSON.stringify({ ...page, layout: { ...page.layout, items: [{ ...page.layout.items[0], sourceRevision: undefined }] } }));
    expect(unbound.errors.map((error) => error.message).join(' ')).toContain('driver requires snapshot-bound sourceId and sourceRevision');
  });
});
