import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';

describe('readEnv (copy of @zlens/core readEnv)', () => {
  it('prefers ZLENS_<X>, falls back to DQL_<X>, else undefined', () => {
    expect(readEnv('ZLENS_X', { ZLENS_X: 'new', DQL_X: 'old' })).toBe('new');
    expect(readEnv('ZLENS_X', { DQL_X: 'old' })).toBe('old');
    expect(readEnv('ZLENS_X', {})).toBeUndefined();
    expect(readEnv('ZLENS_X', { ZLENS_X: '', DQL_X: 'old' })).toBe('');
    expect(readEnv('DQL_X', { ZLENS_X: 'new' })).toBe('new');
    expect(readEnv('DO_NOT_TRACK', { DO_NOT_TRACK: '1' })).toBe('1');
  });
});
