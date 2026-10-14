import {
  lastSqlSegment as lastSegment,
  normalizeSqlText as norm,
  readSelectList,
  splitSqlTopLevel as splitTopLevel,
  sqlClause as clause,
} from '@zlens/core';

/**
 * What a certified block PROMISES, read from its declaration and its SQL.
 *
 * Certification used to be attached to the artifact: a block whose outputs
 * covered the words in a question executed as certified. The contract makes
 * the promise structural so `entails(contract, intent)` can decide whether
 * the block answers THIS intent: measures with their aggregates and static
 * scope, the grouping grain, the filters it accepts, its ordering and limit.
 */

export interface BlockContractMeasure {
  /** Output column name, e.g. `beverage_revenue`. */
  output: string;
  aggregate?: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'median';
  /** The aggregated expression, lower-cased and whitespace-normalised. */
  expr?: string;
  /** Source column the aggregate reads, when it is a plain column. */
  sourceColumn?: string;
  /** The semantic metric the block declares this output answers (`metricMappings`), validated at compile time. */
  declaredMetric?: { metric: string; filter: BlockContractPredicate[] };
}

export interface BlockContractPredicate {
  column: string;
  op: 'eq' | 'neq' | 'is_true' | 'is_false' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';
  values: string[];
}

export interface BlockContractV1 {
  version: 1;
  name: string;
  domain?: string;
  outputs: string[];
  measures: BlockContractMeasure[];
  /** Output columns that are NOT aggregates: the grouping/identity/label columns. */
  groupBy: string[];
  /** Predicates hard-coded in the WHERE clause. */
  staticScope: BlockContractPredicate[];
  /** WHERE/HAVING parts the reader could not turn into a predicate: the block restricts rows in a way the contract cannot state. */
  scopeUnparsed?: string[];
  /** A GROUP BY that is not exactly the plain SELECT items: the real grain differs from `groupBy`, and no declaration vouches for it. */
  grainUnparsed?: string[];
  /** Outputs that are `date_trunc('<grain>', <column>)`: the only way the contract can prove a block's time grain. */
  truncations?: Array<{ output: string; grain: string; column: string }>;
  /** The one table the block reads, when its FROM is a single plain relation (no join, subquery or list). */
  source?: string;
  allowedFilters: string[];
  parameters: string[];
  orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  grain?: string;
  entities: string[];
  relations: string[];
  /** True when the SQL was simple enough to read structurally; false means only declared fields are trustworthy. */
  structural: boolean;
}

export interface BlockDeclarationLike {
  name: string;
  domain?: string;
  sql?: string;
  declaredOutputs?: string[];
  outputs?: Array<string | { name: string }>;
  dimensions?: string[];
  allowedFilters?: string[];
  parameters?: Array<string | { name: string }>;
  grain?: string;
  entities?: string[];
  tableDependencies?: string[];
  rawTableRefs?: string[];
  /** Declared `metricMappings`: output column -> semantic metric, and the filter that metric is read under. */
  metricMappings?: Array<{ output: string; metric: string; filter?: string }>;
}

/** Split a WHERE clause on top-level AND. */
function splitAnd(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  const upper = text.toUpperCase();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) { current += char; if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && upper.startsWith(' AND ', index)) { parts.push(current); current = ''; index += 4; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const COMPARATORS: Record<string, BlockContractPredicate['op']> = { '=': 'eq', '<>': 'neq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

/** The predicates in a WHERE-style text, and the AND-parts that could not be read as one. */
export function parseScopePredicates(where: string | undefined): { predicates: BlockContractPredicate[]; unparsed: string[] } {
  const unparsed: string[] = [];
  if (!where) return { predicates: [], unparsed };
  const predicates = splitAnd(where).flatMap((part) => {
    const read = parsePredicates(part);
    if (read.length === 0) unparsed.push(part);
    return read;
  });
  return { predicates, unparsed };
}

function parsePredicates(where: string | undefined): BlockContractPredicate[] {
  if (!where) return [];
  return splitAnd(where).flatMap((part): BlockContractPredicate[] => {
    const text = part.trim();
    const compare = text.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(=|<>|!=|>=|<=|>|<)\s*('([^']*)'|true|false|[-\d.]+)$/i);
    if (compare) {
      const column = lastSegment(compare[1]!);
      const value = compare[4] !== undefined ? compare[4]! : compare[3]!.toLowerCase();
      if (compare[2] === '=' && (value === 'true' || value === 'false')) return [{ column, op: value === 'true' ? 'is_true' : 'is_false', values: [] }];
      return [{ column, op: COMPARATORS[compare[2]!] ?? 'eq', values: [value] }];
    }
    const bare = text.match(/^(not\s+)?([A-Za-z_][A-Za-z0-9_.]*)$/i);
    if (bare) return [{ column: lastSegment(bare[2]!), op: bare[1] ? 'is_false' : 'is_true', values: [] }];
    const inList = text.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s+in\s*\((.*)\)$/i);
    if (inList) return [{ column: lastSegment(inList[1]!), op: 'in', values: splitTopLevel(inList[2]!, ',').map((value) => value.replace(/^'|'$/g, '')) }];
    return [];
  });
}

/** Read the promise a block makes. Declared metadata always wins over what the SQL suggests. */
export function extractBlockContract(block: BlockDeclarationLike): BlockContractV1 {
  const declaredOutputs = block.declaredOutputs ?? block.outputs?.map((output) => (typeof output === 'string' ? output : output.name)) ?? [];
  const sql = (block.sql ?? '').trim();
  // The SELECT list is read in dql-core, shared with the certify-time identity warning.
  const { body, isSimple, items } = readSelectList(sql);
  const where = isSimple ? clause(body, 'WHERE', ['GROUP BY', 'ORDER BY', 'LIMIT', 'HAVING']) : undefined;
  const orderBy = isSimple ? clause(body, 'ORDER BY', ['LIMIT']) : undefined;
  const limitText = isSimple ? clause(body, 'LIMIT', []) : undefined;
  const limit = limitText && /^\d+$/.test(limitText.trim()) ? Number(limitText.trim()) : undefined;
  const declared = (output: string): Pick<BlockContractMeasure, 'declaredMetric'> => {
    const mapping = block.metricMappings?.find((candidate) => candidate.output.toLowerCase() === output.toLowerCase());
    if (!mapping) return {};
    // A declared filter that cannot be read would silently widen the mapping: it vouches for nothing.
    const filter = parseScopePredicates(mapping.filter);
    return filter.unparsed.length ? {} : { declaredMetric: { metric: mapping.metric, filter: filter.predicates } };
  };
  const measures: BlockContractMeasure[] = items
    .filter((item) => item.aggregate)
    .map((item) => ({ output: item.output, aggregate: item.aggregate, expr: item.expr, ...(item.sourceColumn ? { sourceColumn: item.sourceColumn } : {}), ...declared(item.output) }));
  // A mapping may name an output the reader cannot see as a plain aggregate (a
  // complex expression): for that column the declaration is the contract.
  for (const mapping of block.metricMappings ?? []) {
    if (!measures.some((measure) => measure.output.toLowerCase() === mapping.output.toLowerCase())) measures.push({ output: mapping.output, ...declared(mapping.output) });
  }
  const fromText = isSimple ? clause(body, 'FROM', ['WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'HAVING']) : undefined;
  const fromMatch = fromText?.match(/^([A-Za-z_"`][\w."`$-]*)(?:\s+(?:as\s+)?[A-Za-z_]\w*)?$/i);
  const having = isSimple ? clause(body, 'HAVING', ['ORDER BY', 'LIMIT']) : undefined;
  const scope = parseScopePredicates(where);
  const plainItems = items.filter((item) => !item.aggregate);
  // The grain is what the SQL really groups by, not what it selects: a GROUP BY
  // wider than the plain SELECT items returns more rows than the contract states.
  const groupText = isSimple ? clause(body, 'GROUP BY', ['HAVING', 'ORDER BY', 'LIMIT']) : undefined;
  const groupParts = groupText ? splitTopLevel(groupText, ',') : [];
  const groupIndexes = groupParts.map((part) => {
    if (/^\d+$/.test(part)) return Number(part) - 1 < items.length && !items[Number(part) - 1]!.aggregate ? plainItems.indexOf(items[Number(part) - 1]!) : -1;
    const key = norm(part);
    return plainItems.findIndex((item) => item.expr === key || item.output.toLowerCase() === key || norm(lastSegment(item.expr)) === key);
  });
  const groupMatches = groupParts.length === 1 && /^all$/i.test(groupParts[0]!)
    || (groupIndexes.every((index) => index >= 0) && plainItems.every((_, index) => groupIndexes.includes(index)));
  const grainUnparsed = groupText && !groupMatches ? [`GROUP BY ${groupText}`] : [];
  const scopeUnparsed = [...scope.unparsed, ...(having ? [`HAVING ${having}`] : [])];
  const groupBy = plainItems.map((item) => item.output);
  const outputs = declaredOutputs.length ? declaredOutputs : items.map((item) => item.output);
  const truncations = plainItems.flatMap((item) => {
    const match = item.expr.match(/^date_trunc\(\s*'([a-z]+)'\s*,\s*([a-z_][a-z0-9_."`]*)\s*\)$/);
    return match ? [{ output: item.output, grain: match[1]!, column: lastSegment(match[2]!) }] : [];
  });
  const relations = [...new Set([...(block.tableDependencies ?? []), ...(block.rawTableRefs ?? [])])];
  return {
    version: 1,
    name: block.name,
    ...(block.domain ? { domain: block.domain } : {}),
    outputs,
    measures,
    groupBy: groupBy.length ? groupBy : block.dimensions ?? [],
    staticScope: scope.predicates,
    ...(scopeUnparsed.length ? { scopeUnparsed } : {}),
    ...(grainUnparsed.length ? { grainUnparsed } : {}),
    ...(truncations.length ? { truncations } : {}),
    ...(fromMatch ? { source: fromMatch[1]!.replace(/["`]/g, '') } : {}),
    allowedFilters: block.allowedFilters ?? [],
    parameters: (block.parameters ?? []).map((parameter) => (typeof parameter === 'string' ? parameter : parameter.name)),
    ...(orderBy
      ? {
        orderBy: splitTopLevel(orderBy, ',').map((part) => {
          const match = part.match(/^(.*?)(?:\s+(asc|desc))?$/i);
          return { column: lastSegment((match?.[1] ?? part).trim()), direction: (match?.[2]?.toLowerCase() === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' };
        }),
      }
      : {}),
    ...(limit ? { limit } : {}),
    ...(block.grain ? { grain: block.grain } : {}),
    entities: block.entities ?? [],
    relations,
    structural: Boolean(isSimple && items.length > 0),
  };
}
