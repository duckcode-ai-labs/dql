import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@zlens/governance', () => ({
  Certifier: class {
    evaluate() {
      return {
        certified: false,
        errors: [
          { code: 'missing-description', message: 'Block has no description.' },
        ],
        warnings: [],
        checkedAt: new Date('2026-05-01T12:00:00Z'),
      };
    }
  },
}));

vi.mock('../util.js', () => ({
  manifestBlockToRecord: (block: Record<string, unknown>) => block,
}));

import { certify } from '../certify.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

describe('certify tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses unknown block names with a clear error', () => {
    const ctx = makeCtx({});
    const result = certify(ctx, { name: 'Nonexistent' });
    expect(result).toEqual({ error: 'No block named "Nonexistent".' });
  });

  it('returns a structured certification result for a known block', () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    const result = certify(ctx, { name: 'My Block' });
    expect(result).toMatchObject({
      block: 'My Block',
      path: 'blocks/my-block.dql',
      certified: false,
    });
    expect((result as { errors: unknown[] }).errors).toHaveLength(1);
    expect((result as { checkedAt: string }).checkedAt).toMatch(/^2026-05-01T/);
  });

  it('preserves the certifier warnings array shape', () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    const result = certify(ctx, { name: 'My Block' });
    expect(Array.isArray((result as { warnings: unknown[] }).warnings)).toBe(true);
  });

  it('emits an ISO8601 checkedAt string', () => {
    const ctx = makeCtx({ 'My Block': makeManifestBlock() });
    const result = certify(ctx, { name: 'My Block' });
    const ts = (result as { checkedAt: string }).checkedAt;
    expect(() => new Date(ts).toISOString()).not.toThrow();
  });
});
