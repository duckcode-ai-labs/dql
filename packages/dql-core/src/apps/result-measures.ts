/**
 * WHICH COLUMNS OF A RESULT ARE MEASURES.
 *
 * A rank, an id, a year or a code is a number at runtime and a label in
 * meaning. Summed, it is nonsense ("rank is 15"); treated as the value a row
 * leads on, it inverts a ranking ("Kevin Durant leads Rank at 5" when he is
 * fifth). Every caption, story and summary that picks "the measure" of a
 * result picks it here, so they agree with each other and with the table.
 *
 * Order of authority:
 *  1. What the result or its source declares: a column contract that says
 *     metric/measure/dimension (`columnsMeta.ref`, `kind`), or the measures a
 *     block declares (metric mappings, an output contract role).
 *  2. Otherwise the column's name: ranks, positions, orders, ids, keys,
 *     codes, years and other calendar parts are dimensions.
 *  3. Otherwise the values: a column of numbers is a measure.
 *
 * Pure: no DOM, no I/O, safe in the browser and on the server.
 */

export interface ResultColumnContract {
  name?: unknown;
  kind?: unknown;
  ref?: unknown;
  role?: unknown;
}

export interface ResultMeasureInput {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  columnsMeta?: ReadonlyArray<ResultColumnContract | null | undefined>;
  /** Columns the source declares as measures (block metric mappings, output contract). */
  declaredMeasures?: readonly string[];
  /** Columns the source declares as dimensions, keys or grain. */
  declaredDimensions?: readonly string[];
  /** Accept numeric strings ("1,234", "$5") as numbers. Off by default: a code such as "0042" is text. */
  numericStrings?: boolean;
}

export interface ResultMeasureSelection {
  /** Every measure column, in result order. */
  measures: string[];
  /** The measure a one-line summary should talk about, when there is one. */
  primary?: string;
  /** A rank/position column, when the result is a ranking. */
  rankColumn?: string;
  /** The column naming each row (player, team, region), when there is one. */
  labelColumn?: string;
  /** Whether the measures came from a declaration rather than names and values. */
  declared: boolean;
}

/** Ordinal words: a column whose own word is one of these numbers rows by position. */
const ORDINAL_TOKENS = new Set(['rank', 'ranking', 'rnk', 'position', 'pos', 'ordinal', 'order', 'seq', 'sequence', 'index', 'idx', 'rn', 'place', 'standing', 'row', 'rownum', 'row_number', 'row_num']);
/** Identity words: the number names a thing, it does not measure it. */
const IDENTIFIER_TOKENS = new Set(['id', 'ids', 'key', 'uuid', 'guid', 'code', 'sk', 'pk', 'fk', 'number', 'no', 'num', 'zip', 'zipcode', 'postcode', 'postal', 'phone', 'fips', 'isbn', 'sku']);
/** Calendar parts: a year or a month number is a time label. */
const CALENDAR_TOKENS = new Set(['year', 'yr', 'yyyy', 'season', 'month', 'mon', 'mm', 'quarter', 'qtr', 'week', 'wk', 'day', 'dd', 'date', 'hour', 'minute', 'period', 'fiscal_year', 'fy']);
/** Measure words: `rank_points` is points, not a rank. */
const MEASURE_SUFFIX_TOKENS = new Set(['count', 'total', 'sum', 'avg', 'average', 'mean', 'amount', 'value', 'pct', 'percent', 'rate', 'ratio', 'share', 'score', 'points', 'pts', 'revenue', 'sales', 'cost', 'spend', 'margin']);

/** Split a column name into lowercase words: `totalPoints_2016` → ["total", "points", "2016"]. */
export function columnNameTokens(column: string): string[] {
  return column
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The word a column is about: its last non-numeric word. `points_2016` is
 * about points, `games_played_2016_2017` about played, `player_rank` about
 * rank, `order_count` about count.
 */
function headToken(column: string): string | undefined {
  const tokens = columnNameTokens(column).filter((token) => !/^\d+$/.test(token));
  return tokens[tokens.length - 1];
}

export type ColumnNameRole = 'ordinal' | 'identifier' | 'calendar';

/**
 * Whether a column's name says it is a rank/position, an identifier or a
 * calendar part, i.e. a dimension however numeric its values are.
 */
export function nonMeasureColumnRole(column: string): ColumnNameRole | undefined {
  const tokens = columnNameTokens(column).filter((token) => !/^\d+$/.test(token));
  if (tokens.length === 0) return undefined;
  const head = tokens[tokens.length - 1]!;
  const joined = tokens.join('_');
  if (ORDINAL_TOKENS.has(head) || ORDINAL_TOKENS.has(joined)) return 'ordinal';
  // `rank_in_team`, `position_overall`: a leading rank word, with no measure word after it.
  if ((tokens[0] === 'rank' || tokens[0] === 'ranking' || tokens[0] === 'position')
    && !tokens.slice(1).some((token) => MEASURE_SUFFIX_TOKENS.has(token))) return 'ordinal';
  if (IDENTIFIER_TOKENS.has(head)) return 'identifier';
  if (CALENDAR_TOKENS.has(head) || CALENDAR_TOKENS.has(joined)) return 'calendar';
  return undefined;
}

/** A rank/position column, by name. */
export function isRankColumnName(column: string): boolean {
  return nonMeasureColumnRole(column) === 'ordinal';
}

function contractRole(meta: ResultColumnContract | undefined): 'measure' | 'dimension' | undefined {
  if (!meta) return undefined;
  const ref = typeof meta.ref === 'string' ? meta.ref : '';
  if (/^(metric|measure|calculation):/.test(ref)) return 'measure';
  if (/^(dimension|entity|grain|key):/.test(ref)) return 'dimension';
  const role = typeof meta.role === 'string' ? meta.role.toLowerCase() : '';
  if (role === 'metric' || role === 'measure') return 'measure';
  if (role === 'dimension' || role === 'grain' || role === 'entity' || role === 'key' || role === 'identifier') return 'dimension';
  const kind = typeof meta.kind === 'string' ? meta.kind : '';
  if (kind === 'text' || kind === 'date' || kind === 'boolean') return 'dimension';
  if (kind === 'currency' || kind === 'percent' || kind === 'count' || kind === 'duration') return 'measure';
  return undefined;
}

function toNumber(value: unknown, numericStrings: boolean): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (numericStrings && typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A column is numeric when at least half its present values are numbers and none is text. */
function isNumericColumn(column: string, rows: ReadonlyArray<Record<string, unknown>>, numericStrings: boolean): boolean {
  let present = 0;
  let numeric = 0;
  for (const row of rows.slice(0, 500)) {
    const value = row?.[column];
    if (value === null || value === undefined || value === '') continue;
    present += 1;
    if (toNumber(value, numericStrings) !== undefined) numeric += 1;
  }
  return present > 0 && numeric === present;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Whether ordering rows by `rankColumn` ascending orders `measure` the same
 * way every time (all non-increasing, or all non-decreasing): the measure the
 * ranking was computed on.
 */
function rankAgreesWith(rows: ReadonlyArray<Record<string, unknown>>, rankColumn: string, measure: string, numericStrings: boolean): boolean {
  const pairs = rows
    .map((row) => ({ rank: toNumber(row?.[rankColumn], numericStrings), value: toNumber(row?.[measure], numericStrings) }))
    .filter((pair): pair is { rank: number; value: number } => pair.rank !== undefined && pair.value !== undefined)
    .sort((a, b) => a.rank - b.rank);
  if (pairs.length < 2) return false;
  // A constant column agrees with every ordering, so it says nothing about this one.
  if (pairs.every((pair) => pair.value === pairs[0]!.value)) return false;
  let down = true;
  let up = true;
  for (let index = 1; index < pairs.length; index += 1) {
    if (pairs[index]!.value > pairs[index - 1]!.value) down = false;
    if (pairs[index]!.value < pairs[index - 1]!.value) up = false;
  }
  return down || up;
}

function labelColumnOf(input: ResultMeasureInput, exclude: Set<string>): string | undefined {
  const textColumns = input.columns.filter((column) => !exclude.has(column)
    && input.rows.some((row) => typeof row?.[column] === 'string' && String(row[column]).trim())
    && !input.rows.some((row) => typeof row?.[column] === 'number'));
  const named = textColumns.find((column) => /(?:^|_)(?:name|label|title|player|customer|account|team|region|segment|category|product|country|city|state|channel)(?:_|$)/i.test(column));
  return named
    ?? textColumns.find((column) => nonMeasureColumnRole(column) !== 'identifier' && nonMeasureColumnRole(column) !== 'calendar')
    ?? textColumns[0];
}

/** Pick the measures, the summary measure, the rank column and the label column of a result. */
export function selectResultMeasures(input: ResultMeasureInput): ResultMeasureSelection {
  const numericStrings = input.numericStrings ?? false;
  const meta = new Map<string, ResultColumnContract>();
  for (const entry of input.columnsMeta ?? []) {
    if (entry && typeof entry.name === 'string') meta.set(normalize(entry.name), entry);
  }
  const declaredMeasures = new Set((input.declaredMeasures ?? []).map(normalize));
  const declaredDimensions = new Set((input.declaredDimensions ?? []).map(normalize));
  const numeric = input.columns.filter((column) => isNumericColumn(column, input.rows, numericStrings));
  const rankColumn = numeric.find((column) => isRankColumnName(column) && contractRole(meta.get(normalize(column))) !== 'measure' && !declaredMeasures.has(normalize(column)));

  const declared = numeric.filter((column) => declaredMeasures.has(normalize(column)) || contractRole(meta.get(normalize(column))) === 'measure');
  let measures: string[];
  let isDeclared = false;
  if (declared.length > 0 && declaredMeasures.size > 0) {
    // A source that names its measures is the authority on all of them.
    measures = numeric.filter((column) => declaredMeasures.has(normalize(column)));
    if (measures.length === 0) measures = declared;
    isDeclared = true;
  } else {
    measures = numeric.filter((column) => {
      const key = normalize(column);
      if (declaredDimensions.has(key)) return false;
      const role = contractRole(meta.get(key));
      if (role === 'measure') return true;
      if (role === 'dimension') return false;
      return nonMeasureColumnRole(column) === undefined;
    });
    isDeclared = declared.length > 0 && declared.length === measures.length;
  }

  let primary: string | undefined;
  if (measures.length > 0) {
    const candidates = rankColumn
      ? measures.filter((column) => rankAgreesWith(input.rows, rankColumn, column, numericStrings))
      : [];
    const pool = candidates.length > 0 ? candidates : measures;
    // A total is what a ranking or a summary is usually about; then the first declared or remaining measure.
    primary = pool.find((column) => columnNameTokens(column).includes('total')) ?? pool[0];
  }
  const labelColumn = labelColumnOf(input, new Set([...measures, ...(rankColumn ? [rankColumn] : [])]));
  return {
    measures,
    ...(primary ? { primary } : {}),
    ...(rankColumn ? { rankColumn } : {}),
    ...(labelColumn ? { labelColumn } : {}),
    declared: isDeclared,
  };
}

/**
 * The row a ranked or measured result is led by.
 *
 * With a rank column, the leader is the row ranked first (the lowest rank),
 * whatever the order of the rows. Without one, it is the row with the largest
 * value of the summary measure. Undefined when the result has neither.
 */
export function resultLeaderRow(
  input: Pick<ResultMeasureInput, 'rows' | 'numericStrings'>,
  selection: Pick<ResultMeasureSelection, 'primary' | 'rankColumn'>,
): Record<string, unknown> | undefined {
  const numericStrings = input.numericStrings ?? false;
  let best: { row: Record<string, unknown>; key: number } | undefined;
  if (selection.rankColumn) {
    for (const row of input.rows) {
      const rank = toNumber(row?.[selection.rankColumn], numericStrings);
      if (rank === undefined) continue;
      if (!best || rank < best.key) best = { row, key: rank };
    }
    if (best) return best.row;
  }
  if (!selection.primary) return undefined;
  for (const row of input.rows) {
    const value = toNumber(row?.[selection.primary], numericStrings);
    if (value === undefined) continue;
    if (!best || value > best.key) best = { row, key: value };
  }
  return best?.row;
}
