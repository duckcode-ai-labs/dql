import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardHostStore, HostStoreError, openHostStore } from './host-stores.js';

/**
 * RFC 0010 HH-6: a host's store that fails reads plainly, with a reference;
 * its own words go only to the server's log. Answers of the wrong shape are
 * read as nothing (or as a failure where DQL cannot go on without them).
 */
const REFERENCE = /reference ([bcdfghjkmnpqrstvwxz]{8})\./;
afterEach(() => vi.restoreAllMocks());

describe('a host store, as DQL calls it', () => {
  it('turns a throw or a rejection into a plain message with a reference, the store\'s words only in the log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const store = guardHostStore('runs', {
      list: () => { throw new Error('connect ECONNREFUSED 10.0.3.7:5432 (db-internal-41)'); },
      get: () => Promise.reject(new Error('password authentication failed for user ws_role (db-internal-42)')),
    });
    for (const call of [() => store.list(), () => store.get()]) {
      const failure = await Promise.resolve().then(call).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HostStoreError);
      const message = (failure as Error).message;
      expect(message).toMatch(/^DQL could not reach its saved answers right now\./);
      expect(message).not.toMatch(/db-internal|10\.0\.3\.7|ws_role/);
      const reference = REFERENCE.exec(message)?.[1];
      expect(reference).toBeTruthy();
      expect(logged.some((line) => line.includes(`reference ${reference}`) && /db-internal-4[12]/.test(line))).toBe(true);
    }
  });

  it('reads answers of the wrong shape as nothing, and as a failure where DQL needs a record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runs = guardHostStore('runs', { list: async () => 'not a list', get: async () => 'r-1', count: async () => 'many', claimRequest: async () => 7 });
    expect(await runs.list()).toEqual([]);
    expect(await runs.get()).toBeUndefined();
    expect(await runs.count()).toBe(0);
    await expect(runs.claimRequest()).rejects.toBeInstanceOf(HostStoreError);
    const conversations = guardHostStore('conversations', { listThreads: async () => [null, { id: 't1' }, 'x'], getThread: async () => 42, deleteThread: async () => 'yes', appendTurn: async () => undefined });
    expect(await conversations.listThreads()).toEqual([{ id: 't1' }]);
    expect(await conversations.getThread()).toBeNull();
    expect(await conversations.deleteThread()).toBe(false);
    await expect(conversations.appendTurn()).rejects.toBeInstanceOf(HostStoreError);
  });

  it('keeps well-formed answers as they are', async () => {
    const run = { id: 'r-1', ownerId: 'u-1' };
    const store = guardHostStore('runs', { list: async () => [run], get: async () => run, count: async () => 3, save: async () => undefined });
    expect(await store.list()).toEqual([run]);
    expect(await store.get()).toBe(run);
    expect(await store.count()).toBe(3);
    expect(await store.save()).toBeUndefined();
  });

  it('a store factory that throws or answers without a store is a plain failure too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => openHostStore('memory', () => { throw new Error('pool exhausted (db-internal-43)'); })).toThrow(HostStoreError);
    expect(() => openHostStore('memory', () => 'store' as never)).toThrow(HostStoreError);
  });
});
