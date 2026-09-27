import { describe, expect, it } from 'vitest';
import { buildDeterministicDashboardStory, validateDashboardStoryBrief } from './dashboard-story.js';

describe('dashboard business story', () => {
  it('uses all eligible governed tiles and keeps the least-trusted source', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Explain beverage revenue and top customers',
      filters: { category: 'Beverage', period: ['2026-01-01', '2026-06-30'] },
      driverTileIds: ['segments'],
      tiles: [
        {
          tileId: 'customers', title: 'Top customers', status: 'ok', trustState: 'certified',
          result: { columns: ['customer', 'revenue'], rows: [{ customer: 'Alice', revenue: 120 }, { customer: 'Bob', revenue: 80 }] },
          citation: { kind: 'block', name: 'top_customers' },
        },
        {
          tileId: 'segments', title: 'Revenue by beverage type', status: 'ok', trustState: 'review_required',
          result: { columns: ['type', 'revenue'], rows: [{ type: 'Coffee', revenue: 150 }, { type: 'Tea', revenue: 50 }] },
          citation: { kind: 'semantic_query', name: 'beverage_type_revenue' },
        },
      ],
    });
    expect(new Set(result.facts.map((fact) => fact.tileId))).toEqual(new Set(['customers', 'segments']));
    expect(result.story.trustState).toBe('review_required');
    expect(result.story.paragraphs.join(' ')).toContain('Alice');
    expect(result.story.paragraphs.join(' ')).toContain('Coffee');
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('reads an empty multi-select (All) as no filter, not as a blank value', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Claims this week', filters: { region: [] },
      tiles: [{ tileId: 'filed', title: 'Claims filed', status: 'ok', trustState: 'certified', result: { columns: ['claim_count'], rows: [{ claim_count: 147 }] }, citation: { kind: 'block', name: 'claims' } }],
    });
    expect(result.story.paragraphs[0]).toMatch(/^For the current scope, /);
    expect(result.story.paragraphs.join(' ')).not.toContain('region ,');
  });

  it('rejects invented numbers and unsupported causal language', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Revenue overview', filters: {},
      tiles: [{
        tileId: 'revenue', title: 'Revenue', status: 'ok', trustState: 'certified',
        result: { columns: ['revenue'], rows: [{ revenue: 100 }] },
      }],
    });
    const invalid = {
      ...result.story,
      paragraphs: ['Revenue fell 25 because renewals caused the decline.'],
      claims: [{ text: 'Renewals caused the decline.', factIds: [result.facts[0]!.id], kind: 'driver' as const }],
      generatedBy: 'ai' as const,
    };
    const validation = validateDashboardStoryBrief(invalid, result.facts);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/unsupported number|causal claim/);
  });

  it('keeps grouped Dataset rows as formatted observations instead of reaggregating distinct counts or ratios', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'Commerce monthly health',
      filters: {},
      tiles: [{
        tileId: 'monthly-health', title: 'Monthly customer health', status: 'ok', trustState: 'certified',
        datasetScope: {
          kind: 'grouped_observations',
          dimensions: ['order_date'],
          outputDimensionAliases: ['order_date_month'],
          limited: false,
        },
        result: {
          columns: ['order_date_month', 'customer_count', 'margin_rate'],
          columnsMeta: [
            { name: 'customer_count', kind: 'count' },
            { name: 'margin_rate', kind: 'percent', unit: 'fraction', decimals: 1 },
          ],
          rows: [
            { order_date_month: new Date('2026-01-01T00:00:00.000Z'), customer_count: 12_500, margin_rate: 0.4166667 },
            { order_date_month: new Date('2026-02-01T00:00:00.000Z'), customer_count: 25_000, margin_rate: 0.6 },
            { order_date_month: new Date('2026-03-01T00:00:00.000Z'), customer_count: 25_000, margin_rate: 0.6 },
          ],
        },
      }],
    });

    // The old generic summary emitted 62,500 and 1.6167. Neither number is a
    // valid whole-scope distinct count or ratio-of-sums for this grouped tile.
    expect(result.facts.map((fact) => fact.value)).not.toContain(62_500);
    expect(result.facts.map((fact) => fact.value)).not.toContain(1.6166667);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('2026-01-01'), value: 12_500 }),
      expect.objectContaining({ label: expect.stringContaining('2026-01-01'), value: 0.4166667, unit: 'percent:1' }),
    ]));
    expect(result.story.paragraphs.join(' ')).toContain('41.7%');
    expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
  });

  it('does not narrate a deliberately excluded Dataset tile as if it shared the active filter scope', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'California revenue health',
      filters: { region: ['CA'] },
      tiles: [
        {
          tileId: 'california-revenue', title: 'Revenue', status: 'ok', trustState: 'certified',
          filters: { region: ['CA'] },
          result: { columns: ['revenue'], rows: [{ revenue: 60 }] },
        },
        {
          tileId: 'monthly-revenue', title: 'Monthly Revenue', status: 'ok', trustState: 'certified',
          // The page control remains active but this component was omitted
          // from its Dataset binding. These are full-source observations.
          filters: {},
          datasetScope: {
            kind: 'grouped_observations', dimensions: ['order_date'], outputDimensionAliases: ['order_date_month'], limited: false,
          },
          result: {
            columns: ['order_date_month', 'revenue'],
            rows: [
              { order_date_month: '2026-01-01', revenue: 60 },
              { order_date_month: '2026-02-01', revenue: 30 },
              { order_date_month: '2026-03-01', revenue: 40 },
            ],
          },
        },
      ],
    });

    const scopedFactIds = new Set(result.facts
      .filter((fact) => JSON.stringify(fact.filters) === JSON.stringify({ region: ['CA'] }))
      .map((fact) => fact.id));
    const narratedFactIds = new Set(result.story.claims.flatMap((claim) => claim.factIds));
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tileId: 'monthly-revenue', value: 60, filters: {} }),
      expect.objectContaining({ tileId: 'monthly-revenue', value: 30, filters: {} }),
    ]));
    expect([...narratedFactIds].every((factId) => scopedFactIds.has(factId))).toBe(true);
    expect(result.story.paragraphs.join(' ')).not.toContain('Monthly Revenue');
    expect(result.story.caveat).toContain('outside the current filter scope');
  });
});
