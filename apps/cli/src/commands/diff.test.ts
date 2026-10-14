import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiff } from './diff.js';
import type { CLIFlags } from '../args.js';

const tempDirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dql-diff-impact-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'blocks'), { recursive: true });
  writeFileSync(join(dir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  return dir;
}

/**
 * Write a compiled-style manifest with a lineage graph:
 *   block:base (finance, certified) → block:mid (finance, certified)
 */
function writeManifest(dir: string): void {
  const manifest = {
    lineage: {
      nodes: [
        { id: 'block:base', type: 'block', name: 'base', domain: 'finance', status: 'certified' },
        { id: 'block:mid', type: 'block', name: 'mid', domain: 'finance', status: 'certified' },
      ],
      edges: [{ source: 'block:base', target: 'block:mid', type: 'feeds_into' }],
      domains: ['finance'],
      crossDomainFlows: [],
      domainTrust: { finance: { total: 2, certified: 2, score: 1 } },
    },
  };
  writeFileSync(join(dir, 'dql-manifest.json'), JSON.stringify(manifest));
}

function writeSemanticMetricManifest(dir: string): void {
  mkdirSync(join(dir, 'semantic-layer', 'metrics'), { recursive: true });
  writeFileSync(join(dir, 'semantic-layer', 'metrics', 'revenue.yaml'), [
    'name: total_revenue',
    'label: Total Revenue',
    'description: Certified revenue metric',
    'domain: finance',
    'status: certified',
    'owner: finance@example.com',
    'sql: SUM(amount)',
    'type: sum',
    'table: mart.orders',
    '',
  ].join('\n'));
  const manifest = {
    lineage: {
      nodes: [
        { id: 'block:base', type: 'block', name: 'base', domain: 'finance', status: 'certified' },
        {
          id: 'metric:total_revenue',
          type: 'metric',
          name: 'total_revenue',
          domain: 'finance',
          status: 'certified',
          owner: 'finance@example.com',
          metadata: { filePath: 'semantic-layer/metrics/revenue.yaml' },
        },
      ],
      edges: [{ source: 'block:base', target: 'metric:total_revenue', type: 'feeds_into' }],
      domains: ['finance'],
      crossDomainFlows: [],
      domainTrust: { finance: { total: 1, certified: 1, score: 1 } },
    },
  };
  writeFileSync(join(dir, 'dql-manifest.json'), JSON.stringify(manifest));
}

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    check: false,
    chart: '',
    domain: '',
    format: 'text',
    help: false,
    open: null,
    input: '',
    outDir: '',
    owner: '',
    port: null,
    queryOnly: false,
    template: '',
    connection: 'duckdb',
    verbose: false,
    skipTests: false,
    version: false,
    impact: true,
    ...overrides,
  };
}

/** Mock process.exit so the gate's exit code is observable as a thrown sentinel. */
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
}

function exitCodeFrom(err: unknown): number | null {
  const m = /^__exit__:(\d+)$/.exec((err as Error)?.message ?? '');
  return m ? Number(m[1]) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const BASE = `block "base" {
  domain = "finance"
  type = "custom"
  query = """SELECT 1 AS x"""
}`;

describe('zlens diff --impact gate', () => {
  it('exits non-zero when a semantic change invalidates certified downstream', async () => {
    const dir = makeProject();
    writeManifest(dir);
    const before = join(dir, 'blocks', 'base.before.dql');
    const after = join(dir, 'blocks', 'base.dql');
    writeFileSync(before, BASE);
    writeFileSync(after, BASE.replace('SELECT 1 AS x', 'SELECT 2 AS x'));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = mockExit();

    let caught: unknown;
    try {
      await runDiff(before, [after], flags({ format: 'json' }));
    } catch (e) {
      caught = e;
    }

    expect(exitCodeFrom(caught)).toBe(1);
    const payload = JSON.parse(log.mock.calls.map((c) => c[0]).join('\n'));
    expect(payload.hasCertifiedInvalidation).toBe(true);
    expect(payload.requiresRecert.map((r: any) => r.id)).toContain('block:mid');
  });

  it('exits zero for a non-semantic (description-only) change', async () => {
    const dir = makeProject();
    writeManifest(dir);
    const before = join(dir, 'blocks', 'base.before.dql');
    const after = join(dir, 'blocks', 'base.dql');
    writeFileSync(before, BASE);
    writeFileSync(
      after,
      `block "base" {
  domain = "finance"
  type = "custom"
  description = "now documented"
  query = """SELECT 1 AS x"""
}`,
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExit();

    let caught: unknown;
    try {
      await runDiff(before, [after], flags({ format: 'json' }));
    } catch (e) {
      caught = e;
    }

    // No exit() call → gate passed.
    expect(caught).toBeUndefined();
    const payload = JSON.parse(log.mock.calls.map((c) => c[0]).join('\n'));
    expect(payload.hasCertifiedInvalidation).toBe(false);
    expect(payload.changedBlocks[0].verdict).toBe('non-semantic');
  });

  it('does not affect normal diff behavior without --impact', async () => {
    const dir = makeProject();
    const before = join(dir, 'a.dql');
    const after = join(dir, 'b.dql');
    writeFileSync(before, BASE);
    writeFileSync(after, BASE);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExit();

    // Identical files → no exit, prints "No changes."
    let caught: unknown;
    try {
      await runDiff(before, [after], flags({ impact: false }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('No changes.');
  });

  it('writes pending recertification changesets for impacted semantic definitions', async () => {
    const dir = makeProject();
    writeSemanticMetricManifest(dir);
    const before = join(dir, 'blocks', 'base.before.dql');
    const after = join(dir, 'blocks', 'base.dql');
    writeFileSync(before, BASE);
    writeFileSync(after, BASE.replace('SELECT 1 AS x', 'SELECT 2 AS x'));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExit();

    let caught: unknown;
    try {
      await runDiff(before, [after], flags({ format: 'json', writeRecertification: true }));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeUndefined();
    const payload = JSON.parse(log.mock.calls.map((c) => c[0]).join('\n'));
    expect(payload.recertificationChangeset).toMatchObject({
      written: 1,
      skipped: 0,
      paths: ['semantic-layer/metrics/revenue.yaml'],
    });
    expect(readFileSync(join(dir, 'semantic-layer', 'metrics', 'revenue.yaml'), 'utf-8')).toContain('status: pending_recertification');
  });
});
