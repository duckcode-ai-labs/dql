import { createHmac } from 'node:crypto';
import type { AskPipelineReceiptV9 } from '@zlens/agent';

/**
 * RFC 0010: AN ASK TRACE AS SOMEONE OTHER THAN THE ASKER READS IT.
 *
 * With a host, a person who reviews answers (`hint.review`, a steward or an
 * admin) may open anyone's trace to curate hints. They see how the question
 * was answered, never what the warehouse said: the detail is REBUILT from an
 * allowlist, not stripped field by field. Receipts quote values in many places
 * (member grounding, intent filters, proofs, check messages, model replies,
 * Research headlines and drill ids, SQL literals, value-named columns), and a
 * field added tomorrow is left out until it is classified here.
 *
 * Hashes are values too: an unkeyed sha256 of a statement, a result or a
 * chosen option lets a reader confirm a guess ("is it 'Philadelphia'?"). Every
 * fingerprint a reviewer gets is re-keyed with the host's trace secret, per
 * trace (`hmac:…`), or left out; exact row counts become ranges.
 */

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recs = (value: unknown): Rec[] => arr(value).map(rec).filter((item): item is Rec => Boolean(item));
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
/** A short code or enum value (`no_certified_block`, `exploratory`, `prepared`). */
const code = (value: unknown): string | undefined => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : undefined);
/** A vocabulary or catalog ref (`metric:orders.order_total`, `"jaffle_shop"."dev"."orders"`): no spaces, quotes or `=`. */
const ident = (value: unknown): string | undefined => (typeof value === 'string' && /^[A-Za-z0-9_.:@/$"`[\]-]{1,300}$/.test(value) ? value : undefined);
const idents = (value: unknown): string[] => arr(value).map(ident).filter((item): item is string => Boolean(item));
/** A ref of the vocabulary's own kinds; anything else in a candidate-id slot may be a value. */
const VOCABULARY_REF = /^(?:metric|measure|dimension|entity|column|relation|block|term|skill|hint|concept|relationship|model|source|policy|domain):[A-Za-z0-9_.:"`/@-]{1,280}$/;
const defined = <T extends Rec>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
const numbers = (value: unknown): Record<string, number> | undefined => {
  const record = rec(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) if (code(key) && num(item) !== undefined) out[key] = num(item)!;
  return out;
};

/** How many rows, as a range: an exact count can confirm a guess about the data. */
export function rowCountBucket(count: unknown): string | undefined {
  const n = num(count);
  if (n === undefined) return undefined;
  return n <= 0 ? 'none' : n === 1 ? '1' : n <= 10 ? '2-10' : n <= 100 ? '11-100' : n <= 1000 ? '101-1000' : 'more than 1000';
}

// ── SQL ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a dialect's SQL may hold, by connection driver. A driver not listed is read every way. */
const DIALECTS: Record<string, { doubleQuoteIdentifier: boolean; hashComments: boolean; tripleQuotes: boolean; nestedComments: boolean; qQuotes: boolean; brackets?: boolean }> = {
  duckdb: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  motherduck: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  postgres: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  postgresql: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  redshift: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  snowflake: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: false },
  trino: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: false },
  presto: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: false },
  athena: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: false },
  sqlserver: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false, brackets: true },
  mssql: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false, brackets: true },
  oracle: { doubleQuoteIdentifier: true, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: true },
  clickhouse: { doubleQuoteIdentifier: true, hashComments: true, tripleQuotes: false, nestedComments: true, qQuotes: false },
  mysql: { doubleQuoteIdentifier: false, hashComments: true, tripleQuotes: false, nestedComments: false, qQuotes: false },
  mariadb: { doubleQuoteIdentifier: false, hashComments: true, tripleQuotes: false, nestedComments: false, qQuotes: false },
  bigquery: { doubleQuoteIdentifier: false, hashComments: true, tripleQuotes: true, nestedComments: false, qQuotes: false },
  databricks: { doubleQuoteIdentifier: false, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  spark: { doubleQuoteIdentifier: false, hashComments: false, tripleQuotes: false, nestedComments: true, qQuotes: false },
  sqlite: { doubleQuoteIdentifier: false, hashComments: false, tripleQuotes: false, nestedComments: false, qQuotes: false, brackets: true },
};

interface LiteralReading { backslash: boolean; doubleQuoteString: boolean; tripleQuote: boolean; hashComment: boolean; nested: boolean; qQuote: boolean; brackets: boolean; keepQuoted?: (content: string) => boolean }
const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

/** Marks the contents of every string literal, quoted string, dollar-quoted string and comment under one reading of the SQL. */
function markLiterals(sql: string, masked: Uint8Array, reading: LiteralReading): void {
  const n = sql.length;
  const mark = (from: number, to: number) => { for (let k = Math.max(0, from); k < Math.min(n, to); k += 1) masked[k] = 1; };
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || (reading.hashComment && c === '#')) {
      const end = sql.indexOf('\n', i + 1);
      const stop = end < 0 ? n : end;
      mark(i + (c === '#' ? 1 : 2), stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (reading.nested && sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      mark(i + 2, depth > 0 ? n : j - 2);
      i = j;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag, i + tag.length);
        mark(i + tag.length, end < 0 ? n : end);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    // Oracle's alternative quoting: q'[ … ]', q'{ … }', q'! … !'.
    if (reading.qQuote && (c === 'q' || c === 'Q') && next === "'" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '') && i + 2 < n) {
      const open = sql[i + 2]!;
      const close = `${Q_CLOSE[open] ?? open}'`;
      const end = sql.indexOf(close, i + 3);
      mark(i + 3, end < 0 ? n : end);
      i = end < 0 ? n : end + close.length;
      continue;
    }
    if (c === '`') {
      const end = sql.indexOf('`', i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // SQL Server and SQLite read [ … ] as a name (`]]` is one `]`): a quote inside it starts no string.
    if (c === '[' && reading.brackets) {
      let j = i + 1;
      while (j < n && !(sql[j] === ']' && sql[j + 1] !== ']')) j += sql[j] === ']' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '"' && !reading.doubleQuoteString) {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      if (reading.tripleQuote && sql.startsWith(c.repeat(3), i)) {
        const end = sql.indexOf(c.repeat(3), i + 3);
        mark(i + 3, end < 0 ? n : end);
        i = end < 0 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const ch = sql[j]!;
        if (reading.backslash && ch === '\\') { j += 2; continue; }
        if (ch === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      // On a dialect where "…" may be a string, a "…" that names one of the project's relations or columns is read as
      // the identifier it is, so the tables and joins stay readable.
      if (!(c === '"' && reading.keepQuoted?.(sql.slice(i + 1, j)))) mark(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
}

const NUMBER = /(?<![\p{L}\p{N}\p{M}_$"`])(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)(?![\p{L}\p{N}\p{M}_$])/gu;

/**
 * A statement with every literal masked: the contents of each string (`'?'`), each number (`?`), each comment.
 * Which quotes, escapes and comments a statement may hold differs by dialect, so the SQL is read every way the
 * connection's dialect allows (every way at all when the dialect is not known: `"…"` as a string, `#` comments,
 * nested comments, BigQuery triple quotes, Oracle `q'[…]'`, with and without backslash escapes) and whatever is a
 * literal in ANY reading is masked. Reading too much as a literal only hides more.
 */
export function maskSqlLiterals(sql: string, dialect?: string, keepQuoted?: (content: string) => boolean): string {
  const profile = DIALECTS[(dialect ?? '').toLowerCase()];
  const either = [false, true];
  const masked = new Uint8Array(sql.length);
  for (const backslash of either) {
    for (const doubleQuoteString of profile ? [!profile.doubleQuoteIdentifier] : either) {
      for (const tripleQuote of profile ? [profile.tripleQuotes] : either) {
        for (const hashComment of profile ? [profile.hashComments] : either) {
          for (const nested of profile ? [profile.nestedComments] : either) {
            for (const qQuote of profile ? [profile.qQuotes] : either) {
              for (const brackets of profile ? [profile.brackets === true] : either) markLiterals(sql, masked, { backslash, doubleQuoteString, tripleQuote, hashComment, nested, qQuote, brackets, ...(keepQuoted ? { keepQuoted } : {}) });
            }
          }
        }
      }
    }
  }
  for (const match of sql.matchAll(NUMBER)) {
    const start = match.index ?? 0;
    for (let k = start; k < start + match[0].length; k += 1) masked[k] = 1;
  }
  let out = '';
  for (let k = 0; k < sql.length; k += 1) {
    if (!masked[k]) out += sql[k];
    else if (k === 0 || !masked[k - 1]) out += '?';
  }
  return out;
}

/**
 * Names a result column or a SQL identifier may keep: what the project itself names (the catalog the Ask host knows:
 * relations and their parts, their columns, metrics, measures, dimensions, entities, models and block outputs; and the
 * refs, Dataset metrics and dimensions and relations of this run). Anything else may be a value the model named
 * something after (`AS Chicago`, a pivot, a CTE column) and is renamed, the same way everywhere it appears.
 */
export class ColumnNames {
  private readonly known = new Set<string>();
  private readonly renamed = new Map<string, string>();
  private tables = 0;
  private columns = 0;
  constructor(names: Iterable<string>) { for (const name of names) this.add(name); }
  add(name: string): void {
    const clean = unquote(name).toLowerCase();
    if (clean) this.known.add(clean);
  }
  /** Every part of a ref (`metric:orders.order_total` → orders, order_total) is a name the project uses. */
  addRef(ref: string): void {
    for (const part of ref.replace(/^[a-z_]+:/i, '').split(/[.:/]/)) this.add(part);
  }
  isKnown(name: string): boolean { return this.known.has(unquote(name).toLowerCase()); }
  /** The name as a reviewer reads it: kept when known, otherwise `column_<n>` (or `t_<n>` for a table alias), the same everywhere. */
  name(name: string, kind: 'column' | 'table' = 'column'): string {
    if (this.isKnown(name)) return name;
    const key = unquote(name).toLowerCase();
    if (!this.renamed.has(key)) this.renamed.set(key, kind === 'table' ? `t_${++this.tables}` : `column_${++this.columns}`);
    return this.renamed.get(key)!;
  }
}

const unquote = (name: string) => name.trim().replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"').trim();

/** Words SQL itself uses (keywords, types, date parts): not names a model chose. */
const SQL_WORDS = new Set(`
select from where group by order having limit offset join inner left right full outer cross on using as and or not in is null like ilike rlike
between case when then else end distinct all any some union intersect except minus with recursive asc desc nulls first last over partition
rows range groups unbounded preceding following current row true false interval cast try_cast exists filter within top fetch next only
lateral natural qualify window tablesample values set escape similar to at zone collate pivot unpivot for apply grouping sets cube rollup
day days month months year years week weeks quarter quarters hour hours minute minutes second seconds millisecond milliseconds microsecond
epoch dow doy isodow isoyear dayofweek dayofyear century decade millennium timezone
int integer bigint smallint tinyint hugeint ubigint uinteger usmallint utinyint int2 int4 int8 int64 float float4 float8 float64 double real
decimal numeric number varchar nvarchar char nchar character varying text string date datetime datetime2 time timestamp timestamptz
timestamp_ntz timestamp_tz timestamp_ltz boolean bool interval json jsonb variant bytes bytea blob uuid struct array map object signed
unsigned materialized precision unique primary key default returning
`.trim().split(/\s+/));

const IDENT_CHAR = /[\p{L}\p{N}\p{M}_$]/u;
const IDENT_START = /[\p{L}\p{M}_]/u;

/** SQL's structural words: where one stands without AS after an expression, it is SQL, not an alias. */
const STRUCTURAL_WORDS = new Set(`
select from where group by order having limit offset join inner left right full outer cross on using as and or not in is null like ilike rlike
between case when then else end distinct all any some union intersect except minus with recursive asc desc nulls first last over partition
rows range groups unbounded preceding following current row true false interval cast try_cast exists filter within fetch next only lateral
natural qualify window tablesample values set escape similar to at zone collate pivot unpivot for apply grouping sets cube rollup
materialized unique primary default returning precision varying
`.trim().split(/\s+/));

/** Dialects that read [name] as an identifier (an unknown one may, too). */
const BRACKET_DIALECTS = new Set(['sqlserver', 'mssql', 'fabric', 'synapse', 'sqlite', 'sybase', 'access']);

/**
 * The masked statement (maskSqlLiterals) with every identifier the project does not name renamed, as whole tokens:
 * unquoted (any script, `2024West` too), "double-quoted", `backticked` and [bracketed] identifiers (an escaped quote
 * read as the one character it stands for), aliases with or without AS (a keyword used as an alias too), CTE names and
 * their columns, table aliases. SQL's own words and function names stay. A qualifier (`p.` in `p.total`) becomes
 * `t_<n>`, anything else `column_<n>`. Only the masker's own `"?"` is a masked value; `[…]` is an identifier where the
 * dialect reads it so and it stands where a name would, never right after an expression (an index).
 */
export function maskSqlNames(masked: string, names: ColumnNames, dialect?: string): string {
  const n = masked.length;
  const lower = (dialect ?? '').toLowerCase();
  const brackets = !lower || BRACKET_DIALECTS.has(lower) || !DIALECTS[lower];
  type Token = { start: number; end: number; name: string; open: string; close: string; word: boolean };
  const tokens: Token[] = [];
  /** The last significant character before `at`, and the word that ends there (if one does). */
  const before = (at: number): { char?: string; word?: string } => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(masked[k]!)) k -= 1;
    if (k < 0) return {};
    let w = k;
    while (w >= 0 && IDENT_CHAR.test(masked[w]!)) w -= 1;
    return { char: masked[k], ...(w < k ? { word: masked.slice(w + 1, k + 1).toLowerCase() } : {}) };
  };
  const afterExpression = (prev: { char?: string; word?: string }) => prev.char !== undefined
    && (/[)\]"`?]/.test(prev.char) || (prev.word !== undefined && !SQL_WORDS.has(prev.word)));
  let i = 0;
  while (i < n) {
    const c = masked[i]!;
    if (c === "'") { const end = masked.indexOf("'", i + 1); i = end < 0 ? n : end + 1; continue; }
    if (c === '-' && masked[i + 1] === '-') { const end = masked.indexOf('\n', i); i = end < 0 ? n : end; continue; }
    if (c === '/' && masked[i + 1] === '*') { const end = masked.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n && !(masked[j] === close && masked[j + 1] !== close)) j += masked[j] === close ? 2 : 1;
      const raw = masked.slice(i + 1, j);
      const name = raw.split(close + close).join(close);
      let identifier = raw !== '' && raw !== '?';
      // An index or a list follows an expression (`x[1]`, `f(a)[1]`); a list literal holds only masked values.
      if (c === '[') identifier = identifier && brackets && !afterExpression(before(i)) && !/^[\s?,]*$/.test(raw);
      if (identifier) tokens.push({ start: i, end: j + 1, name, open: c, close, word: false });
      // A list or an index is read on: the names inside it are tokens of their own.
      i = c === '[' && !identifier ? i + 1 : j + 1;
      continue;
    }
    const startsName = IDENT_START.test(c) || (/\p{N}/u.test(c) && /^\p{N}+[\p{L}\p{M}_$]/u.test(masked.slice(i)));
    if (startsName && !IDENT_CHAR.test(masked[i - 1] ?? '')) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(masked[j]!)) j += 1;
      tokens.push({ start: i, end: j, name: masked.slice(i, j), open: '', close: '', word: true });
      i = j;
      continue;
    }
    i += 1;
  }
  const next = (token: Token) => masked.slice(token.end).match(/^\s*(\S)/u)?.[1];
  const nextWord = (token: Token) => masked.slice(token.end).match(/^\s*([\p{L}_][\p{L}\p{N}\p{M}_$]*)/u)?.[1]?.toLowerCase();
  // A name used as a qualifier anywhere is a table (or CTE) alias.
  const qualifiers = new Set(tokens.filter((token) => masked[token.end] === '.').map((token) => unquote(token.name).toLowerCase()));
  // A function call keeps its name; a CTE's header (`p(a, b) AS (`) is not one.
  const isCall = (token: Token) => next(token) === '(' && !/^\s*\([^()]*\)\s+AS\s*\(/i.test(masked.slice(token.end));
  /** A word SQL itself uses keeps its meaning, unless it stands where an alias does. */
  const sqlWord = (token: Token): boolean => {
    const word = token.name.toLowerCase();
    if (!token.word || !SQL_WORDS.has(word)) return false;
    const prev = before(token.start);
    // After AS it names something (`AS Top`, `AS Year`), except a CAST's type (`AS INTEGER)`) or `AS MATERIALIZED (`.
    if (prev.word === 'as') return next(token) === ')' || next(token) === '(';
    // Without AS, a non-structural word right after an expression and before `,`, FROM or the end is an alias (`SUM(x) Year,`).
    const aliasEnd = next(token) === undefined || next(token) === ',' || nextWord(token) === 'from';
    return !(afterExpression(prev) && aliasEnd && !STRUCTURAL_WORDS.has(word));
  };
  let out = '';
  let at = 0;
  for (const token of tokens) {
    const keep = names.isKnown(token.name) || sqlWord(token) || (token.word && !SQL_WORDS.has(token.name.toLowerCase()) && isCall(token));
    if (keep) continue;
    const renamed = names.name(token.name, qualifiers.has(unquote(token.name).toLowerCase()) ? 'table' : 'column');
    out += masked.slice(at, token.start) + (token.word ? renamed : `${token.open}${renamed}${token.close}`);
    at = token.end;
  }
  return out + masked.slice(at);
}

// ── The pipeline receipt ───────────────────────────────────────────────────────────────────────────────────

/**
 * How each field of the Ask pipeline's receipt reaches a reviewer: kept as it is (codes, counts, timings only),
 * reduced (rebuilt from an allowlist of its own), or dropped. Every field must be named: a field added to the
 * receipt fails the typecheck until it is classified here (and the pipeline test checks a real run's receipt).
 */
export const RECEIPT_V9_FIELDS: Record<keyof AskPipelineReceiptV9, 'keep' | 'reduce' | 'drop'> = {
  version: 'keep',
  vocabularyFingerprint: 'reduce', // re-keyed
  intent: 'reduce', // refs, roles, grains and operators; never filter values, the reading or a reply
  reading: 'drop', // the question read back in words: can repeat its values
  dispatches: 'reduce', // what each AI call was for and how long it took; never its reply
  candidates: 'reduce', // tier, trust, re-keyed SQL fingerprint, engine; never the proofs
  checks: 'reduce', // which check, passed or not; never its message
  refusals: 'reduce', // tier and code; never the verbatim message
  tiers: 'reduce', // round, tier, outcome; never the detail
  executed: 'reduce', // tier, re-keyed SQL fingerprint, a row-count range, time; never the proofs
  timings: 'keep',
  reuse: 'keep',
  build: 'drop',
  uncovered: 'drop', // question words
  outOfScope: 'drop', // words or refs the question named
  coverage: 'drop', // question words
  grounding: 'drop', // member values matched in the warehouse
  failure: 'reduce', // stage, reason code, the warehouse's failure class; never the message
  warehouse: 'keep',
  lastCompletedPhase: 'keep',
  physicalBindings: 'reduce', // relation, completeness, column count
  unmet: 'reduce', // the obligation and refs; never the message
  ledger: 'drop', // the question's clauses in words
  context: 'reduce', // counts, timings, ids; the tables and joins used; never required-filter text
  policies: 'reduce',
  story: 'reduce', // phase, state, timings; titles from the phase; never details or Research program and query ids
  investigation: 'drop', // a Research run's queries, each with its own receipt, its report, and drill ids named after members
};

const STORY_TITLES: Record<string, string> = {
  context: 'Gathered the project context', read: 'Read the question', search: 'Searched the project', tier: 'Tried a governed tier',
  join: 'Chose the joins', schema: 'Wrote SQL from the tables', execute: 'Ran on the warehouse', frame: 'Framed the change',
  check: 'Checked the data', analyze: 'Analysed it', drill: 'Drilled in', verdict: 'Weighed the evidence', report: 'Wrote the report',
};

const CHECK_LABELS: Record<string, string> = {
  catalog_columns: 'Uses only tables and columns the project lists',
  stated_values: 'Applies every value the question states',
  required_filters: 'Applies the required filters',
  join_fanout: 'Joins do not count rows more than once',
  certified_joins: 'Joins certified tables on their certified keys',
  read_only: 'Is one read-only statement',
};

/** What re-keys a fingerprint for one trace: HMAC under the host's secret, so a reader cannot test a guess against it. */
export type Rekey = (fingerprint: unknown) => string | undefined;
export function traceRekey(secret: string, traceId: string): Rekey {
  const key = createHmac('sha256', secret).update(`dql-trace-review:${traceId}`).digest();
  return (fingerprint) => (typeof fingerprint === 'string' && fingerprint ? `hmac:${createHmac('sha256', key).update(fingerprint).digest('hex').slice(0, 32)}` : undefined);
}

function reducedIntent(value: unknown, names: ColumnNames): Rec | undefined {
  const intent = rec(value);
  if (!intent) return undefined;
  const predicate = (item: unknown) => { const p = rec(item); return p && ident(p.ref) ? defined({ ref: ident(p.ref), op: code(p.op), on: code(p.on) }) : undefined; };
  const measures = recs(intent.measures).map((measure) => defined({
    ref: ident(measure.ref), aggregation: code(measure.aggregation), alias: typeof measure.alias === 'string' ? names.name(measure.alias) : undefined,
    scope: arr(measure.scope).map(predicate).filter(Boolean),
  }));
  const time = rec(intent.time);
  const ordering = rec(intent.ordering);
  return defined({
    version: num(intent.version),
    kind: code(intent.kind),
    measures,
    groupBy: recs(intent.groupBy).map((group) => defined({ ref: ident(group.ref), role: code(group.role), grain: code(group.grain) })),
    display: idents(intent.display),
    filters: arr(intent.filters).map(predicate).filter(Boolean),
    ...(ordering ? { ordering: defined({ ref: ident(ordering.ref), direction: code(ordering.direction) }) } : {}),
    ...(time ? { time: defined({ ref: ident(time.ref), grain: code(time.grain) }) } : {}),
    limit: num(intent.limit),
    expectedShape: code(intent.expectedShape),
    population: code(intent.population),
  });
}

function reducedContext(value: unknown): Rec | undefined {
  const context = rec(value);
  if (!context) return undefined;
  const admitted = rec(context.admitted);
  const rendered = rec(context.rendered);
  const selected = rec(context.selected);
  const enforced = rec(context.enforced);
  const used = rec(context.used);
  const retrieved = rec(context.retrieved);
  const envelope = rec(context.envelope);
  const refs = (value: unknown) => idents(value).filter((item) => VOCABULARY_REF.test(item));
  return defined({
    version: num(context.version),
    timings: numbers(context.timings),
    ...(envelope ? { envelope: defined({ activeDomain: ident(envelope.activeDomain), source: code(envelope.source), confidence: code(envelope.confidence) }) } : {}),
    ...(retrieved ? { retrieved: defined({ lanes: numbers(retrieved.lanes), fused: num(retrieved.fused) }) } : {}),
    ...(admitted ? { admitted: defined({ byKind: numbers(admitted.byKind), dropped: numbers(admitted.dropped), unindexed: numbers(admitted.unindexed) }) } : {}),
    ...(rendered ? { rendered: defined({ byKind: numbers(rendered.byKind), totalChars: num(rendered.totalChars), skills: refs(rendered.skills), hints: refs(rendered.hints) }) } : {}),
    ...(selected ? { selected: defined({ refs: refs(selected.refs), byKind: numbers(selected.byKind) }) } : {}),
    ...(enforced ? {
      enforced: {
        policies: recs(enforced.policies).map((item) => defined({ policyId: ident(item.policyId), field: ident(item.field), effect: code(item.effect) })),
        requiredFilterCount: arr(enforced.requiredFilters).length,
      },
    } : {}),
    suggestedDomain: ident(context.suggestedDomain),
    ...(used ? {
      used: defined({
        relations: idents(used.relations),
        tier: code(used.tier),
        engine: code(used.engine),
        joins: recs(used.joins).map((join) => defined({
          source: ident(join.source), relationshipId: ident(join.relationshipId), name: ident(join.name), authority: code(join.authority), scope: code(join.scope),
          relations: idents(join.relations),
          keys: recs(join.keys).map((key) => defined({ from: ident(key.from), to: ident(key.to) })),
        })),
      }),
    } : {}),
  });
}

/** The pipeline receipt with only structural, value-free fields (RECEIPT_V9_FIELDS). Unknown fields are left out. */
export function reviewerReceiptV9(value: unknown, rekey: Rekey, names: ColumnNames = new ColumnNames([])): Rec | undefined {
  const receipt = rec(value);
  if (!receipt) return undefined;
  const out: Rec = {};
  const executed = rec(receipt.executed);
  const failure = rec(receipt.failure);
  for (const [field, how] of Object.entries(RECEIPT_V9_FIELDS) as Array<[keyof AskPipelineReceiptV9, string]>) {
    if (how === 'drop' || receipt[field] === undefined) continue;
    const item = receipt[field];
    switch (field) {
      case 'version': out.version = num(item); break;
      case 'vocabularyFingerprint': out.vocabularyFingerprint = rekey(item); break;
      case 'timings': out.timings = numbers(item); break;
      case 'reuse': out.reuse = code(item); break;
      case 'lastCompletedPhase': out.lastCompletedPhase = code(item); break;
      case 'warehouse': { const w = rec(item); if (w) out.warehouse = defined({ attempts: num(w.attempts), failures: num(w.failures), executions: num(w.executions) }); break; }
      case 'intent': out.intent = reducedIntent(item, names); break;
      case 'dispatches':
        out.dispatches = recs(item).map((call) => defined({
          purpose: code(call.purpose), ms: num(call.ms), promptChars: num(call.promptChars), at: num(call.at), attempt: num(call.attempt), label: code(call.label), outcome: code(call.outcome),
        }));
        break;
      case 'candidates':
        out.candidates = recs(item).map((c) => defined({ tier: code(c.tier), trust: code(c.trust), sqlFingerprint: rekey(c.sqlFingerprint), engine: code(c.engine) }));
        break;
      case 'checks':
        out.checks = recs(item).map((c) => defined({ id: code(c.id), label: CHECK_LABELS[String(c.id)] ?? 'Check', passed: bool(c.passed), attempt: num(c.attempt) }));
        break;
      case 'refusals':
        out.refusals = recs(item).map((r) => defined({ tier: code(r.tier), code: code(r.code), repairable: bool(r.repairable) }));
        break;
      case 'tiers':
        out.tiers = recs(item).map((t) => defined({ round: num(t.round), tier: code(t.tier), outcome: code(t.outcome) }));
        break;
      case 'executed':
        if (executed) out.executed = defined({ tier: code(executed.tier), sqlFingerprint: rekey(executed.sqlFingerprint), rowCountBucket: rowCountBucket(executed.rowCount), ms: num(executed.ms), proofs: [] });
        break;
      case 'failure':
        if (failure) out.failure = defined({ stage: code(failure.stage), reason: code(failure.reason), ...(rec(failure.warehouse) ? { warehouse: defined({ class: code(rec(failure.warehouse)!.class) }) } : {}) });
        break;
      case 'physicalBindings':
        out.physicalBindings = recs(item).map((b) => defined({ relation: ident(b.relation), completeness: code(b.completeness), columns: num(b.columns) }));
        break;
      case 'unmet':
        out.unmet = recs(item).map((u) => defined({ obligation: code(u.obligation), refs: idents(u.refs).filter((ref) => VOCABULARY_REF.test(ref)) }));
        break;
      case 'context': out.context = reducedContext(item); break;
      case 'policies':
        out.policies = recs(item).map((p) => defined({ policyId: ident(p.policyId), field: ident(p.field), effect: code(p.effect) }));
        break;
      case 'story':
        out.story = recs(item).filter((s) => typeof s.at === 'number').map((s) => defined({
          version: num(s.version), phase: code(s.phase), title: STORY_TITLES[String(s.phase)] ?? 'A step', state: code(s.state), ms: num(s.ms), at: num(s.at),
        }));
        break;
      default: break;
    }
  }
  return defined(out);
}

// ── The trace store's own records ──────────────────────────────────────────────────────────────────────────

/** Candidate ids as a reviewer reads them: a vocabulary ref stays; anything else (a member, a value) is `candidate_<n>`. */
class CandidateIds {
  private readonly opaque = new Map<string, string>();
  id(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (VOCABULARY_REF.test(value)) return value;
    if (!this.opaque.has(value)) this.opaque.set(value, `candidate_${this.opaque.size + 1}`);
    return this.opaque.get(value);
  }
  ids(value: unknown): string[] { return arr(value).map((item) => this.id(item)).filter((item): item is string => Boolean(item)); }
}

const ENVELOPE_CODES = ['surface', 'mode', 'status', 'terminalOutcome', 'recordingStatus', 'trustState', 'selectedTier'] as const;
const ENVELOPE_IDS = ['traceId', 'rootSpanId', 'runId', 'firstIssueSpanId', 'parentTraceId', 'parentRunId'] as const;
const ENVELOPE_NUMBERS = ['version', 'durationMs', 'spanCount', 'candidateDecisionCount', 'droppedRecordCount'] as const;

/** A trace envelope from an allowlist: ids, codes, times and counts; its fingerprints re-keyed. */
export function reviewerEnvelope(value: unknown, rekey: Rekey): Rec | undefined {
  const envelope = rec(value);
  if (!envelope) return undefined;
  const out: Rec = {};
  for (const key of ENVELOPE_IDS) out[key] = ident(envelope[key]);
  for (const key of ENVELOPE_CODES) out[key] = code(envelope[key]);
  for (const key of ENVELOPE_NUMBERS) out[key] = num(envelope[key]);
  for (const key of ['startedAt', 'completedAt']) out[key] = typeof envelope[key] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(envelope[key] as string) ? envelope[key] : undefined;
  out.questionFingerprint = rekey(envelope.questionFingerprint);
  out.traceFingerprint = rekey(envelope.traceFingerprint);
  out.snapshotId = rekey(envelope.snapshotId);
  // The store keeps a thread as a hash of its id: keyed like the rest, it still groups a thread's turns.
  out.threadId = rekey(envelope.threadId);
  return defined(out);
}

function reviewerSpanPayload(value: unknown, ids: CandidateIds): Rec | undefined {
  const payload = rec(value);
  const kind = code(payload?.kind);
  if (!payload || !kind) return undefined;
  switch (kind) {
    case 'stage': return defined({ kind, route: code(payload.route), requestedMode: code(payload.requestedMode), count: num(payload.count) });
    case 'snapshot': return defined({ kind, freshness: code(payload.freshness) });
    case 'retrieval': return defined({ kind, source: code(payload.source), lane: code(payload.lane), candidateCount: num(payload.candidateCount), coverage: code(payload.coverage) });
    case 'meaning': return defined({ kind, selectedCandidateIds: ids.ids(payload.selectedCandidateIds), rejectedCandidateIds: ids.ids(payload.rejectedCandidateIds), source: code(payload.source) });
    case 'cascade': {
      const decision = rec(payload.decision) ?? {};
      return {
        kind,
        decision: defined({
          selectedTier: code(decision.selectedTier), planFrozen: bool(decision.planFrozen), stopReason: code(decision.stopReason), requiresDeclaredFiscalCalendar: bool(decision.requiresDeclaredFiscalCalendar),
          sourceCoverage: recs(decision.sourceCoverage).map((item) => defined({ source: code(item.source), status: code(item.status), candidateIds: ids.ids(item.candidateIds) })),
          attempts: recs(decision.attempts).map((item) => defined({ tier: code(item.tier), outcome: code(item.outcome), candidateIds: ids.ids(item.candidateIds), planFrozen: bool(item.planFrozen) })),
        }),
      };
    }
    case 'provider': {
      const attempt = rec(payload.attempt) ?? {};
      return {
        kind,
        attempt: defined({
          version: num(attempt.version), phase: code(attempt.phase), purpose: code(attempt.purpose), physicalAttemptIndex: num(attempt.physicalAttemptIndex), readiness: code(attempt.readiness), admission: code(attempt.admission),
          httpStatusClass: code(attempt.httpStatusClass), retryable: bool(attempt.retryable), safeAction: code(attempt.safeAction), cause: code(attempt.cause),
          transportOutcome: code(attempt.transportOutcome), processOutcome: code(attempt.processOutcome), provenance: code(attempt.provenance),
        }),
      };
    }
    case 'tool': {
      const call = rec(payload.call) ?? {};
      return { kind, call: defined({ version: num(call.version), toolKind: code(call.toolKind), attemptIndex: num(call.attemptIndex), safeErrorCode: code(call.safeErrorCode) }) };
    }
    case 'sql': {
      const execution = rec(payload.execution) ?? {};
      return { kind, execution: defined({ version: num(execution.version), tier: code(execution.tier), validationReason: code(execution.validationReason), executionReason: code(execution.executionReason), reviewRequired: bool(execution.reviewRequired) }) };
    }
    case 'result': return defined({ kind, rowCountBucket: rowCountBucket(payload.rowCount), trustState: code(payload.trustState), failureCode: code(payload.failureCode), safeAction: code(payload.safeAction) });
    case 'conversation': return defined({ kind, continuation: bool(payload.continuation), persisted: bool(payload.persisted), binding: code(payload.binding) });
    case 'research': return defined({
      kind, verdict: code(payload.verdict), branchCount: num(payload.branchCount), evidenceKind: code(payload.evidenceKind), lineageStatus: code(payload.lineageStatus), lineageResolution: code(payload.lineageResolution),
      upstreamNodeCount: num(payload.upstreamNodeCount), downstreamNodeCount: num(payload.downstreamNodeCount), lineageTruncated: bool(payload.lineageTruncated), branchBudgetMs: num(payload.branchBudgetMs), branchStopReason: code(payload.branchStopReason),
    });
    case 'persistence': return defined({ kind, recordingStatus: code(payload.recordingStatus), droppedRecordCount: num(payload.droppedRecordCount) });
    default: return { kind };
  }
}

/** Spans from an allowlist: names, timings, outcomes and codes, and a payload of codes and counts (no fingerprint). */
export function reviewerSpans(value: unknown, ids: CandidateIds = new CandidateIds()): Rec[] {
  return recs(value).map((span) => defined({
    version: num(span.version), traceId: ident(span.traceId), spanId: ident(span.spanId), parentSpanId: ident(span.parentSpanId), ordinal: num(span.ordinal),
    name: code(span.name), stage: code(span.stage), startedAt: str(span.startedAt), completedAt: str(span.completedAt), durationMs: num(span.durationMs),
    outcome: code(span.outcome), reasonCode: code(span.reasonCode), payload: reviewerSpanPayload(span.payload, ids) ?? {},
  }));
}

function reviewerCandidateDecisions(value: unknown, ids: CandidateIds): Rec[] {
  return recs(value).map((item) => defined({
    version: num(item.version), traceId: ident(item.traceId), sequence: num(item.sequence), candidateId: ids.id(item.candidateId), role: code(item.role), source: code(item.source),
    lane: code(item.lane), laneRank: num(item.laneRank), lanes: recs(item.lanes).map((lane) => defined({ lane: code(lane.lane), rank: num(lane.rank) })), fusedRank: num(item.fusedRank),
    reciprocalRankScore: num(item.reciprocalRankScore), decision: code(item.decision), reasonCode: code(item.reasonCode), compatibilityCode: code(item.compatibilityCode),
  }));
}

function reviewerLinks(value: unknown): Rec[] {
  return recs(value).map((link) => defined({
    version: num(link.version), kind: code(link.kind), sourceTraceId: ident(link.sourceTraceId), sourceRunId: ident(link.sourceRunId), targetTraceId: ident(link.targetTraceId), targetRunId: ident(link.targetRunId), createdAt: str(link.createdAt),
  }));
}

/** The V4 decision summary from an allowlist: counts, enums and its fingerprint re-keyed. A field added later stays out. */
export function reviewerDecisionSummary(value: unknown, rekey: Rekey): Rec | undefined {
  const summary = rec(value);
  if (!summary) return undefined;
  const understood = rec(summary.understoodRequest);
  const ranking = rec(understood?.ranking);
  const selected = rec(summary.selectedPlan);
  const incident = rec(summary.terminalIncident);
  const branches = rec(summary.researchBranchSummary);
  return defined({
    version: num(summary.version),
    summaryFingerprint: rekey(summary.summaryFingerprint),
    ...(understood ? {
      understoodRequest: defined({
        measures: num(understood.measures), dimensions: num(understood.dimensions), entityRequested: bool(understood.entityRequested), outputCount: num(understood.outputCount),
        ...(ranking ? { ranking: defined({ direction: code(ranking.direction), limit: num(ranking.limit), defaultedLimit: bool(ranking.defaultedLimit) }) } : {}),
        conversationBinding: code(understood.conversationBinding),
      }),
    } : {}),
    evidenceByRole: recs(summary.evidenceByRole).map((item) => defined({ role: code(item.role), candidateCount: num(item.candidateCount) })),
    tierDecisions: recs(summary.tierDecisions).map((item) => defined({ tier: code(item.tier), outcome: code(item.outcome), planFrozen: bool(item.planFrozen) })),
    ...(selected ? { selectedPlan: defined({ tier: code(selected.tier), planFrozen: bool(selected.planFrozen), reviewRequired: bool(selected.reviewRequired) }) } : {}),
    ...(incident ? { terminalIncident: defined({ version: num(incident.version), code: code(incident.code), boundary: code(incident.boundary), origin: code(incident.origin), impact: code(incident.impact), safeAction: code(incident.safeAction) }) } : {}),
    ...(branches ? {
      researchBranchSummary: defined({
        version: num(branches.version), totalBranches: num(branches.totalBranches), completedBranches: num(branches.completedBranches), receiptBackedBranches: num(branches.receiptBackedBranches),
        failedBranches: num(branches.failedBranches), timedOutBranches: num(branches.timedOutBranches), skippedBranches: num(branches.skippedBranches), partialSuccess: bool(branches.partialSuccess),
        failureReasons: recs(branches.failureReasons).map((item) => defined({ code: code(item.code), branchCount: num(item.branchCount) })),
        availableChildPlans: recs(branches.availableChildPlans).map((item) => defined({ tier: code(item.tier), frozenPlanCount: num(item.frozenPlanCount), branchCount: num(item.branchCount), reviewRequired: bool(item.reviewRequired) })),
        linkedChildRunCount: num(branches.linkedChildRunCount), safeAction: code(branches.safeAction),
      }),
    } : {}),
    safeNextAction: code(summary.safeNextAction),
  });
}

// ── The answer and the whole detail ────────────────────────────────────────────────────────────────────────

/** The names a reviewer may see in a run's result and SQL (see ColumnNames). */
export function columnNamesOfRun(run: unknown, catalog: Iterable<string> = []): ColumnNames {
  const names = new ColumnNames(catalog);
  const record = rec(run);
  const receipt = rec(record?.diagnosticReceiptV9);
  const intent = rec(receipt?.intent);
  const refs: string[] = [];
  for (const measure of recs(intent?.measures)) {
    refs.push(...[measure.ref, rec(measure.derived)?.numerator, rec(measure.derived)?.denominator].filter((ref): ref is string => typeof ref === 'string'));
    refs.push(...recs(measure.scope).map((p) => p.ref).filter((ref): ref is string => typeof ref === 'string'));
  }
  for (const list of [intent?.groupBy, intent?.filters]) refs.push(...recs(list).map((item) => item.ref).filter((ref): ref is string => typeof ref === 'string'));
  refs.push(...idents(intent?.display), ...idents(rec(rec(receipt?.context)?.selected)?.refs));
  if (typeof rec(intent?.ordering)?.ref === 'string') refs.push(rec(intent!.ordering)!.ref as string);
  if (typeof rec(intent?.time)?.ref === 'string') refs.push(rec(intent!.time)!.ref as string);
  for (const ref of refs) if (VOCABULARY_REF.test(ref)) names.addRef(ref);
  const relations = [...idents(rec(rec(receipt?.context)?.used)?.relations), ...recs(receipt?.physicalBindings).map((b) => ident(b.relation)).filter((name): name is string => Boolean(name))];
  for (const relation of relations) for (const part of relation.match(/"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*/g) ?? []) names.add(part);
  for (const artifact of recs(record?.artifacts)) {
    const payload = rec(artifact.payload);
    const dql = rec(payload?.dqlArtifact);
    for (const name of [...idents(dql?.metrics), ...idents(dql?.dimensions)]) names.add(name);
    // A result column the answer tied to a vocabulary ref is the project's own name.
    for (const meta of recs(rec(payload?.result)?.columnsMeta)) if (typeof meta.name === 'string' && typeof meta.ref === 'string' && VOCABULARY_REF.test(meta.ref)) names.add(meta.name);
  }
  return names;
}

/** The answer a trace explains (runtimeAnswerV1), reduced: how the turn ended, the SQL masked, column names, a row-count range. */
export function reviewerAnswer(value: unknown, dialect?: string, names: ColumnNames = new ColumnNames([])): Rec | undefined {
  const answer = rec(value);
  if (!answer) return undefined;
  const gap = rec(answer.gap);
  const dql = rec(answer.dqlArtifact);
  // The SQL first, so a name is numbered where it first appears.
  const sql = typeof answer.sql === 'string' ? maskSqlNames(maskSqlLiterals(answer.sql, dialect, (content) => names.isKnown(content)), names, dialect) : undefined;
  const columns = arr(answer.columns).map((column) => (typeof column === 'string' ? column : str(rec(column)?.name))).filter((name): name is string => Boolean(name)).map((name) => names.name(name));
  return defined({
    status: code(answer.status),
    ...(gap ? { gap: defined({ kind: code(gap.kind) }) } : {}),
    failedStage: code(answer.failedStage),
    ...(typeof answer.executionError === 'string' ? { executionErrorWithheld: true } : {}),
    certifiedBlockRef: ident(answer.certifiedBlockRef),
    ...(sql !== undefined ? { sql, sqlLiteralsMasked: true } : {}),
    ...(Array.isArray(answer.sqlParams) ? { sqlParamCount: answer.sqlParams.length } : {}),
    ...(dql ? { dqlArtifact: defined({ kind: code(dql.kind), name: ident(dql.name), metrics: idents(dql.metrics), dimensions: idents(dql.dimensions) }) } : {}),
    columns,
    rowCountBucket: rowCountBucket(answer.rowCount),
    ...(Array.isArray(answer.evaluations) ? { evaluations: recs(answer.evaluations).map((e) => defined({ id: code(e.id), passed: bool(e.passed) })) } : {}),
  });
}

/** The trace detail's own top-level fields a reviewer gets; anything else (V5, V6 and V8 receipts, new fields) is left out. */
export const REVIEWER_TRACE_FIELDS = ['envelope', 'spans', 'candidateDecisions', 'links', 'decisionSummary', 'runtimeReceiptV9', 'runtimeAnswerV1', 'runtimeMode'] as const;

export interface ReviewerTraceOptions {
  /** The host's trace secret (`traceSalt`) or the project's own: fingerprints are re-keyed under it, per trace. */
  secret: string;
  /** The connection's driver, so the SQL is read as its dialect (any other way, too, when it is not known). */
  dialect?: string;
  /** The saved run, for the names its result and SQL may keep (ColumnNames). */
  run?: unknown;
  /** The names the project itself uses (the Ask host's catalog: relations, columns, metrics, dimensions, block outputs). */
  catalog?: Iterable<string>;
}

/** The trace detail as a reviewer who is not the asker reads it: rebuilt from REVIEWER_TRACE_FIELDS, with `valuesWithheld: true`. */
export function traceDetailForReviewer(detail: Rec, options: ReviewerTraceOptions): Rec {
  const traceId = str(rec(detail.envelope)?.traceId) ?? '';
  const rekey = traceRekey(options.secret, traceId);
  const names = columnNamesOfRun(options.run, options.catalog);
  const ids = new CandidateIds();
  const out: Rec = { valuesWithheld: true };
  for (const field of REVIEWER_TRACE_FIELDS) {
    if (detail[field] === undefined) continue;
    switch (field) {
      case 'envelope': out.envelope = reviewerEnvelope(detail.envelope, rekey); break;
      case 'spans': out.spans = reviewerSpans(detail.spans, ids); break;
      case 'candidateDecisions': out.candidateDecisions = reviewerCandidateDecisions(detail.candidateDecisions, ids); break;
      case 'links': out.links = reviewerLinks(detail.links); break;
      case 'decisionSummary': out.decisionSummary = reviewerDecisionSummary(detail.decisionSummary, rekey); break;
      // The answer first: the names its SQL reads are learnt before the receipt's aliases are named.
      case 'runtimeAnswerV1': break;
      case 'runtimeReceiptV9': break;
      case 'runtimeMode': out.runtimeMode = code(detail.runtimeMode); break;
    }
  }
  if (detail.runtimeAnswerV1 !== undefined) out.runtimeAnswerV1 = reviewerAnswer(detail.runtimeAnswerV1, options.dialect, names);
  if (detail.runtimeReceiptV9 !== undefined) out.runtimeReceiptV9 = reviewerReceiptV9(detail.runtimeReceiptV9, rekey, names);
  return defined(out);
}

/** A trace list entry for a reviewer who is not the asker: the envelope rebuilt, the preview, label and reason as given. */
export function traceListEntryForReviewer(entry: Rec, secret: string): Rec {
  const rekey = traceRekey(secret, str(entry.traceId) ?? '');
  return defined({
    ...reviewerEnvelope(entry, rekey),
    detailAvailable: bool(entry.detailAvailable),
    questionPreview: str(entry.questionPreview),
    scenarioLabel: str(entry.scenarioLabel),
    reason: str(entry.reason),
    runtimeMode: code(entry.runtimeMode),
  });
}
