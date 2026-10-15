import { describe, expect, it } from 'vitest';
import { nonMeasureColumnRole, resultLeaderRow, selectResultMeasures } from './result-measures.js';

const ranked = [
  { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534, games_played_2016_2017: 189, player_id_count: 1 },
  { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331, games_played_2016_2017: 214, player_id_count: 1 },
  { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252, games_played_2016_2017: 198, player_id_count: 1 },
  { rank: 4, player_name: 'Stephen Curry', points_2016: 2863, points_2017: 2388, total_points_2016_2017: 5251, games_played_2016_2017: 201, player_id_count: 1 },
  { rank: 5, player_name: 'Kevin Durant', points_2016: 2850, points_2017: 1985, total_points_2016_2017: 4835, games_played_2016_2017: 188, player_id_count: 1 },
];
const columns = Object.keys(ranked[0]!);

describe('result measures', () => {
  it('reads ranks, positions, ids, codes and calendar parts as dimensions', () => {
    for (const column of ['rank', 'player_rank', 'points_rank', 'rank_in_team', 'position', 'sort_order', 'row_number', 'rn']) {
      expect(nonMeasureColumnRole(column), column).toBe('ordinal');
    }
    for (const column of ['player_id', 'teamId', 'team_key', 'country_code', 'jersey_number', 'sku']) {
      expect(nonMeasureColumnRole(column), column).toBe('identifier');
    }
    for (const column of ['year', 'season', 'game_year', 'fiscal_year', 'month', 'week']) {
      expect(nonMeasureColumnRole(column), column).toBe('calendar');
    }
    for (const column of ['total_points', 'points_2016', 'order_count', 'total_orders', 'rank_points', 'player_id_count', 'days_active', 'tenure_days', 'revenue']) {
      expect(nonMeasureColumnRole(column), column).toBeUndefined();
    }
  });

  it('picks the measure a ranked top-N table is ranked by, and the row ranked first', () => {
    const selection = selectResultMeasures({ columns, rows: ranked });
    expect(selection.rankColumn).toBe('rank');
    expect(selection.labelColumn).toBe('player_name');
    expect(selection.measures).not.toContain('rank');
    expect(selection.primary).toBe('total_points_2016_2017');
    expect(resultLeaderRow({ rows: [...ranked].reverse() }, selection)?.player_name).toBe('James Harden');
  });

  it('finds the ranking measure from the order even without a "total" in its name', () => {
    const rows = ranked.map(({ rank, player_name, games_played_2016_2017, total_points_2016_2017 }) => ({ rank, player_name, games_played_2016_2017, points: total_points_2016_2017 }));
    const selection = selectResultMeasures({ columns: Object.keys(rows[0]!), rows });
    expect(selection.primary).toBe('points');
  });

  it('a rank and a label alone have no measure, and the leader is still the row ranked first', () => {
    const rows = ranked.map(({ rank, player_name }) => ({ rank, player_name }));
    const selection = selectResultMeasures({ columns: ['rank', 'player_name'], rows });
    expect(selection.measures).toEqual([]);
    expect(selection.primary).toBeUndefined();
    expect(resultLeaderRow({ rows }, selection)?.player_name).toBe('James Harden');
  });

  it('a table of ids and years has no measure', () => {
    const rows = [
      { player_id: 201935, season: 2016, game_year: 2017, team_code: 7 },
      { player_id: 2544, season: 2016, game_year: 2017, team_code: 3 },
    ];
    const selection = selectResultMeasures({ columns: Object.keys(rows[0]!), rows });
    expect(selection.measures).toEqual([]);
    expect(selection.primary).toBeUndefined();
    expect(resultLeaderRow({ rows }, selection)).toBeUndefined();
  });

  it('declared measures and column contracts outrank names', () => {
    const declared = selectResultMeasures({ columns, rows: ranked, declaredMeasures: ['games_played_2016_2017'] });
    expect(declared.measures).toEqual(['games_played_2016_2017']);
    expect(declared.primary).toBe('games_played_2016_2017');
    expect(declared.declared).toBe(true);
    const contract = selectResultMeasures({
      columns: ['store', 'store_rank_score', 'store_size'],
      rows: [{ store: 'N', store_rank_score: 4, store_size: 3 }, { store: 'S', store_rank_score: 2, store_size: 9 }],
      columnsMeta: [{ name: 'store_size', kind: 'number', ref: 'dimension:stores.size' }],
    });
    expect(contract.measures).toEqual(['store_rank_score']);
  });

  it('reads numeric strings only when asked to', () => {
    const rows = [{ team: 'A', wins: '60' }, { team: 'B', wins: '45' }];
    expect(selectResultMeasures({ columns: ['team', 'wins'], rows }).measures).toEqual([]);
    const selection = selectResultMeasures({ columns: ['team', 'wins'], rows, numericStrings: true });
    expect(selection.primary).toBe('wins');
    expect(resultLeaderRow({ rows, numericStrings: true }, selection)?.team).toBe('A');
  });
});
