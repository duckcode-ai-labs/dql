/**
 * Manifest cache — persistent, hash-keyed store for compiled DQLManifest artifacts.
 *
 * Lives at `.dql/cache/manifest.sqlite` by default. Keyed by a deterministic
 * fingerprint over every input file that contributed to the build (all `.dql`,
 * `.dqlnb`, semantic YAML, and the dbt `manifest.json`). A cache hit returns
 * the previous manifest JSON untouched; a miss signals the builder to do a
 * full rebuild and `put()` the result.
 *
 * File-level hashes are stored separately so callers (e.g. `zlens sync dbt`,
 * incremental rebuilders) can detect *which* files changed since last build
 * without reading every file's contents.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

/** A tracked input file — the cache hashes its mtime+size cheaply, content on demand. */
export interface TrackedFile {
  /** Relative path from project root (stable cache key component). */
  path: string;
  /** SHA-256 of file contents. Computed by the cache if omitted. */
  contentHash?: string;
}

/** Result of a fingerprint lookup. */
export interface CacheHit<T> {
  hit: true;
  value: T;
  fingerprint: string;
  builtAt: string;
}
export interface CacheMiss {
  hit: false;
  /** Files whose content hash differs from the last stored build (empty if this is a cold cache). */
  changedFiles: string[];
}
export type CacheLookup<T> = CacheHit<T> | CacheMiss;

export interface ManifestCacheOptions {
  /** Path to the SQLite file. Caller is responsible for choosing a project-scoped location. */
  path: string;
}

interface FileRow {
  path: string;
  content_hash: string;
}

/**
 * SQLite-backed cache for compiled manifests.
 *
 * Schema
 * - `manifest_entries`: one row per fingerprint, holds the serialized manifest
 * - `file_hashes`: the last-seen content hash for each tracked file, used to
 *   compute a dirty set on cold paths
 */
export class ManifestCache {
  private db: Database.Database;

  constructor(options: ManifestCacheOptions) {
    ensureDirExists(options.path);
    const Database = loadDatabase();
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manifest_entries (
        fingerprint  TEXT PRIMARY KEY,
        payload      TEXT NOT NULL,
        built_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        path          TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
  }

  /**
   * Compute a stable fingerprint over a set of tracked files. The caller
   * should include every file whose contents could change the manifest
   * (all `.dql`, `.dqlnb`, semantic YAML, and dbt `manifest.json`).
   *
   * Fingerprint = sha256 of `path\0hash\n` joined for a lexicographically
   * sorted file list. Missing content hashes are filled in from disk.
   */
  fingerprint(files: TrackedFile[]): string {
    const resolved = files
      .map((f) => ({ path: f.path, contentHash: f.contentHash ?? hashFile(f.path) }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const hash = createHash('sha256');
    for (const f of resolved) {
      hash.update(f.path);
      hash.update('\0');
      hash.update(f.contentHash);
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  /**
   * Look up a previously-cached manifest by fingerprint. On miss, returns the
   * set of file paths whose current content hash differs from the last stored
   * hash — callers can use this to rebuild only affected subgraphs.
   */
  lookup<T>(fingerprint: string, files: TrackedFile[]): CacheLookup<T> {
    const row = this.db
      .prepare('SELECT payload, built_at FROM manifest_entries WHERE fingerprint = ?')
      .get(fingerprint) as { payload: string; built_at: string } | undefined;

    if (row) {
      return {
        hit: true,
        value: JSON.parse(row.payload) as T,
        fingerprint,
        builtAt: row.built_at,
      };
    }

    return { hit: false, changedFiles: this.diffFiles(files) };
  }

  /**
   * Persist a newly-built manifest under `fingerprint`, and record the per-file
   * content hashes so the next miss can report a precise dirty set.
   */
  put<T>(fingerprint: string, value: T, files: TrackedFile[]): void {
    const now = new Date().toISOString();
    const payload = JSON.stringify(value);

    const resolved = files.map((f) => ({
      path: f.path,
      content_hash: f.contentHash ?? hashFile(f.path),
    }));

    const writeEntry = this.db.prepare(
      'INSERT OR REPLACE INTO manifest_entries (fingerprint, payload, built_at) VALUES (?, ?, ?)',
    );
    const writeFile = this.db.prepare(
      'INSERT OR REPLACE INTO file_hashes (path, content_hash, updated_at) VALUES (?, ?, ?)',
    );

    const tx = this.db.transaction(() => {
      writeEntry.run(fingerprint, payload, now);
      for (const f of resolved) writeFile.run(f.path, f.content_hash, now);
    });
    tx();
  }

  /** Return the files whose current content hash differs from the stored one. */
  diffFiles(files: TrackedFile[]): string[] {
    if (files.length === 0) return [];

    const stored = new Map<string, string>();
    const rows = this.db.prepare('SELECT path, content_hash FROM file_hashes').all() as FileRow[];
    for (const r of rows) stored.set(r.path, r.content_hash);

    const changed: string[] = [];
    for (const f of files) {
      const current = f.contentHash ?? hashFile(f.path);
      const prior = stored.get(f.path);
      if (prior !== current) changed.push(f.path);
    }
    return changed;
  }

  /** Clear all cached manifests and file hashes. Useful for `zlens compile --no-cache`. */
  clear(): void {
    this.db.exec('DELETE FROM manifest_entries; DELETE FROM file_hashes;');
  }

  close(): void {
    this.db.close();
  }
}

/** Compute sha256 of a file's contents. Returns a sentinel if the file is missing. */
function hashFile(path: string): string {
  try {
    // stat first so we can short-circuit on zero-byte files without reading
    statSync(path);
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

function ensureDirExists(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
