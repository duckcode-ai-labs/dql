/**
 * THE VALUE PROFILE: what the warehouse's columns actually hold.
 *
 * A column list says `order_moment_delivered TEXT`; it does not say the text
 * reads `12/31/2021 11:45 PM`, that an id is padded with a space, or that a
 * status is spelled `delivered` and not `Delivered`. A drafter that cannot see
 * the stored values guesses them, and a query that parses no date or matches
 * no key runs and returns a wrong number. A few example values per column, and
 * the range of each number, are what an analyst reads before writing SQL.
 *
 * Those values leave the machine with the prompt, so the profile is opt-in:
 * `agent.valueProfile.mode: "sampled"` in dql.config.json. Columns whose names
 * say they hold contact details, credentials or identity documents are never
 * read, and a project can exclude more. The profile is a cache
 * (`.dql/cache/value-profile.json`), rebuilt at every schema sync, so stored
 * values never reach git.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDialect, type WarehouseCatalogSnapshotV1 } from '@duckcodeailabs/dql-core';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';

export const VALUE_PROFILE_PATH = join('.dql', 'cache', 'value-profile.json');

export interface ColumnValueProfile {
  /** The most frequent stored values, as text, at most three. */
  examples?: string[];
  min?: string;
  max?: string;
}

export interface ValueProfileV1 {
  version: 1;
  /** The catalog this profile describes: a profile of another catalog is not used. */
  catalogFingerprint: string;
  capturedAt: string;
  /** By relation as the catalog spells it, then by column name. */
  relations: Record<string, Record<string, ColumnValueProfile>>;
  /** Columns left out because their names mark them sensitive. */
  skippedSensitive: number;
}

export interface ValueProfilePolicy {
  mode: 'off' | 'sampled';
  /** More column-name patterns to leave out, as case-insensitive regular expressions. */
  exclude: RegExp[];
}

/**
 * Column names that hold contact details, credentials, identity documents or
 * financial accounts. Their values are never read, whatever the project says.
 */
const SENSITIVE_COLUMN = /(e_?mail|phone|mobile|fax|ssn|social_?security|national_?id|passport|licen[cs]e_?(no|number)|password|passwd|secret|token|api_?key|credit_?card|card_?(no|num)|cvv|iban|account_?(no|num)|routing|street|address|postal|zip_?code|birth|dob\b|ip_?addr|salary|tax_?id)/i;

const EXAMPLE_CHARS = 40;
const MAX_COLUMNS_PER_RELATION = 80;
const SAMPLE_ROWS = 50_000;

export function resolveValueProfilePolicy(config: { agent?: { valueProfile?: { mode?: string; exclude?: string[] } } } | undefined): ValueProfilePolicy {
  const configured = config?.agent?.valueProfile;
  const exclude: RegExp[] = [];
  for (const pattern of configured?.exclude ?? []) {
    try { exclude.push(new RegExp(pattern, 'i')); } catch { /* an invalid pattern excludes nothing */ }
  }
  return { mode: configured?.mode === 'sampled' ? 'sampled' : 'off', exclude };
}

export function isSensitiveColumn(column: string, policy: Pick<ValueProfilePolicy, 'exclude'>): boolean {
  return SENSITIVE_COLUMN.test(column) || policy.exclude.some((pattern) => pattern.test(column));
}

const NUMERIC_TYPE = /\b(int|integer|bigint|smallint|tinyint|real|float|double|numeric|decimal|number)\b/i;

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const rendered = value instanceof Date ? value.toISOString() : String(value);
  return rendered.length > EXAMPLE_CHARS ? `${rendered.slice(0, EXAMPLE_CHARS - 1)}…` : rendered;
}

/**
 * Read the profile of every catalog relation: one MIN/MAX query per relation
 * for its numeric columns, and one most-frequent-values query per other
 * column, each over a bounded sample of rows. Stops at the time budget and
 * keeps what it read.
 */
export async function profileWarehouseValues(input: {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  snapshot: WarehouseCatalogSnapshotV1;
  policy: ValueProfilePolicy;
  budgetMs?: number;
  now?: () => number;
}): Promise<ValueProfileV1> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? 120_000);
  const dialect = getDialect(input.connection.driver);
  const quote = (name: string) => dialect.quoteIdentifier(name);
  const options = { maxRows: 5, maxBytes: 1024 * 1024, deadlineMs: 10_000 };
  const relations: ValueProfileV1['relations'] = {};
  let skippedSensitive = 0;
  const run = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    try {
      const result = await input.executor.executePositional(sql, [], input.connection, options);
      return (result.rows ?? []) as Array<Record<string, unknown>>;
    } catch {
      // A column the engine cannot group or compare is left without a profile.
      return [];
    }
  };
  for (const relation of input.snapshot.relations) {
    if (now() > deadline) break;
    const table = relation.relation.split('.').map((part) => quote(part.replace(/^"|"$/g, ''))).join('.');
    const columns = relation.columns.slice(0, MAX_COLUMNS_PER_RELATION).filter((column) => {
      if (!isSensitiveColumn(column.name, input.policy)) return true;
      skippedSensitive += 1;
      return false;
    });
    const profile: Record<string, ColumnValueProfile> = {};
    const numeric = columns.filter((column) => NUMERIC_TYPE.test(column.type ?? ''));
    if (numeric.length) {
      const select = numeric.flatMap((column, index) => [`MIN(${quote(column.name)}) AS ${quote(`min_${index}`)}`, `MAX(${quote(column.name)}) AS ${quote(`max_${index}`)}`]).join(', ');
      const [row] = await run(`SELECT ${select} FROM (SELECT * FROM ${table} ${dialect.limitClause(SAMPLE_ROWS)}) AS sampled`);
      numeric.forEach((column, index) => {
        const min = text(row?.[`min_${index}`]);
        const max = text(row?.[`max_${index}`]);
        if (min !== undefined || max !== undefined) profile[column.name] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      });
    }
    for (const column of columns) {
      if (numeric.includes(column)) continue;
      if (now() > deadline) break;
      const name = quote(column.name);
      const rows = await run(`SELECT ${name} AS ${quote('value')}, COUNT(*) AS ${quote('n')} FROM (SELECT ${name} FROM ${table} ${dialect.limitClause(SAMPLE_ROWS)}) AS sampled WHERE ${name} IS NOT NULL GROUP BY ${name} ORDER BY COUNT(*) DESC ${dialect.limitClause(3)}`);
      const examples = rows.map((row) => text(row.value ?? row.VALUE)).filter((value): value is string => value !== undefined);
      if (examples.length) profile[column.name] = { examples };
    }
    if (Object.keys(profile).length) relations[relation.relation] = profile;
  }
  return { version: 1, catalogFingerprint: input.snapshot.fingerprint ?? '', capturedAt: new Date(now()).toISOString(), relations, skippedSensitive };
}

export function writeValueProfile(projectRoot: string, profile: ValueProfileV1): string {
  const path = join(projectRoot, VALUE_PROFILE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
  return path;
}

/** Remove the profile: the project switched it off, so no stored value reaches a prompt again. */
export function removeValueProfile(projectRoot: string): void {
  rmSync(join(projectRoot, VALUE_PROFILE_PATH), { force: true });
}

/** The profile of this catalog, or nothing: a profile of an older catalog is not evidence. */
export function readValueProfile(projectRoot: string, catalogFingerprint: string | undefined): ValueProfileV1 | undefined {
  const path = join(projectRoot, VALUE_PROFILE_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const profile = JSON.parse(readFileSync(path, 'utf-8')) as ValueProfileV1;
    if (profile?.version !== 1 || !profile.relations) return undefined;
    if (catalogFingerprint && profile.catalogFingerprint !== catalogFingerprint) return undefined;
    return profile;
  } catch {
    return undefined;
  }
}

/** One column's profile as prompt text: ` holds 'a', 'b', 'c'` or ` ranges 1 to 8000`. */
export function renderColumnProfile(profile: ColumnValueProfile | undefined): string {
  if (!profile) return '';
  if (profile.examples?.length) return ` holds ${profile.examples.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')}`;
  if (profile.min !== undefined || profile.max !== undefined) return ` ranges ${profile.min ?? '?'} to ${profile.max ?? '?'}`;
  return '';
}
