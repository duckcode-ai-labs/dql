import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certify } from '../certify.js';
import { makeCtx, makeManifestBlock } from './_helpers.js';

/**
 * A certified block that declares its agent metadata and a test, as the
 * jaffle-shop-duckdb sample's monthly_revenue does.
 */
function projectWithBlock() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-mcp-certify-'));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'blocks', 'monthly-revenue.dql'), 'block "monthly_revenue" { status = "certified" }\n');
  const block = makeManifestBlock({
    name: 'monthly_revenue',
    filePath: 'blocks/monthly-revenue.dql',
    tags: ['revenue'],
    tests: ['row_count > 0'],
    llmContext: 'Use for revenue trends by month.',
    grain: 'one row per calendar month',
    entities: ['order'],
    declaredOutputs: ['month', 'gross_revenue'],
    reviewCadence: 'monthly',
  });
  return makeCtx({ monthly_revenue: block }, { projectRoot } as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('certify tool', () => {
  it('refuses unknown block names with a clear error that lists the blocks', async () => {
    const ctx = makeCtx({ monthly_revenue: makeManifestBlock({ name: 'monthly_revenue' }) });
    const result = await certify(ctx, { name: 'Nonexistent' });
    expect(result).toEqual({ error: 'No block named "Nonexistent". Blocks in this project: monthly_revenue.' });
  });

  it('asks the running workbench for the same check Block Studio runs', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        certification: { certified: true, errors: [], warnings: [], checkedAt: '2026-10-16T00:00:00.000Z' },
        checklist: { metadata: true, run: true, tests: true, blockers: [] },
        blockers: [],
        testResults: { passed: 1, failed: 0, skipped: 0, assertions: [{ name: 'assert row_count > 0', passed: true }] },
        preview: { result: { rows: [{ big: 'not returned to the agent' }] } },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await certify(projectWithBlock(), { name: 'monthly_revenue', serverUrl: 'http://runtime' }) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledWith('http://runtime/api/block-studio/certification-check', expect.objectContaining({ method: 'POST' }));
    expect(result).toMatchObject({ block: 'monthly_revenue', certified: true, checkedBy: 'workbench', blockers: [], tests: { passed: 1, failed: 0 } });
    expect(JSON.stringify(result)).not.toContain('not returned to the agent');
    expect(String(result.note)).toMatch(/changes no status/);
  });

  it('without the workbench checks the declared metadata and says tests were not run (no false failures)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await certify(projectWithBlock(), { name: 'monthly_revenue', serverUrl: 'http://127.0.0.1:9' }) as {
      certified: boolean; checkedBy: string; testsRun: boolean; errors: Array<{ rule: string }>; warnings: Array<{ rule: string }>; notChecked: string[]; checkedAt: string;
    };
    expect(result.checkedBy).toBe('metadata-only');
    expect(result.testsRun).toBe(false);
    expect(result.certified).toBe(false);
    // The block declares these: the rules must see them (they used to be dropped).
    const flagged = [...result.errors, ...result.warnings].map((entry) => entry.rule);
    expect(flagged).not.toContain('Block has LLM context');
    expect(flagged).not.toContain('Block has tests');
    expect(flagged).not.toContain('Block declares grain');
    expect(flagged).not.toContain('Block declares outputs');
    expect(flagged).not.toContain('Block declares entities');
    // "No test results" is reported as not checked, not as a failure.
    expect(result.errors.map((entry) => entry.rule)).not.toContain('All tests pass');
    expect(result.notChecked.join(' ')).toMatch(/Tests, compile and a run were not checked/);
    expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
  });
});
