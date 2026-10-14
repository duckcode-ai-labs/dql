import { describe, it, expect, vi } from 'vitest';

vi.mock('@zlens/governance', () => ({
  Certifier: class {
    evaluate() {
      return {
        certified: false,
        errors: [],
        warnings: [{ message: 'Draft block — needs review.' }],
        checkedAt: new Date('2026-05-01T12:00:00Z'),
      };
    }
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path.endsWith('/domains/finance')),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { suggestBlock } from '../suggest-block.js';
import { makeCtx } from './_helpers.js';
import { writeFileSync } from 'node:fs';

function ctxWithRefresh() {
  return makeCtx({}, { refresh: vi.fn() } as Partial<import('../../context.js').DQLContext>);
}

describe('suggestBlock tool', () => {
  it('rejects empty/whitespace block names', () => {
    const ctx = ctxWithRefresh();
    const result = suggestBlock(ctx, {
      name: '   ',
      domain: 'finance',
      owner: 'tests@example.com',
      description: 'desc',
      sql: 'SELECT 1',
    });
    expect((result as { error?: string }).error).toBe('Invalid block name.');
  });

  it('produces a structured draft envelope for a valid suggestion', () => {
    const ctx = ctxWithRefresh();
    const result = suggestBlock(ctx, {
      name: 'monthly_revenue',
      domain: 'finance',
      owner: 'tests@example.com',
      description: 'monthly gross revenue',
      sql: 'SELECT 1',
    });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('writes suggestions under the domain-first draft folder when the domain exists', () => {
    const ctx = ctxWithRefresh();
    const result = suggestBlock(ctx, {
      name: 'monthly_revenue',
      domain: 'finance',
      owner: 'tests@example.com',
      description: 'monthly gross revenue',
      sql: 'SELECT 1',
    });

    expect(result).toMatchObject({
      path: 'domains/finance/blocks/_drafts/monthly_revenue.dql',
    });
    const lastWrite = vi.mocked(writeFileSync).mock.calls.at(-1);
    expect(String(lastWrite?.[0])).toContain('domains/finance/blocks/_drafts/monthly_revenue.dql');
  });
});
