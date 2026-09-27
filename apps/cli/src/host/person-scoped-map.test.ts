import { describe, expect, it } from 'vitest';
import { PersonScopedMap } from './person-scoped-map.js';

describe('run evidence belongs to who ran it (RFC 0010)', () => {
  it('finds an entry only for the same person, and sweeps expired entries for everyone', () => {
    let who = 'maria';
    const runs = new PersonScopedMap<string, { expiresAt: number }>(() => who);
    runs.set('run-1', { expiresAt: 10 });
    expect(runs.get('run-1')).toEqual({ expiresAt: 10 });
    who = 'dan';
    expect(runs.get('run-1')).toBeUndefined();
    expect(runs.has('run-1')).toBe(false);
    expect(runs.delete('run-1')).toBe(false);
    who = 'maria';
    expect(runs.has('run-1')).toBe(true);
    runs.set('run-2', { expiresAt: 99 });
    runs.sweep((value) => value.expiresAt < 50);
    expect(runs.has('run-1')).toBe(false);
    expect(runs.has('run-2')).toBe(true);
  });
});
