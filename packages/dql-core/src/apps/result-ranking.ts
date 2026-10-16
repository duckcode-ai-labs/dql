/**
 * One ranking rule for the rows of a tile result.
 *
 * A grouped query with no ORDER BY comes back in whatever order the
 * warehouse's parallel aggregation finishes, so the same rows can arrive in
 * a different order on every run. Anything that picks "the top members" of a
 * result — the page story's clearest signals, a tile's leader, which members
 * get story bindings — must rank by value and break ties on the member, never
 * rely on the order rows were returned in. Browser-safe: no Node imports.
 */

export interface RankedResultRow<Row> {
  row: Row;
  /** The measure's value on this row; null when it is missing or not a finite number. */
  value: number | null;
}

export interface RankResultRowsOptions<Row> {
  /** The row's measure value. Anything that is not a finite number ranks last. */
  measure: (row: Row) => unknown;
  /** The row's member (dimension value), used to break ties. */
  member?: (row: Row) => unknown;
  /**
   * `magnitude` (default) ranks the largest absolute value first, with a
   * positive value ahead of the negative one of the same size: the clearest
   * signal. `value` ranks the highest value first: a leader.
   */
  by?: 'magnitude' | 'value';
}

/**
 * Rows ranked by a measure, then by member, then by the whole row, so the
 * same rows rank the same way in any input order. Rows without a value are
 * kept, last, ordered by member; callers that want only signals drop them.
 */
export function rankResultRows<Row>(rows: readonly Row[], options: RankResultRowsOptions<Row>): Array<RankedResultRow<Row>> {
  const by = options.by ?? 'magnitude';
  const member = options.member ?? (() => undefined);
  return rows
    .map((row) => {
      const value = options.measure(row);
      return { row, value: typeof value === 'number' && Number.isFinite(value) ? value : null };
    })
    .sort((left, right) => {
      if (left.value === null || right.value === null) {
        if (left.value !== right.value) return left.value === null ? 1 : -1;
      } else {
        const primary = by === 'magnitude'
          ? compareScalars(Math.abs(right.value), Math.abs(left.value)) || compareScalars(right.value, left.value)
          : compareScalars(right.value, left.value);
        if (primary) return primary;
      }
      return compareResultMembers(member(left.row), member(right.row))
        || compareScalars(stableRowKey(left.row), stableRowKey(right.row));
    });
}

/**
 * Order two members the same way on every run and in every locale: numbers
 * and dates in their natural order, everything else by its text, compared by
 * code unit rather than `localeCompare`. Missing members sort last.
 */
export function compareResultMembers(left: unknown, right: unknown): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  if (typeof left === 'number' && typeof right === 'number') return compareScalars(left, right);
  if (typeof left === 'bigint' && typeof right === 'bigint') return compareScalars(left, right);
  if (left instanceof Date && right instanceof Date) return compareScalars(left.getTime(), right.getTime());
  return compareScalars(memberKey(left), memberKey(right));
}

function compareScalars<T extends number | bigint | string>(left: T, right: T): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function memberKey(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (value !== null && typeof value === 'object') return stableRowKey(value);
  return String(value);
}

function stableRowKey(row: unknown): string {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return JSON.stringify(row, jsonSafe) ?? '';
  const entries = Object.keys(row as Record<string, unknown>)
    .sort()
    .map((key) => [key, (row as Record<string, unknown>)[key]]);
  return JSON.stringify(entries, jsonSafe);
}

function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}
