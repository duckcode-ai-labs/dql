/**
 * How a block's SELECT list is read. Ask's block contract (dql-agent) and the
 * certify-time identity warning both read grouping columns through this file, so
 * a block the matcher refuses for its grouping is the block the warning names.
 */

export type SelectAggregate = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'median';

export interface SelectItem {
  /** Output column name: the alias, else the last segment of the column. */
  output: string;
  /** The expression, lower-cased and whitespace-normalised. */
  expr: string;
  aggregate?: SelectAggregate;
  /** Source column the aggregate reads, when it is a plain column. */
  sourceColumn?: string;
}

export const normalizeSqlText = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
export const lastSqlSegment = (value: string) => value.replace(/["`]/g, '').split('.').pop() ?? value;

export function splitSqlTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | undefined;
  for (const char of text) {
    if (quote) { current += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The text of a top-level clause (`WHERE`, `GROUP BY`...) up to the first stop keyword. */
export function sqlClause(sql: string, keyword: string, stops: string[]): string | undefined {
  const upper = sql.toUpperCase();
  const boundary = (at: number) => at <= 0 || /[\s)]/.test(upper[at - 1] ?? ' ');
  let depth = 0;
  let start = -1;
  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth !== 0) continue;
    if (start < 0) {
      if (upper.startsWith(keyword, index) && boundary(index) && /[\s(]/.test(upper[index + keyword.length] ?? ' ')) {
        start = index + keyword.length;
        index = start - 1;
      }
      continue;
    }
    for (const stop of stops) {
      if (upper.startsWith(stop, index) && boundary(index) && /[\s(]|$/.test(upper[index + stop.length] ?? ' ')) {
        return sql.slice(start, index).trim();
      }
    }
  }
  return start >= 0 ? sql.slice(start).trim().replace(/;\s*$/, '') : undefined;
}

const AGGREGATES: Array<[RegExp, SelectAggregate]> = [
  [/^count\s*\(\s*distinct\b/i, 'count_distinct'],
  [/^count\s*\(/i, 'count'],
  [/^sum\s*\(/i, 'sum'],
  [/^avg\s*\(/i, 'avg'],
  [/^min\s*\(/i, 'min'],
  [/^max\s*\(/i, 'max'],
  [/^median\s*\(/i, 'median'],
];

export function parseSelectItem(item: string): SelectItem {
  const aliasMatch = item.match(/^(.*?)\s+as\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*$/i);
  const expr = normalizeSqlText(aliasMatch ? aliasMatch[1]! : item);
  const output = aliasMatch ? aliasMatch[2]! : lastSqlSegment(item.trim());
  const aggregate = AGGREGATES.find(([pattern]) => pattern.test(expr))?.[1];
  const inner = aggregate ? expr.replace(/^[a-z_]+\s*\(\s*(distinct\s+)?/i, '').replace(/\)\s*$/, '') : undefined;
  const sourceColumn = inner && /^[a-z_][a-z0-9_.]*$/i.test(inner) ? lastSqlSegment(inner) : undefined;
  return { output, expr, ...(aggregate ? { aggregate } : {}), ...(sourceColumn ? { sourceColumn } : {}) };
}

/**
 * The SELECT items of a plain single-query SELECT, with comments and extra
 * whitespace removed. `isSimple` is false for CTEs, set operations and anything
 * else the structural reader does not trust; `items` is then empty.
 */
export function readSelectList(sql: string): { body: string; isSimple: boolean; items: SelectItem[] } {
  const body = sql.trim().replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const isSimple = /^\s*select\b/i.test(body) && !/\bunion\b/i.test(body);
  const selectList = isSimple ? sqlClause(body, 'SELECT', ['FROM']) : undefined;
  return { body, isSimple, items: selectList ? splitSqlTopLevel(selectList, ',').map(parseSelectItem) : [] };
}

/**
 * The columns a block groups by as the certified matcher sees them: the plain
 * (non-aggregate) SELECT outputs, by alias, which also covers `GROUP BY ALL`
 * and `GROUP BY 1`. A block whose SQL cannot be read this way falls back to its
 * declared dimensions.
 */
export function contractGroupingColumns(sql: string, declaredDimensions: readonly string[] = []): string[] {
  const plain = readSelectList(sql).items.filter((item) => !item.aggregate).map((item) => item.output);
  return plain.length ? plain : [...declaredDimensions];
}
