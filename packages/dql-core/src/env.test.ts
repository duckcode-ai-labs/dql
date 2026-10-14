import { describe, expect, it } from 'vitest';
import { envNames, envPair, readEnv } from './env.js';

describe('readEnv (ZLENS_* first, DQL_* fallback)', () => {
  it('prefers ZLENS_<X> over DQL_<X>', () => {
    expect(readEnv('ZLENS_HOST', { ZLENS_HOST: 'new', DQL_HOST: 'old' })).toBe('new');
  });

  it('falls back to DQL_<X> when ZLENS_<X> is unset', () => {
    expect(readEnv('ZLENS_HOST', { DQL_HOST: 'old' })).toBe('old');
  });

  it('returns undefined when neither is set', () => {
    expect(readEnv('ZLENS_HOST', {})).toBeUndefined();
    expect(readEnv('ZLENS_HOST', { HOST: 'x', ZLENS_PORT: '1' })).toBeUndefined();
  });

  it('treats a set but empty ZLENS_<X> as set', () => {
    expect(readEnv('ZLENS_HOST', { ZLENS_HOST: '', DQL_HOST: 'old' })).toBe('');
  });

  it('resolves the same pair when called with the legacy name', () => {
    expect(readEnv('DQL_HOST', { ZLENS_HOST: 'new', DQL_HOST: 'old' })).toBe('new');
    expect(readEnv('DQL_HOST', { DQL_HOST: 'old' })).toBe('old');
  });

  it('reads any other name directly', () => {
    expect(readEnv('OPENAI_API_KEY', { OPENAI_API_KEY: 'k', ZLENS_OPENAI_API_KEY: 'no' })).toBe('k');
    expect(envNames('OPENAI_API_KEY')).toEqual(['OPENAI_API_KEY']);
  });

  it('reads process.env by default', () => {
    const keys = ['ZLENS_ENV_HELPER_PROBE', 'DQL_ENV_HELPER_PROBE'] as const;
    const before = keys.map((key) => process.env[key]);
    try {
      delete process.env.ZLENS_ENV_HELPER_PROBE;
      process.env.DQL_ENV_HELPER_PROBE = 'legacy';
      expect(readEnv('ZLENS_ENV_HELPER_PROBE')).toBe('legacy');
      process.env.ZLENS_ENV_HELPER_PROBE = 'current';
      expect(readEnv('ZLENS_ENV_HELPER_PROBE')).toBe('current');
    } finally {
      keys.forEach((key, i) => {
        if (before[i] === undefined) delete process.env[key];
        else process.env[key] = before[i];
      });
    }
  });

  it('writes both spellings for a child environment', () => {
    expect(envPair('ZLENS_SERVER_TOKEN', 't')).toEqual({ ZLENS_SERVER_TOKEN: 't', DQL_SERVER_TOKEN: 't' });
    expect(envPair('DQL_SERVER_TOKEN', 't')).toEqual({ ZLENS_SERVER_TOKEN: 't', DQL_SERVER_TOKEN: 't' });
    expect(envPair('PATH', '/bin')).toEqual({ PATH: '/bin' });
  });
});
