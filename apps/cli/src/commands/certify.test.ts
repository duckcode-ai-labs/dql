import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCertify } from './certify.js';
import type { CLIFlags } from '../args.js';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(projectDir);
  return projectDir;
}

function flags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    check: false,
    chart: '',
    domain: '',
    format: 'json',
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
    ...overrides,
  };
}

function writeDataLexManifest(projectDir: string): void {
  writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({
    project: 'demo',
    datalex: { manifestPath: 'datalex-manifest.json' },
  }));
  writeFileSync(join(projectDir, 'datalex-manifest.json'), JSON.stringify({
    manifestSpecVersion: '1.0.0',
    datalexVersion: '1.0.0',
    generatedAt: '2026-06-20T00:00:00Z',
    project: { name: 'demo' },
    domains: [
      {
        name: 'commerce',
        entities: [
          {
            name: 'Customer',
            contracts: [
              { id: 'commerce.Customer.monthly_active_customers', name: 'monthly_active_customers', version: 1 },
            ],
          },
        ],
      },
    ],
  }));
}

function writeCertifiedBlock(projectDir: string, contractRef: string): string {
  const blockPath = join(projectDir, 'blocks', 'customer_metric.dql');
  mkdirSync(join(projectDir, 'blocks'), { recursive: true });
  writeFileSync(blockPath, `block "Customer Metric" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  datalex_contract = "${contractRef}"
  description = "Certified customer metric bound to a DataLex contract."
  owner = "analytics"
  tags = ["customer"]
  query = """SELECT 1 AS ok"""

  tests {
    assert row_count > 0
  }
}`);
  return blockPath;
}

function lastJsonLog(spy: ReturnType<typeof vi.spyOn>): any {
  const json = spy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .reverse()
    .find((value) => value.trim().startsWith('{'));
  return JSON.parse(json ?? '{}');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runCertify', () => {
  it('fails certification when a certified block references an unresolved DataLex contract', async () => {
    const projectDir = makeProject('dql-certify-contract-');
    writeDataLexManifest(projectDir);
    const blockPath = writeCertifiedBlock(projectDir, 'commerce.Customer.unknown_contract@1');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags());
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.certified).toBe(false);
    expect(payload.errors.some((error: { rule: string; message: string }) =>
      error.rule === 'DataLex contract'
      && error.message.includes('not found in the loaded DataLex manifest'),
    )).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('does not add DataLex errors when a certified block references a known DataLex contract', async () => {
    const projectDir = makeProject('dql-certify-contract-ok-');
    writeDataLexManifest(projectDir);
    const blockPath = writeCertifiedBlock(projectDir, 'commerce.Customer.monthly_active_customers@1');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags());
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.errors.some((error: { rule: string }) => error.rule === 'DataLex contract')).toBe(false);
    expect(payload.datalexDiagnostics).toEqual([]);
  });

  it('treats declared tests as present when enterprise certification skips runtime execution', async () => {
    const projectDir = makeProject('dql-certify-skip-tests-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    mkdirSync(join(projectDir, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    const blockPath = join(projectDir, 'domains', 'nba', 'blocks', '_drafts', 'top_players.dql');
    writeFileSync(blockPath, `block "Top Players" {
  domain = "nba"
  type = "custom"
  status = "draft"
  description = "Ranks players by total points."
  owner = "sports-analytics"
  tags = ["nba"]
  pattern = "ranking"
  grain = "player_name"
  entities = ["NBA player"]
  outputs = ["player_name", "total_points"]
  allowedFilters = ["season_start", "season_end", "top_n"]
  parameterPolicy {
    season_start = "dynamic"
    season_end = "dynamic"
    top_n = "dynamic"
  }
  sourceSystems = ["TRANSFORMED.int_player_stats"]
  reviewCadence = "quarterly"
  query = """SELECT player_name, SUM(pts) AS total_points FROM int_player_stats GROUP BY player_name"""
  tests {
    assert row_count > 0
  }
}`);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(projectDir);
      await runCertify(blockPath, flags({ enterprise: true, skipTests: true, connection: '' } as Partial<CLIFlags>));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.certified).toBe(true);
    expect(payload.errors).toEqual([]);
    expect(payload.testResults).toMatchObject({ passed: 0, failed: 0, skipped: 1 });
    expect(process.exitCode).toBeUndefined();
  });

  it('blocks enterprise certification when declared invariants cannot be evaluated (no run result)', async () => {
    // Without a usable DB connection the block cannot run, so its declared
    // invariants are unverified. In enterprise mode `invariants-hold` is an
    // error, so certification must be blocked rather than passing on unproven
    // guarantees. This exercises the certify -> invariants-hold wiring without
    // depending on an installed warehouse driver.
    const projectDir = makeProject('dql-certify-invariant-unverified-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    mkdirSync(join(projectDir, 'blocks'), { recursive: true });
    const blockPath = join(projectDir, 'blocks', 'approval.dql');
    writeFileSync(blockPath, `block "Approval Rate" {
  domain = "ops"
  type = "custom"
  status = "draft"
  description = "Approval rate."
  owner = "ops"
  tags = ["ops"]
  pattern = "metric_wrapper"
  grain = "day"
  entities = []
  outputs = ["approval_rate_pct"]
  metric = "approval_rate_pct"
  sourceSystems = ["ops.events"]
  reviewCadence = "quarterly"
  allowedFilters = ["day"]
  filterBindings {
    day = "day"
  }
  query = """SELECT 80 AS approval_rate_pct"""
  invariants = ["approval_rate_pct <= 100"]
}`);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      // No connection => block does not run => invariants unverified.
      await runCertify(blockPath, flags({ enterprise: true, connection: '' } as Partial<CLIFlags>));
    } finally {
      process.chdir(previousCwd);
    }

    const payload = lastJsonLog(spy);
    expect(payload.certified).toBe(false);
    expect(payload.errors.some((error: { rule: string }) => error.rule === 'Declared invariants hold')).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to promote a draft whose certification rules do not pass, and keeps the draft', async () => {
    const projectDir = makeProject('dql-certify-promote-refused-');
    writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
    mkdirSync(join(projectDir, 'domains', 'nba', 'blocks', '_drafts'), { recursive: true });
    const draftRel = 'domains/nba/blocks/_drafts/no_owner.dql';
    // No owner: the OSS rules refuse it.
    writeFileSync(join(projectDir, draftRel), `block "No Owner" {
  domain = "nba"
  type = "custom"
  status = "draft"
  description = "Missing an owner."
  query = """SELECT 1 AS value"""
}`);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      await runCertify('', flags({ fromDraft: draftRel }));
    } finally {
      process.chdir(previousCwd);
    }
    const payload = lastJsonLog(spy);
    expect(payload.ok).toBe(false);
    expect(payload.blockers.length).toBeGreaterThan(0);
    expect(existsSync(join(projectDir, draftRel))).toBe(true);
    expect(existsSync(join(projectDir, 'domains/nba/blocks/no_owner.dql'))).toBe(false);
    expect(process.exitCode).toBe(1);
  }, 60_000);

  // The passing promotion path (gate passes → certified + receipt) is covered
  // by promote-from-draft.test.ts with an injected gate; running a block here
  // would need a native DuckDB connector inside the test worker.
});
