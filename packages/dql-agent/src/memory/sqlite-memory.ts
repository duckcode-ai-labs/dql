/**
 * Local, scoped agent memory for DQL analytics.
 *
 * Memory is advisory context only. The governed answer loop always ranks
 * certified artifacts, semantic metadata, and dbt manifest facts above memory.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { sanitizeFtsQuery } from './fts-query.js';
import type { Awaitable, AwaitableMethods } from '../store-types.js';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export type AgentMemoryScope = 'thread' | 'notebook' | 'project' | 'user' | 'artifact';

export interface AgentMemory {
  id: string;
  scope: AgentMemoryScope;
  scopeId?: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  importance: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  lastUsed?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

export interface AgentMemoryInput {
  id?: string;
  scope: AgentMemoryScope;
  scopeId?: string;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  importance?: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  enabled?: boolean;
}

export interface MemorySearchOptions {
  query: string;
  scopes?: AgentMemoryScope[];
  scopeId?: string;
  limit?: number;
  now?: Date;
}

export function defaultMemoryPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'agent-memory.sqlite');
}

export function ensureDefaultMemoryFiles(projectRoot: string): string[] {
  const dir = join(projectRoot, '.dql', 'memory');
  mkdirSync(dir, { recursive: true });
  const files = [
    ['business-context.md', '# Business Context\n\n'],
    ['glossary.md', '# Glossary\n\n'],
    ['decisions.md', '# Analyst Decisions\n\n'],
    ['rules.md', '# Agent Rules\n\n'],
  ] as const;
  const paths: string[] = [];
  for (const [name, body] of files) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, body, 'utf-8');
    paths.push(path);
  }
  return paths;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id          TEXT PRIMARY KEY,
        scope       TEXT NOT NULL,
        scope_id    TEXT,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        tags_json   TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL DEFAULT 'manual',
        confidence  REAL NOT NULL DEFAULT 0.7,
        importance  REAL NOT NULL DEFAULT 0.5,
        valid_from  TEXT,
        valid_to    TEXT,
        supersedes  TEXT,
        last_used   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_agent_memory_enabled ON agent_memory(enabled);

      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
        id UNINDEXED,
        title,
        content,
        tags,
        scope,
        tokenize = 'porter unicode61'
      );
    `);
  }

  upsert(input: AgentMemoryInput): AgentMemory {
    const row = memoryRecordForStorage(input, (id) => this.get(id));

    const txn = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO agent_memory (
          id, scope, scope_id, title, content, tags_json, source, confidence,
          importance, valid_from, valid_to, supersedes, last_used, created_at,
          updated_at, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.scope,
        row.scopeId ?? null,
        row.title,
        row.content,
        JSON.stringify(row.tags),
        row.source,
        row.confidence,
        row.importance,
        row.validFrom ?? null,
        row.validTo ?? null,
        row.supersedes ?? null,
        row.lastUsed ?? null,
        row.createdAt,
        row.updatedAt,
        row.enabled ? 1 : 0,
      );
      this.db.prepare('DELETE FROM agent_memory_fts WHERE id = ?').run(row.id);
      this.db.prepare(`
        INSERT INTO agent_memory_fts (id, title, content, tags, scope)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.id, row.title, row.content, row.tags.join(' '), row.scope);
    });
    txn();
    return row;
  }

  get(id: string): AgentMemory | null {
    const row = this.db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  list(scope?: AgentMemoryScope): AgentMemory[] {
    const rows = scope
      ? this.db.prepare('SELECT * FROM agent_memory WHERE scope = ? ORDER BY importance DESC, updated_at DESC').all(scope)
      : this.db.prepare('SELECT * FROM agent_memory ORDER BY importance DESC, updated_at DESC').all();
    return (rows as MemoryRow[]).map(rowToMemory);
  }

  search(options: MemorySearchOptions): AgentMemory[] {
    const query = sanitizeFtsQuery(options.query);
    if (!query) return [];

    const filters = ['m.enabled = 1'];
    const params: unknown[] = [query];
    const now = (options.now ?? new Date()).toISOString();
    filters.push('(m.valid_from IS NULL OR m.valid_from <= ?)');
    params.push(now);
    filters.push('(m.valid_to IS NULL OR m.valid_to >= ?)');
    params.push(now);

    if (options.scopes && options.scopes.length > 0) {
      filters.push(`m.scope IN (${options.scopes.map(() => '?').join(', ')})`);
      params.push(...options.scopes);
    }
    if (options.scopeId) {
      filters.push('(m.scope_id IS NULL OR m.scope_id = ?)');
      params.push(options.scopeId);
    }

    const rows = this.db.prepare(`
      SELECT m.*, bm25(agent_memory_fts) AS rank
      FROM agent_memory_fts AS f
      JOIN agent_memory AS m ON m.id = f.id
      WHERE agent_memory_fts MATCH ?
        AND ${filters.join(' AND ')}
      ORDER BY (m.importance + m.confidence) DESC, rank
      LIMIT ?
    `).all(...params, options.limit ?? 6) as MemoryRow[];

    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      const mark = this.db.prepare('UPDATE agent_memory SET last_used = ? WHERE id = ?');
      const nowUsed = new Date().toISOString();
      const txn = this.db.transaction(() => {
        for (const id of ids) mark.run(nowUsed, id);
      });
      txn();
    }

    return rows.map(rowToMemory);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE agent_memory SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  delete(id: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_memory_fts WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id);
    });
    txn();
  }

  close(): void {
    this.db.close();
  }
}

/** The memory store surface DQL calls (RFC 0010 HH-6): this SQLite store, or a host's own whose methods return Promises. */
export type MemoryStoreLike = AwaitableMethods<Pick<MemoryStore, 'upsert' | 'get' | 'list' | 'search' | 'setEnabled' | 'delete'>> & {
  close?(): Awaitable<void>;
};

/**
 * The record `upsert` writes: a fresh id unless one is given, scores clamped
 * to 0..1, and what the existing record had (confidence, importance, last
 * use, creation time, enabled) kept unless the input sets it. For a host's own
 * store (HH-6), which passes the existing record it read.
 */
export function memoryRecordForStorage(input: AgentMemoryInput, existingOf: (id: string) => AgentMemory | null | undefined): AgentMemory {
  const now = new Date().toISOString();
  const id = input.id ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const existing = existingOf(id) ?? undefined;
  return {
    id,
    scope: input.scope,
    scopeId: input.scopeId,
    title: input.title.trim(),
    content: input.content.trim(),
    tags: input.tags ?? [],
    source: input.source ?? 'manual',
    confidence: clamp(input.confidence ?? existing?.confidence ?? 0.7),
    importance: clamp(input.importance ?? existing?.importance ?? 0.5),
    validFrom: input.validFrom,
    validTo: input.validTo,
    supersedes: input.supersedes,
    lastUsed: existing?.lastUsed,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
}

type MemoryRow = {
  id: string;
  scope: string;
  scope_id: string | null;
  title: string;
  content: string;
  tags_json: string;
  source: string;
  confidence: number;
  importance: number;
  valid_from: string | null;
  valid_to: string | null;
  supersedes: string | null;
  last_used: string | null;
  created_at: string;
  updated_at: string;
  enabled: number;
};

function rowToMemory(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    scope: row.scope as AgentMemoryScope,
    scopeId: row.scope_id ?? undefined,
    title: row.title,
    content: row.content,
    tags: safeJSON(row.tags_json, [] as string[]),
    source: row.source,
    confidence: row.confidence,
    importance: row.importance,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    supersedes: row.supersedes ?? undefined,
    lastUsed: row.last_used ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabled: Boolean(row.enabled),
  };
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

