import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';

import type { DatasetCacheDeliveryReceiptV1 } from '@zlens/core';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export const DATASET_RESULT_CACHE_DEFAULTS = {
  ttlMs: 300_000,
  maxEntries: 256,
  maxBytes: 64 * 1024 * 1024,
} as const;

/** Complete identity required before a cache may read or write. */
export interface DatasetResultCacheIdentity {
  datasetId: string;
  sourceRevision: string;
  contractFingerprint: string;
  snapshotFingerprint: string;
  targetFingerprint: string;
  normalizedQuery: unknown;
  filterFingerprint: string;
  parameterFingerprint: string;
  interactionFingerprint: string;
  dialect: string;
  adapterFingerprint: string;
  compilerFingerprint: string;
  rowBoundFingerprint: string;
  personaPolicyFingerprint: string;
}

export interface DatasetResultCacheEntry {
  /**
   * The App runner's normalized, presentation-ready Dataset result. This is
   * deliberately not a connector result: cache delivery must never recreate a
   * connector receipt or pretend that SQL was dispatched again.
   */
  result: DatasetCachedResult;
  originalReceiptId: string;
  sourceRevision: string;
  contractFingerprint: string;
  targetFingerprint: string;
  cachedAt: string;
  expiresAt: string;
}

export interface DatasetCachedResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
  truncated?: boolean;
  resultFingerprint?: string;
  columnsMeta?: unknown[];
}

export interface DatasetResultCacheOptions {
  path: string;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => Date;
}

interface StoredEntry {
  payload: string;
  cached_at_ms: number;
  expires_at_ms: number;
}

/**
 * Default-off local SQLite cache for complete Dataset results. It has no
 * execution authority: callers must revalidate identity before a hit and must
 * keep the resulting cache-delivery receipt distinct from a fresh run.
 */
export class DatasetResultCache {
  private readonly db: Database.Database | undefined;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(options: DatasetResultCacheOptions) {
    try {
      ensureDir(options.path);
      const Database = loadDatabase();
      const db = new Database(options.path);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS dataset_result_entries (
          cache_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          payload_bytes INTEGER NOT NULL,
          cached_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS dataset_result_entries_expiry ON dataset_result_entries(expires_at_ms);
        CREATE INDEX IF NOT EXISTS dataset_result_entries_age ON dataset_result_entries(cached_at_ms);
      `);
      this.db = db;
    } catch {
      // A corrupt or unavailable optional cache is never allowed to block the
      // guarded live Dataset execution. Callers simply observe a cache miss.
      this.db = undefined;
    }
    this.ttlMs = positiveInteger(options.ttlMs, DATASET_RESULT_CACHE_DEFAULTS.ttlMs);
    this.maxEntries = positiveInteger(options.maxEntries, DATASET_RESULT_CACHE_DEFAULTS.maxEntries);
    this.maxBytes = positiveInteger(options.maxBytes, DATASET_RESULT_CACHE_DEFAULTS.maxBytes);
    this.now = options.now ?? (() => new Date());
  }

  /** Missing or incomplete identities never get a key and must bypass cache. */
  static keyFor(identity: DatasetResultCacheIdentity | undefined): string | undefined {
    if (!identity || !hasCompleteIdentity(identity)) return undefined;
    try {
      return `sha256:${createHash('sha256').update(stableJson({ version: 1, ...identity })).digest('hex')}`;
    } catch {
      return undefined;
    }
  }

  get(cacheKey: string | undefined): DatasetResultCacheEntry | undefined {
    if (!cacheKey || !this.db) return undefined;
    const nowMs = this.now().valueOf();
    this.db.prepare('DELETE FROM dataset_result_entries WHERE expires_at_ms <= ?').run(nowMs);
    const row = this.db.prepare(
      'SELECT payload, cached_at_ms, expires_at_ms FROM dataset_result_entries WHERE cache_key = ?',
    ).get(cacheKey) as StoredEntry | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      const entry = normalizeEntry(parsed);
      if (!entry) throw new Error('invalid cache payload');
      return {
        ...entry,
        cachedAt: new Date(row.cached_at_ms).toISOString(),
        expiresAt: new Date(row.expires_at_ms).toISOString(),
      };
    } catch {
      this.db.prepare('DELETE FROM dataset_result_entries WHERE cache_key = ?').run(cacheKey);
      return undefined;
    }
  }

  put(cacheKey: string | undefined, entry: Omit<DatasetResultCacheEntry, 'cachedAt' | 'expiresAt'>): boolean {
    if (!cacheKey || !this.db || !isCacheableResult(entry.result) || !entry.originalReceiptId.trim()
      || !entry.sourceRevision.trim() || !entry.contractFingerprint.trim() || !entry.targetFingerprint.trim()) return false;
    let payload: string;
    try {
      payload = JSON.stringify({
        result: entry.result,
        originalReceiptId: entry.originalReceiptId,
        sourceRevision: entry.sourceRevision,
        contractFingerprint: entry.contractFingerprint,
        targetFingerprint: entry.targetFingerprint,
      });
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.maxBytes) return false;
    const cachedAt = this.now().valueOf();
    const expiresAt = cachedAt + this.ttlMs;
    try {
      this.db.prepare(`
        INSERT INTO dataset_result_entries(cache_key, payload, payload_bytes, cached_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          payload = excluded.payload,
          payload_bytes = excluded.payload_bytes,
          cached_at_ms = excluded.cached_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(cacheKey, payload, bytes, cachedAt, expiresAt);
      this.evict();
      return true;
    } catch {
      // Cache failure intentionally falls open to the guarded live execution.
      return false;
    }
  }

  deliveryReceipt(cacheKey: string, entry: DatasetResultCacheEntry): DatasetCacheDeliveryReceiptV1 {
    return {
      version: 1,
      kind: 'dataset_cache_delivery',
      cacheKey,
      originalReceiptId: entry.originalReceiptId,
      sourceRevision: entry.sourceRevision,
      contractFingerprint: entry.contractFingerprint,
      targetFingerprint: entry.targetFingerprint,
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
    };
  }

  close(): void {
    this.db?.close();
  }

  private evict(): void {
    if (!this.db) return;
    const nowMs = this.now().valueOf();
    this.db.prepare('DELETE FROM dataset_result_entries WHERE expires_at_ms <= ?').run(nowMs);
    const stats = this.db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(payload_bytes), 0) AS bytes FROM dataset_result_entries')
      .get() as { entries: number; bytes: number };
    if (stats.entries <= this.maxEntries && stats.bytes <= this.maxBytes) return;
    const rows = this.db.prepare('SELECT cache_key, payload_bytes FROM dataset_result_entries ORDER BY cached_at_ms ASC, cache_key ASC').all() as Array<{ cache_key: string; payload_bytes: number }>;
    let entries = stats.entries;
    let bytes = stats.bytes;
    const remove = this.db.prepare('DELETE FROM dataset_result_entries WHERE cache_key = ?');
    for (const row of rows) {
      if (entries <= this.maxEntries && bytes <= this.maxBytes) break;
      remove.run(row.cache_key);
      entries -= 1;
      bytes -= row.payload_bytes;
    }
  }
}

function hasCompleteIdentity(identity: DatasetResultCacheIdentity): boolean {
  const strings = [
    identity.datasetId, identity.sourceRevision, identity.contractFingerprint,
    identity.snapshotFingerprint, identity.targetFingerprint, identity.filterFingerprint,
    identity.parameterFingerprint, identity.interactionFingerprint, identity.dialect,
    identity.adapterFingerprint, identity.compilerFingerprint, identity.rowBoundFingerprint,
    identity.personaPolicyFingerprint,
  ];
  return strings.every((value) => typeof value === 'string' && value.trim().length > 0)
    && identity.normalizedQuery !== undefined;
}

export function normalizeDatasetCachedResult(value: unknown): DatasetCachedResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.columns) || !record.columns.every((column) => typeof column === 'string')) return undefined;
  if (!Array.isArray(record.rows) || !record.rows.every((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row))) return undefined;
  if (!Number.isInteger(record.rowCount) || (record.rowCount as number) < 0 || record.rowCount !== record.rows.length) return undefined;
  if (typeof record.executionTime !== 'number' || !Number.isFinite(record.executionTime) || record.executionTime < 0) return undefined;
  if (record.truncated === true) return undefined;
  const result: DatasetCachedResult = {
    columns: [...record.columns],
    rows: record.rows.map((row) => ({ ...(row as Record<string, unknown>) })),
    rowCount: record.rowCount as number,
    executionTime: record.executionTime,
    ...(typeof record.resultFingerprint === 'string' && record.resultFingerprint.trim() ? { resultFingerprint: record.resultFingerprint } : {}),
    ...(Array.isArray(record.columnsMeta) ? { columnsMeta: structuredClone(record.columnsMeta) } : {}),
  };
  return result;
}

function isCacheableResult(result: DatasetCachedResult): boolean {
  return Boolean(normalizeDatasetCachedResult(result));
}

function normalizeEntry(value: unknown): Omit<DatasetResultCacheEntry, 'cachedAt' | 'expiresAt'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result = normalizeDatasetCachedResult(record.result);
  if (!result) return undefined;
  const originalReceiptId = text(record.originalReceiptId);
  const sourceRevision = text(record.sourceRevision);
  const contractFingerprint = text(record.contractFingerprint);
  const targetFingerprint = text(record.targetFingerprint);
  if (!originalReceiptId || !sourceRevision || !contractFingerprint || !targetFingerprint) return undefined;
  return { result, originalReceiptId, sourceRevision, contractFingerprint, targetFingerprint };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { $bigint: item.toString() };
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) throw new Error('circular cache identity');
    seen.add(item);
    if (Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)));
  });
}
