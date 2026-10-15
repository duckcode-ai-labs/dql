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
    // "Verified" wording is reserved for stories whose every source is certified.
    expect(result.story.implication).not.toMatch(/verified/i);
    expect(result.story.implication).toMatch(/need review/);
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

  it('does not claim the filter scope when no tile reflects the selected filters (F6)', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'NBA player performance',
      filters: { season_start: 2016, season_end: 2017, top_n: 5 },
      tiles: [{
        tileId: 'codex-scorers', title: 'Codex Top Scorers', status: 'ok', trustState: 'certified',
        // The block took none of the page values.
        filters: {},
        result: { columns: ['player_name', 'total_points'], rows: [{ player_name: 'James Harden', total_points: 5534 }] },
      }],
    });
    const text = [result.story.headline, ...result.story.paragraphs].join(' ');
    expect(text).not.toMatch(/season start 2016|top n 5/);
    expect(result.story.paragraphs[0]).toMatch(/^For the current scope, /);
    expect(result.story.caveat).toContain('Season start, season end and top n do not narrow any tile summarized here');
  });

  it('narrates only tiles the page filters reached and names the filter that reached none (F6)', () => {
    const result = buildDeterministicDashboardStory({
      goal: 'NBA player performance',
      filters: { season: 2017, season_start: 2016, season_end: 2017, top_n: 5 },
      tiles: [
        {
          tileId: 'top-players', title: 'Top Players', status: 'ok', trustState: 'certified',
          filters: { season_start: 2016, season_end: 2017, top_n: 5 },
          result: { columns: ['player_name', 'total_points'], rows: [{ player_name: 'James Harden', total_points: 5534 }] },
        },
        {
          tileId: 'codex-scorers', title: 'Codex Top Scorers', status: 'ok', trustState: 'certified',
          filters: {},
          result: { columns: ['player_name', 'games'], rows: [{ player_name: 'LeBron James', games: 990 }] },
        },
      ],
    });
    expect(result.story.paragraphs[0]).toContain('For season start 2016, season end 2017, top n 5,');
    expect(result.story.paragraphs.join(' ')).not.toContain('Codex Top Scorers');
    expect(result.story.caveat).toContain('outside the current filter scope');
    expect(result.story.caveat).toContain('Season does not narrow any tile summarized here');
    expect(validateDashboardStoryBrief(result.story, result.facts).ok).toBe(true);
  });

  describe('a rank, an id or a year is never a measure (0.1.0 re-test #1)', () => {
    // The App give-me-top-5-players-who: rows ordered by rank, rank first.
    const ranked = [
      { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534, games_played_2016_2017: 189, player_id_count: 1 },
      { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331, games_played_2016_2017: 214, player_id_count: 1 },
      { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252, games_played_2016_2017: 198, player_id_count: 1 },
      { rank: 4, player_name: 'Stephen Curry', points_2016: 2863, points_2017: 2388, total_points_2016_2017: 5251, games_played_2016_2017: 201, player_id_count: 1 },
      { rank: 5, player_name: 'Kevin Durant', points_2016: 2850, points_2017: 1985, total_points_2016_2017: 4835, games_played_2016_2017: 188, player_id_count: 1 },
    ];
    const rankedTile = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      tileId: 'top5', title: 'Top 5 players', status: 'ok', trustState: 'review_required' as const,
      result: { columns: Object.keys(rows[0]!), rows },
      citation: { kind: 'block', name: 'top_5_players_points_2016_2017' },
      ...extra,
    });

    it('names the player ranked first, on the measure the ranking is by, and sums nothing', () => {
      const result = buildDeterministicDashboardStory({ goal: 'Top 5 scorers', filters: {}, tiles: [rankedTile(ranked)] });
      const text = result.story.paragraphs.join(' ');
      expect(text).toContain('James Harden: 5,534');
      expect(text).toMatch(/ranked first by total points 2016 2017/);
      // No "rank is 15", no summed Top-N ("points 2016 is 13,480"), no fifth-ranked leader.
      expect(text).not.toMatch(/rank is/i);
      expect(text).not.toContain('15');
      expect(text).not.toContain('13,480');
      expect(text).not.toContain('Kevin Durant');
      expect(result.facts.map((fact) => fact.id)).toEqual(['top5:rank:1']);
      expect(validateDashboardStoryBrief(result.story, result.facts)).toEqual({ ok: true, errors: [] });
    });

    it('leads with the row ranked first even when the rows arrive in another order', () => {
      const result = buildDeterministicDashboardStory({ goal: 'Top 5 scorers', filters: {}, tiles: [rankedTile([...ranked].reverse())] });
      expect(result.facts[0]!.value).toBe('James Harden: 5,534');
    });

    it('prefers the measure the source declares', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Top 5 scorers', filters: {},
        tiles: [rankedTile(ranked, { declaredMeasures: ['games_played_2016_2017'] })],
      });
      expect(result.facts[0]!.label).toMatch(/ranked first by games played 2016 2017/);
      expect(result.facts[0]!.value).toBe('James Harden: 189');
    });

    it('treats a column contract that says dimension as one, whatever its name', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Revenue by store', filters: {},
        tiles: [{
          tileId: 'stores', title: 'Stores', status: 'ok', trustState: 'certified',
          result: {
            columns: ['store', 'store_size', 'revenue'],
            columnsMeta: [{ name: 'store_size', kind: 'number', ref: 'dimension:stores.store_size' }, { name: 'revenue', kind: 'currency', unit: 'USD', ref: 'metric:revenue' }],
            rows: [{ store: 'North', store_size: 3, revenue: 120 }, { store: 'South', store_size: 9, revenue: 80 }],
          },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).toEqual(['stores:value:revenue', 'stores:rank:1']);
      expect(result.facts[1]!.value).toBe('North: $120.00');
    });

    it('reports no figure for a table of only ids and years', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Players by season', filters: {},
        tiles: [{
          tileId: 'ids', title: 'Player seasons', status: 'ok', trustState: 'certified',
          result: {
            columns: ['player_id', 'team_id', 'season', 'game_year', 'jersey_number', 'team_code'],
            rows: [
              { player_id: 201935, team_id: 1610612745, season: 2016, game_year: 2017, jersey_number: 13, team_code: 1 },
              { player_id: 2544, team_id: 1610612739, season: 2016, game_year: 2017, jersey_number: 23, team_code: 2 },
            ],
          },
        }],
      });
      expect(result.facts).toEqual([]);
      expect(result.story.paragraphs.join(' ')).not.toMatch(/\d{4,}/);
    });

    it('does not add a rate across rows', () => {
      const result = buildDeterministicDashboardStory({
        goal: 'Shooting', filters: {},
        tiles: [{
          tileId: 'fg', title: 'Field goals', status: 'ok', trustState: 'certified',
          result: { columns: ['player', 'fg_pct', 'made'], rows: [{ player: 'A', fg_pct: 0.5, made: 10 }, { player: 'B', fg_pct: 0.4, made: 20 }] },
        }],
      });
      expect(result.facts.map((fact) => fact.id)).not.toContain('fg:value:fg_pct');
      expect(result.facts.find((fact) => fact.id === 'fg:value:made')?.value).toBe(30);
    });
  });
});
