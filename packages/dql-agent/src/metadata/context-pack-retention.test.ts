import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_PACK_RETENTION, MetadataCatalog, contextPackRetention } from './catalog.js';

/** Ask context packs are a follow-up's and a trace's, not history: the metadata cache keeps them bounded. */
describe('context pack retention', () => {
  let dir: string;
  let catalog: MetadataCatalog;
  const pack = (n: number, bytes = 1000) => ({ question: `question ${n}`, focusObjectKey: null, mode: 'answer', trustLabel: 'review', padding: 'x'.repeat(bytes) }) as never;
  const count = () => (catalog as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM context_packs').get().n;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dql-context-packs-'));
    catalog = new MetadataCatalog(join(dir, 'metadata.sqlite'));
  });
  afterEach(() => { catalog.close(); rmSync(dir, { recursive: true, force: true }); });

  it('defaults to 7 days, 200 packs and 64 MB, and reads DQL_CONTEXT_PACK_* (ignoring nonsense)', () => {
    expect(contextPackRetention({})).toEqual(CONTEXT_PACK_RETENTION);
    expect(contextPackRetention({ DQL_CONTEXT_PACK_DAYS: '2', DQL_CONTEXT_PACK_MAX: '50', DQL_CONTEXT_PACK_MAX_MB: '8' })).toEqual({ days: 2, max: 50, bytes: 8 * 1024 * 1024 });
    expect(contextPackRetention({ DQL_CONTEXT_PACK_DAYS: '-1', DQL_CONTEXT_PACK_MAX: 'lots' })).toEqual(CONTEXT_PACK_RETENTION);
  });

  it('keeps at most the newest N, nothing older than the days, and no more than the bytes (the newest always)', () => {
    const ids = Array.from({ length: 30 }, (_, n) => catalog.insertContextPack(pack(n)));
    expect(catalog.pruneContextPacks({ days: 7, max: 10, bytes: 1024 * 1024 * 64 })).toBe(20);
    expect(count()).toBe(10);
    expect(catalog.getContextPack(ids[29])).not.toBeNull();
    expect(catalog.getContextPack(ids[19])).toBeNull();
    // Older than the days: gone, except the newest.
    expect(catalog.pruneContextPacks({ days: 7, max: 100, bytes: 1024 * 1024 * 64 }, new Date(Date.now() + 8 * 86_400_000))).toBe(9);
    expect(catalog.getContextPack(ids[29])).not.toBeNull();
    // Bytes: newest first until the cap.
    for (let n = 0; n < 5; n += 1) catalog.insertContextPack(pack(100 + n, 4000));
    catalog.pruneContextPacks({ days: 7, max: 100, bytes: 10_000 });
    expect(count()).toBe(3);
  });

  it('prunes by itself as questions are asked: 1,000 asks leave at most the bound', () => {
    const before = process.env.DQL_CONTEXT_PACK_MAX;
    process.env.DQL_CONTEXT_PACK_MAX = '50';
    try {
      for (let n = 0; n < 1000; n += 1) catalog.insertContextPack(pack(n, 200));
      expect(count()).toBeLessThanOrEqual(50 + 20);
      // The runtime opens the catalog per request: a fresh catalog per question prunes just the same.
      for (let n = 0; n < 200; n += 1) {
        const opened = new MetadataCatalog(join(dir, 'metadata.sqlite'));
        opened.insertContextPack(pack(2000 + n, 200));
        opened.close();
      }
      expect(count()).toBeLessThanOrEqual(50 + 20);
    } finally {
      if (before === undefined) delete process.env.DQL_CONTEXT_PACK_MAX;
      else process.env.DQL_CONTEXT_PACK_MAX = before;
    }
  });
});
