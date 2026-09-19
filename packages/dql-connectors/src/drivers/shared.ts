/**
 * What every networked connector does the same way: load its client library
 * from the project's connector folder, honour the executor's deadline and
 * cancellation, cap the rows it returns, and bind parameters the engine
 * cannot bind natively as escaped literals.
 */

import type { ConnectionConfig } from '../connector.js';
import type { ColumnMeta, ColumnType, QueryExecutionOptions, QueryResult, Row } from '../result-types.js';
import { readFileSync } from 'node:fs';
import { importConnectorDependency } from '../optional-dependency.js';

/** A client library, loaded from `.dql/connectors` (or the CLI's own dependencies) at connect time. */
export async function loadDependency<T = any>(packageName: string, config: ConnectionConfig): Promise<T> {
  const loaded = await importConnectorDependency(packageName, config) as { default?: T } & T;
  if (loaded && (typeof loaded === 'object' || typeof loaded === 'function') && 'default' in loaded && loaded.default) {
    return loaded.default as T;
  }
  return loaded as T;
}

export function cancellationError(engine: string, reason?: unknown): Error {
  const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return new Error(`${engine} query was cancelled${detail ? `: ${detail}` : ''}.`);
}

export function deadlineError(engine: string, deadlineMs: number): Error {
  return new Error(`${engine} query exceeded the ${Math.max(0, Math.round(deadlineMs))}ms deadline.`);
}

/** Refuse to start a statement whose caller has already given up. */
export function assertCanStart(engine: string, options: QueryExecutionOptions): void {
  if (options.signal?.aborted) throw cancellationError(engine, options.signal.reason);
  if (options.deadlineMs !== undefined && options.deadlineMs <= 0) throw deadlineError(engine, options.deadlineMs);
}

/**
 * Run a statement under the caller's deadline and abort signal. When either
 * fires, `cancel` asks the server to stop (best effort) and the call rejects
 * at once; a late result is ignored.
 */
export async function withDeadline<T>(
  engine: string,
  options: QueryExecutionOptions,
  run: () => Promise<T>,
  cancel?: () => unknown,
): Promise<T> {
  assertCanStart(engine, options);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = options.signal;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const stop = (error: Error) => {
      if (settled) return;
      try {
        const pending = cancel?.();
        if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
          (pending as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // Cancellation is best effort; the caller is released either way.
      }
      finish(() => reject(error));
    };
    const onAbort = () => stop(cancellationError(engine, signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)) {
      timer = setTimeout(() => stop(deadlineError(engine, options.deadlineMs!)), Math.max(0, options.deadlineMs));
    }
    let running: Promise<T>;
    try {
      running = run();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    running.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

/** The time left before the caller's deadline, if it set one. */
export function remainingMs(options: QueryExecutionOptions, startedAt: number): number | undefined {
  return options.deadlineMs === undefined ? undefined : options.deadlineMs - (Date.now() - startedAt);
}

/**
 * One read-only SELECT/WITH statement: the only kind a connector may wrap in
 * a cursor, a subquery or a read-only transaction to bound its rows.
 */
export function isReadOnlyQuery(sql: string): boolean {
  let text = sql.trim();
  while (text.startsWith('--') || text.startsWith('/*')) {
    if (text.startsWith('--')) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1).trimStart() : '';
    } else {
      const end = text.indexOf('*/', 2);
      if (end < 0) return false;
      text = text.slice(end + 2).trimStart();
    }
  }
  text = text.replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(text)) return false;
  if (text.includes(';')) return false;
  return !/\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|exec|execute|into)\b/i.test(text);
}

/** A server-side statement timeout in whole seconds, never below one. */
export function deadlineSeconds(options: QueryExecutionOptions): number | undefined {
  if (options.deadlineMs === undefined || !Number.isFinite(options.deadlineMs)) return undefined;
  return Math.max(1, Math.ceil(options.deadlineMs / 1000));
}

/**
 * A query result capped to the caller's row and byte limits. A cut is
 * reported as `truncated`, never silent.
 */
export function boundedResult(
  columns: ColumnMeta[],
  rows: Row[],
  startedAt: number,
  options: QueryExecutionOptions,
  extra: Partial<QueryResult> = {},
): QueryResult {
  let kept = rows;
  let truncated = extra.truncated ?? false;
  if (options.maxRows !== undefined && kept.length > options.maxRows) {
    kept = kept.slice(0, Math.max(0, options.maxRows));
    truncated = true;
  }
  if (options.maxBytes !== undefined) {
    let bytes = 0;
    for (let index = 0; index < kept.length; index += 1) {
      bytes += jsonBytes(kept[index]!);
      if (bytes > options.maxBytes) {
        kept = kept.slice(0, index);
        truncated = true;
        break;
      }
    }
  }
  const { truncated: _ignored, ...rest } = extra;
  return {
    ...rest,
    columns,
    rows: kept,
    rowCount: kept.length,
    executionTimeMs: performance.now() - startedAt,
    ...(truncated ? { truncated: true } : {}),
  };
}

function jsonBytes(row: Row): number {
  try {
    return Buffer.byteLength(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
  } catch {
    return 0;
  }
}

/** Columns read off the first row, for engines that do not describe their result. */
export function columnsFromRows(rows: Row[], driverType = 'unknown'): ColumnMeta[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((name) => ({ name, type: valueType(first[name]), driverType }));
}

export function valueType(value: unknown): ColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return 'datetime';
    return 'string';
  }
  return 'unknown';
}

/** A column type from an engine's type name (information_schema style). */
export function typeFromName(name: string | undefined): ColumnType {
  const t = String(name ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (/^(bool|boolean|bit)\b/.test(t)) return 'boolean';
  if (/(int|numeric|decimal|number|float|double|real|money|serial)/.test(t)) return 'number';
  if (/^date$/.test(t) || /^date32$/.test(t) || /^nullable\(date\)$/.test(t)) return 'date';
  if (/(timestamp|datetime|time with|time without)/.test(t)) return 'datetime';
  if (/(char|text|string|uuid|varchar|enum|json|xml|bytes|binary|blob)/.test(t)) return 'string';
  return 'unknown';
}

/** A value as a SQL literal. `backslash` engines (ClickHouse, MySQL) also escape backslashes. */
export function sqlLiteral(value: unknown, style: 'standard' | 'backslash' = 'standard'): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`A parameter value of ${value} cannot be sent as SQL.`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `TIMESTAMP '${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = style === 'backslash'
    ? text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    : text.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * Replace each `?` placeholder outside quotes and comments with its value as
 * a literal, for engines without positional binding over their API.
 */
export function inlineParameters(sql: string, params: unknown[] | undefined, style: 'standard' | 'backslash' = 'standard'): string {
  if (!params || params.length === 0) return sql;
  let out = '';
  let used = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && style === 'backslash' && quote === "'") {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === '?') {
      if (used >= params.length) throw new Error('The statement has more placeholders than parameter values.');
      out += sqlLiteral(params[used], style);
      used += 1;
      continue;
    }
    out += ch;
  }
  if (used !== params.length) throw new Error('The statement has fewer placeholders than parameter values.');
  return out;
}

/** A JSON-safe value: bigint as a number when exact, otherwise as text. */
export function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

export function plainRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = plainValue(value);
  return out;
}

/** An error message with any configured secret removed. */
export function redactSecrets(message: string, config: ConnectionConfig): string {
  let out = message;
  for (const secret of [config.password, config.token, config.secretAccessKey, config.sessionToken, config.privateKeyPassphrase, config.oauthClientSecret]) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

export type TlsMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/**
 * The connection's TLS policy in libpq terms, from `sslMode`, the older
 * `ssl` flag, or the engine's default.
 */
export function tlsMode(config: ConnectionConfig, byDefault: TlsMode | undefined): TlsMode | undefined {
  if (config.sslMode) return config.sslMode;
  if (config.ssl === true) return byDefault && byDefault !== 'disable' ? byDefault : 'require';
  if (config.ssl === false) return 'disable';
  return byDefault;
}

/**
 * Node TLS options for a policy: `require` encrypts only, `verify-ca` checks
 * the chain against the CA, `verify-full` also checks the host name (the
 * real host when the socket goes through an SSH tunnel).
 */
export function tlsOptions(config: ConnectionConfig, mode: TlsMode | undefined): false | Record<string, unknown> | undefined {
  if (mode === undefined) return undefined;
  if (mode === 'disable') return false;
  const options: Record<string, unknown> = { rejectUnauthorized: mode !== 'require' };
  const ca = readPem(config.sslRootCert);
  if (ca) options.ca = ca;
  if (config.tlsServername) options.servername = config.tlsServername;
  if (mode === 'verify-ca') options.checkServerIdentity = () => undefined;
  return options;
}

/** PEM text, or the contents of the PEM file it names. */
export function readPem(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  try {
    return readFileSync(value.replace(/^~(?=\/)/, process.env.HOME ?? '~'), 'utf8');
  } catch {
    throw new Error(`The CA certificate file ${value} could not be read.`);
  }
}
