/**
 * Add a user-chosen result column as a runtime filter input on a GENERATED SQL
 * answer.
 *
 * Ask already lets you change an input it inferred (`WHERE region = 'EMEA'`
 * becomes `${region}`). This is the other half: promoting a column that appears
 * in the RESULT but was never filtered — "I can see `channel` in the output, let
 * me filter by it" — into a real, reusable block parameter.
 *
 * The whole module is deliberately conservative, because injecting a predicate
 * into model-written SQL is the same class of rewrite that used to detach CTEs
 * and return unfiltered totals under a passing trust label. So:
 *
 *   - only a single top-level SELECT that the dialect parser can actually read;
 *   - only columns that trace to a REAL SOURCE COLUMN. An aggregate output such
 *     as `SUM(amount) AS revenue` never appears in `analysis.columns`, so
 *     intersecting with the result columns excludes it for free — and a filter
 *     on an aggregate would need HAVING, whose post-aggregation semantics are
 *     not what someone picking a column off a table expects;
 *   - only columns that resolve to exactly one relation, so the predicate cannot
 *     be ambiguous;
 *   - insertion positions are found with paren-depth tracking over a
 *     string/comment-masked copy, so a `GROUP BY` inside a subquery is never
 *     mistaken for the outer one.
 *
 * Anything that fails a check is simply not offered.
 */
import { analyzeSqlReferences } from '@zlens/core';

/** Clauses that must come AFTER the WHERE clause we are extending or adding. */
const TRAILING_CLAUSES = [
  'group by', 'having', 'qualify', 'window', 'order by', 'limit', 'offset', 'fetch',
];

export interface SqlFilterableColumn {
  /** Column name as it appears in the result set. */
  column: string;
  /** The predicate target, alias-qualified when the statement joins more than one relation. */
  predicateTarget: string;
}

/**
 * A generated block's SQL carries `${param}` placeholders, which no dialect
 * parser accepts. Replace each with a string literal of the SAME LENGTH so the
 * statement parses and every offset still maps onto the original text.
 */
export function placeholderSafeSql(sql: string): string {
  // A NUMERIC filler, not a quoted string: `LIMIT ${top_n}` must stay valid, and
  // `LIMIT 'xxxx'` is a parse error. A number is accepted both there and in a
  // comparison, and type correctness is irrelevant — this copy is only ever
  // parsed, never executed.
  return sql.replace(/\$\{[^}]*\}/g, (match) => '9'.repeat(match.length));
}

/**
 * Mask string literals and comments with spaces, preserving offsets so index
 * arithmetic on the masked copy applies to the original text.
 */
function maskLiteralsPreservingOffsets(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) { cursor += 2; continue; }
          break;
        }
        cursor += 1;
      }
      const end = Math.min(cursor + 1, sql.length);
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Index of `keyword` at paren depth 0, or -1. */
function topLevelKeywordIndex(masked: string, keyword: string): number {
  const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'gi');
  let depth = 0;
  const depths: number[] = new Array(masked.length).fill(0);
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    depths[index] = depth;
  }
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    if (depths[match.index] === 0) return match.index;
  }
  return -1;
}

/** Earliest top-level trailing clause, or the end of the statement. */
function insertionBoundary(masked: string): number {
  let boundary = masked.length;
  for (const clause of TRAILING_CLAUSES) {
    const index = topLevelKeywordIndex(masked, clause);
    if (index >= 0 && index < boundary) boundary = index;
  }
  return boundary;
}

/**
 * Which result columns may safely become a filter input on this SQL.
 * Returns [] whenever anything is uncertain.
 */
export function filterableResultColumns(sql: string, resultColumns: string[], dialect = 'duckdb'): SqlFilterableColumn[] {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed || resultColumns.length === 0) return [];
  const analysis = analyzeSqlReferences(placeholderSafeSql(trimmed), dialect);
  if (!analysis.parsed) return [];
  const statements = analysis.statementTypes ?? [];
  if (statements.length !== 1 || statements[0]?.toLowerCase() !== 'select') return [];
  // A CTE-bearing statement can still be filtered, but only where the outer
  // query is the one being extended; keep that out of scope rather than guess.
  if ((analysis.ctes ?? []).length > 0) return [];

  // column name -> the relations it was referenced against
  const relationsByColumn = new Map<string, Set<string>>();
  for (const reference of analysis.columns ?? []) {
    const name = reference.column?.toLowerCase();
    if (!name) continue;
    if (!relationsByColumn.has(name)) relationsByColumn.set(name, new Set());
    if (reference.relation) relationsByColumn.get(name)!.add(reference.relation);
  }
  // Every column consumed by an aggregate is an input to a measure, not a
  // dimension of the output — filtering it in WHERE changes the aggregate.
  const aggregateInputs = new Set(
    (analysis.aggregates ?? []).map((aggregate) => aggregate.column?.toLowerCase()).filter(Boolean) as string[],
  );
  const relationToAlias = new Map<string, string>();
  for (const [alias, relation] of Object.entries(analysis.aliasToRelation ?? {})) {
    if (!relationToAlias.has(relation)) relationToAlias.set(relation, alias);
  }
  const multiRelation = (analysis.tables ?? []).length > 1;

  const out: SqlFilterableColumn[] = [];
  for (const column of resultColumns) {
    const key = column.toLowerCase();
    const relations = relationsByColumn.get(key);
    // Not a source column (so: an aggregate alias or a computed expression).
    if (!relations) continue;
    if (aggregateInputs.has(key)) continue;
    // Ambiguous across joined relations — a bare predicate could mean either.
    if (relations.size > 1) continue;
    const relation = [...relations][0];
    const alias = relation ? relationToAlias.get(relation) : undefined;
    if (multiRelation && !alias) continue;
    out.push({
      column,
      predicateTarget: multiRelation && alias ? `${alias}.${column}` : column,
    });
  }
  return out;
}

/**
 * Filter fields for an App tile whose query is executed behind an outer result
 * wrapper. Certified blocks may explicitly declare dimensions that are safe to
 * filter after aggregation (for example `month` from `date_trunc(...) AS
 * month`). The generic SQL analyser cannot prove computed aliases, so merge
 * only declared dimensions that actually exist in the returned result. Measure
 * aliases remain excluded.
 */
export function dashboardFilterableResultColumns(
  sql: string,
  resultColumns: string[],
  declaredDimensions: string[] = [],
  dialect = 'duckdb',
): SqlFilterableColumn[] {
  const proven = filterableResultColumns(sql, resultColumns, dialect)
    .map((candidate) => ({ ...candidate, predicateTarget: candidate.column }));
  const byNormalizedResult = new Map(resultColumns.map((column) => [normalizeResultColumn(column), column]));
  const merged = new Map(proven.map((candidate) => [normalizeResultColumn(candidate.column), candidate]));
  for (const dimension of declaredDimensions) {
    const column = byNormalizedResult.get(normalizeResultColumn(dimension));
    if (!column) continue;
    merged.set(normalizeResultColumn(column), { column, predicateTarget: column });
  }
  return [...merged.values()];
}

function normalizeResultColumn(value: string): string {
  const parts = value.trim().toLowerCase().replace(/["`\[\]]/g, '').split('.');
  return (parts[parts.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
}

/** Render a DQL parameter default for a value of unknown type. */
function dqlParameterDefault(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Write the new SQL back into a generated block, and declare the new parameter
 * in `params`, `parameterPolicy`, `allowedFilters`, and `filterBindings`.
 *
 * Targeted edits rather than regenerating the block: the source carries curated
 * metadata (terms, grain, outputs, lineage context) that a rebuild would either
 * lose or re-infer differently.
 */
export function replaceBlockStudioSql(
  source: string,
  sql: string,
  parameterName: string,
  value: unknown,
): string {
  const escaped = sql.replace(/"""/g, '\\"\\"\\"');
  let out = source.replace(/(query\s*=\s*""")([\s\S]*?)(""")/i, (_match, open: string, _body: string, close: string) =>
    `${open}\n${escaped}\n    ${close}`);
  if (out === source) throw new Error('This answer has no editable SQL block to update.');

  const declaration = `        ${parameterName} = ${dqlParameterDefault(value)}`;
  out = /\bparams\s*\{/.test(out)
    ? out.replace(/(\bparams\s*\{)/, `$1\n${declaration}`)
    : out.replace(/(\n\s*query\s*=)/, `\n    params {\n${declaration}\n    }\n$1`);

  out = /\bparameterPolicy\s*\{/.test(out)
    ? out.replace(/(\bparameterPolicy\s*\{)/, `$1\n        ${parameterName} = "dynamic"`)
    : out.replace(/(\n\s*params\s*\{)/, `\n    parameterPolicy {\n        ${parameterName} = "dynamic"\n    }$1`);

  out = /\ballowedFilters\s*=\s*\[/.test(out)
    ? out.replace(/(\ballowedFilters\s*=\s*\[)/, `$1"${parameterName}", `)
    : out.replace(/(\n\s*parameterPolicy\s*\{)/, `\n    allowedFilters = ["${parameterName}"]$1`);

  return out;
}

export interface AddSqlResultFilterResult {
  sql: string;
  parameterName: string;
  predicateTarget: string;
}

/** Parameter names must be safe DQL identifiers and must not collide. */
function uniqueParameterName(column: string, taken: Set<string>): string {
  const base = column.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'filter';
  const seeded = /^[a-z]/.test(base) ? base : `f_${base}`;
  if (!taken.has(seeded)) return seeded;
  let suffix = 2;
  while (taken.has(`${seeded}_${suffix}`)) suffix += 1;
  return `${seeded}_${suffix}`;
}

/**
 * Inject `<column> = ${param}` into the statement's top-level WHERE, adding the
 * clause when there is none. Throws when the column is not offerable — callers
 * should have used {@link filterableResultColumns} first, so a throw here means
 * the artifact and the result disagree.
 */
export function addSqlResultFilter(
  sql: string,
  resultColumns: string[],
  column: string,
  existingParameterNames: string[] = [],
  dialect = 'duckdb',
): AddSqlResultFilterResult {
  const candidate = filterableResultColumns(sql, resultColumns, dialect)
    .find((item) => item.column.toLowerCase() === column.toLowerCase());
  if (!candidate) {
    throw new Error(`"${column}" cannot be turned into a filter input on this query.`);
  }
  const trimmed = sql.trim().replace(/;\s*$/, '');
  // Offsets are preserved by both transforms, so positions found here apply
  // directly to `trimmed`.
  const masked = maskLiteralsPreservingOffsets(placeholderSafeSql(trimmed));
  const parameterName = uniqueParameterName(candidate.column, new Set(existingParameterNames));
  const predicate = `${candidate.predicateTarget} = \${${parameterName}}`;

  const whereIndex = topLevelKeywordIndex(masked, 'where');
  const boundary = insertionBoundary(masked);
  const insertAt = whereIndex >= 0 && whereIndex < boundary ? boundary : boundary;
  const clause = whereIndex >= 0 && whereIndex < boundary ? ` AND ${predicate}` : ` WHERE ${predicate}`;

  const head = trimmed.slice(0, insertAt).replace(/\s+$/, '');
  const tail = trimmed.slice(insertAt);
  return {
    sql: `${head}${clause}${tail ? ` ${tail.replace(/^\s+/, '')}` : ''}`,
    parameterName,
    predicateTarget: candidate.predicateTarget,
  };
}
