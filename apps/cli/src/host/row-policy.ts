import type {
  ConnectionConfig,
  DatabaseConnector,
  QueryExecutionOptions,
  QueryExecutor,
  QueryPurpose,
} from '@duckcodeailabs/dql-connectors';
import { analyzeSqlReferences, extractTablesFromSql } from '@duckcodeailabs/dql-core';
import { currentDestination, currentPrincipal, currentRequestContext, type DqlDestination, type DqlPrincipal, type DqlStatementObserver } from './request-context.js';
import type { DqlAction } from './route-actions.js';

/**
 * ONE QUERY PATH (RFC 0010, slice HH-3). Every statement DQL sends to a
 * warehouse — a certified Dataset, a page tile, AI-written SQL, a notebook
 * cell, a proof — goes through the server's one executor. When a host
 * supplies `rowPolicy`, that executor asks it about each statement first and
 * runs what it returns: the same SQL, a narrowed rewrite, or nothing.
 *
 * The policy sees who is asking (null for work DQL starts on its own, such
 * as a startup catalog sync), the SQL and its values, the tables it reads
 * (best effort), the connection, and whether it reads data or only schema.
 * Rewrites must keep the placeholder style of the SQL they receive.
 *
 * Cached and proven results are keyed by the signed-in person (HH-2), so a
 * policy must depend only on the person, the statement and its destination
 * (an export's results are keyed apart, HH-17). A policy that changes for
 * other reasons should carry a version in the person's attributes.
 */
export interface DqlQueryContext {
  principal: DqlPrincipal | null;
  sql: string;
  params: unknown[];
  /** Tables the statement reads, from DQL's SQL reference scan (best effort). */
  relations: string[];
  connection: { driver: string; name?: string };
  purpose: QueryPurpose;
  /**
   * HH-17: where the result goes — `person`, `model` (Ask, Research: a
   * question's answer), `delivery` (a scheduled run) or `export` (a CSV,
   * JSON or Excel file). Absent for work nobody asked for (a startup sync).
   */
  destination?: DqlDestination;
  /** HH-17: the route action of the request the statement serves (HH-2), e.g. `ask`, `export`, `app.view`. */
  action?: DqlAction;
}

export type DqlRowPolicyResult = { sql: string; params?: unknown[] } | { refuse: string };

export type DqlRowPolicy = (query: DqlQueryContext) => Promise<DqlRowPolicyResult> | DqlRowPolicyResult;

/**
 * WHOSE CREDENTIALS (RFC 0010, slice HH-4). Before any statement runs, the
 * host may resolve the connection for the person asking: their own warehouse
 * token (Snowflake External OAuth, Databricks OAuth, BigQuery end-user
 * credentials, Redshift identity propagation), a per-person role, or a
 * different target. The warehouse's own row and column rules then apply.
 * Refusing — for example an expired token — stops the query with "reconnect";
 * DQL never retries with the service credential. Connections are pooled by
 * their full settings, so each person's credentials get their own connection.
 */
export interface DqlCredentialsContext {
  principal: DqlPrincipal | null;
  /** The configured connection, without the person's credentials yet. */
  connection: ConnectionConfig;
  purpose: QueryPurpose;
}

/** Settings to lay over the connection for this person (any field but `driver`), or a refusal. */
export type DqlCredentialsResult = { connection: Partial<ConnectionConfig> } | { refuse: string };

export type DqlCredentialsHook = (input: DqlCredentialsContext) => Promise<DqlCredentialsResult> | DqlCredentialsResult;

export class CredentialsRefusedError extends Error {
  readonly code = 'CREDENTIALS_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsRefusedError';
  }
}

/** The connection as this person, or a refusal; a hook error refuses too. */
export async function resolvePersonConnection(hook: DqlCredentialsHook, config: ConnectionConfig, purpose: QueryPurpose = 'data'): Promise<ConnectionConfig> {
  let answer: DqlCredentialsResult;
  try {
    answer = await hook({ principal: currentPrincipal() ?? null, connection: { ...config }, purpose });
  } catch {
    throw new CredentialsRefusedError('DQL could not get your warehouse sign-in. Reconnect and try again.');
  }
  if (answer && 'refuse' in answer) {
    throw new CredentialsRefusedError(typeof answer.refuse === 'string' && answer.refuse.trim() ? answer.refuse.trim() : 'Reconnect to your warehouse to run this query.');
  }
  if (!answer || typeof answer.connection !== 'object' || answer.connection === null) {
    throw new CredentialsRefusedError('DQL could not get your warehouse sign-in. Reconnect and try again.');
  }
  const { driver: _ignored, ...overlay } = answer.connection;
  return { ...config, ...overlay } as ConnectionConfig;
}

export class RowPolicyRefusedError extends Error {
  readonly code = 'ROW_POLICY_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RowPolicyRefusedError';
  }
}

/**
 * The tables a statement reads: the SQL parser's answer (quoted and
 * schema-qualified names come out as `schema.table`), plus file readers such
 * as `read_parquet(...)` that only the reference scan sees. When the parser
 * cannot read the statement, the scan alone.
 */
export function relationsOf(sql: string, dialect: string): string[] {
  try {
    const scanned = extractTablesFromSql(sql).tables;
    const analysis = analyzeSqlReferences(sql, dialect);
    if (!analysis.parsed) return scanned;
    return [...new Set([...analysis.tables, ...scanned.filter((table) => table.includes('('))])];
  } catch {
    return [];
  }
}

/**
 * Every table a run's values came from, from each statement's SQL as DQL
 * wrote it (before any host rewrite), or undefined when one statement is
 * missing or names no table DQL can see — then nobody can say where all the
 * values came from.
 */
export function relationsOfStatements(statements: Array<string | undefined>, dialect: string): string[] | undefined {
  const all = new Set<string>();
  for (const sql of statements) {
    if (typeof sql !== 'string' || !sql.trim()) return undefined;
    const relations = relationsOf(sql, dialect);
    if (!relations.length) return undefined;
    for (const relation of relations) all.add(relation);
  }
  return [...all].sort();
}

/** Ask the policy about one statement; refuse on a refusal, an error, or an unusable answer. */
export async function applyRowPolicy(
  policy: DqlRowPolicy,
  sql: string,
  params: unknown[],
  connection: Pick<ConnectionConfig, 'driver'> & { name?: string },
  purpose: QueryPurpose = 'data',
): Promise<{ sql: string; params: unknown[] }> {
  let answer: DqlRowPolicyResult;
  const destination = currentDestination();
  const action = currentRequestContext()?.action;
  try {
    answer = await policy({
      principal: currentPrincipal() ?? null,
      sql,
      params: [...params],
      relations: relationsOf(sql, connection.driver),
      connection: { driver: connection.driver, ...(connection.name ? { name: connection.name } : {}) },
      purpose,
      ...(destination ? { destination } : {}),
      ...(action ? { action } : {}),
    });
  } catch {
    throw new RowPolicyRefusedError('DQL could not check what you may see, so it did not run this query.');
  }
  if (answer && 'refuse' in answer) {
    throw new RowPolicyRefusedError(typeof answer.refuse === 'string' && answer.refuse.trim() ? answer.refuse.trim() : 'You may not see the data this query reads.');
  }
  if (!answer || typeof answer.sql !== 'string' || !answer.sql.trim()) {
    throw new RowPolicyRefusedError('DQL could not check what you may see, so it did not run this query.');
  }
  return { sql: answer.sql, params: Array.isArray(answer.params) ? answer.params : params };
}

/**
 * Run one statement and tell the host's observer (HH-6) how it went and how
 * long it took. `prepare` checks the statement (row policy, the person's
 * connection); a refusal there is `refused`, a failure running it `error`.
 * The observer never sees the SQL or rows, and its errors are ignored.
 */
async function timed<R>(observe: DqlStatementObserver | undefined, config: Pick<ConnectionConfig, 'driver'>, purpose: QueryPurpose | undefined, prepare: () => Promise<{ run: () => Promise<R> }>): Promise<R> {
  if (!observe) return (await prepare()).run();
  const started = Date.now();
  const report = (outcome: 'ok' | 'error' | 'refused') => {
    try {
      void Promise.resolve(observe({ at: new Date().toISOString(), driver: String(config.driver ?? 'unknown'), purpose: purpose === 'metadata' ? 'metadata' : 'data', outcome, durationMs: Date.now() - started })).catch(() => undefined);
    } catch { /* an observer never fails a query */ }
  };
  let prepared: { run: () => Promise<R> };
  try {
    prepared = await prepare();
  } catch (error) {
    report('refused');
    throw error;
  }
  try {
    const result = await prepared.run();
    report('ok');
    return result;
  } catch (error) {
    report('error');
    throw error;
  }
}

/** A connector whose statements — direct, streamed, or in a consistent read scope — pass the policy. */
function guardConnector(connector: DatabaseConnector, policy: DqlRowPolicy | undefined, config: ConnectionConfig, observe?: DqlStatementObserver): DatabaseConnector {
  if (!policy && !observe) return connector;
  const checked = (sql: string, params: unknown[], purpose?: QueryPurpose) => (policy ? applyRowPolicy(policy, sql, params, config, purpose) : Promise.resolve({ sql, params }));
  const target = connector as DatabaseConnector & { openConsistentReadScope?: () => Promise<{ execute: DatabaseConnector['execute'] }> };
  return new Proxy(target, {
    get(object, property) {
      if (property === 'execute') {
        return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => timed(observe, config, options?.purpose, async () => {
          const allowed = await checked(sql, params, options?.purpose);
          return { run: () => object.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options) };
        });
      }
      if (property === 'stream' && typeof object.stream === 'function') {
        return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => {
          const stream = object.stream!.bind(object);
          return (async function* guarded() {
            const allowed = await checked(sql, params, options?.purpose);
            yield* stream(allowed.sql, allowed.params.length ? allowed.params : undefined, options);
          })();
        };
      }
      if (property === 'openConsistentReadScope' && typeof object.openConsistentReadScope === 'function') {
        return async () => {
          const scope = await object.openConsistentReadScope!();
          return new Proxy(scope, {
            get(inner, key) {
              if (key === 'execute') {
                return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => timed(observe, config, options?.purpose, async () => {
                  const allowed = await checked(sql, params, options?.purpose);
                  return { run: () => inner.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options) };
                });
              }
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export interface HostQueryHooks {
  rowPolicy?: DqlRowPolicy;
  credentials?: DqlCredentialsHook;
  /** HH-6: told of each statement's outcome and duration (no SQL, no values). */
  statements?: DqlStatementObserver;
}

/**
 * The server's executor with the host's query hooks in front of every
 * statement: first the person's connection (HH-4), then the row policy
 * (HH-3), then the statement. `executeQuery` expands its parameters and
 * then goes through the same guarded `executePositional`, so each
 * statement is checked once.
 */
export function withHostQueryHooks<T extends QueryExecutor>(executor: T, hooks: HostQueryHooks): T {
  const { rowPolicy, credentials, statements } = hooks;
  if (!rowPolicy && !credentials && !statements) return executor;
  const personConnection = (config: ConnectionConfig, purpose?: QueryPurpose) => (credentials ? resolvePersonConnection(credentials, config, purpose) : Promise.resolve(config));
  return new Proxy(executor, {
    get(target, property, receiver) {
      const own = Reflect.get(target, property, target);
      if (typeof own !== 'function') return own;
      if (property === 'executePositional') {
        return (sql: string, paramValues: unknown[], config: ConnectionConfig, options?: QueryExecutionOptions) => timed(statements, config, options?.purpose, async () => {
          const connection = await personConnection(config, options?.purpose);
          const allowed = rowPolicy ? await applyRowPolicy(rowPolicy, sql, paramValues ?? [], connection, options?.purpose) : { sql, params: paramValues };
          return { run: () => target.executePositional(allowed.sql, allowed.params, connection, options) };
        });
      }
      if (property === 'executeQuery') {
        // Runs the original expansion with `this` = the guarded executor.
        return (target.executeQuery as (...args: unknown[]) => unknown).bind(receiver);
      }
      if (property === 'getConnector') {
        return async (config: ConnectionConfig) => {
          const connection = await personConnection(config);
          return guardConnector(await target.getConnector(connection), rowPolicy, connection, statements);
        };
      }
      return own.bind(target);
    },
  });
}

/** The executor with only a row policy (HH-3). */
export function withRowPolicy<T extends QueryExecutor>(executor: T, policy: DqlRowPolicy): T {
  return withHostQueryHooks(executor, { rowPolicy: policy });
}
