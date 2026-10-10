import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentProvider, AgentRunRequest } from '@duckcodeailabs/dql-agent';
import { buildManifest, loadSemanticLayerFromDir } from '@duckcodeailabs/dql-core';
import { createAskPipelineRouteExecutor, type AskPipelineHostDeps } from './host.js';

// The Harbor Mutual sandbox project, copied verbatim from dql-sandbox-workspace: the certified block
// "Open claims by region", the claims cube, the claim_count metric and the status/region dimensions.
// The reading is what the live gate run recorded (metric claim_count, status = 'open' as exact text, by region).
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/harbor-claims');
const BLOCK_PATH = 'domains/claims/blocks/open-claims-by-region.dql';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;

const reading = JSON.stringify({
  version: 1, kind: 'analytics', reading: 'Count of open claims by region.',
  measures: [{ ref: 'metric:claims.claim_count' }],
  groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }],
  filters: [{ ref: 'dimension:claims.status', op: 'eq', values: ['open'], source: 'question' }],
  display: [], unresolved: [], provenance: { 'metric:claims.claim_count': 'q:claims' }, expectedShape: 'breakdown',
});

interface Pipeline { tiers: Array<{ tier: string; outcome: string; detail?: string }>; refusals: Array<{ tier: string; code: string; message: string }>; reuse: string; context?: { admitted?: { byKind?: Record<string, number> } } }
interface Run { trustState?: string; artifacts: Array<{ payload: { askPipeline?: Pipeline } }> }

/** Copy the fixture, optionally swap the block's measure expression, then build the manifest and semantic layer the way the notebook server does. */
function asker(options: { blockCount?: string; extra?: Partial<AskPipelineHostDeps> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dql-certified-source-access-'));
  roots.push(root);
  cpSync(fixture, root, { recursive: true });
  if (options.blockCount) {
    const path = join(root, BLOCK_PATH);
    writeFileSync(path, readFileSync(path, 'utf8').replace('COUNT(DISTINCT claim_id) AS open_claims', `${options.blockCount} AS open_claims`));
  }
  const manifest = buildManifest({ projectRoot: root });
  const semanticLayer = loadSemanticLayerFromDir(join(root, 'semantic-layer'));
  const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reading };
  const executeQuery = vi.fn(async (statement: string) => {
    if (statement.includes('information_schema.columns')) {
      return { columns: [], rowCount: 3, executionTimeMs: 1, rows: ['claim_id', 'region', 'status'].map((column) => ({ table_schema: 'main', table_name: 'claims', column_name: column, data_type: 'VARCHAR' })) };
    }
    return { columns: ['region', 'open_claims'], rowCount: 2, executionTimeMs: 1, rows: [{ region: 'West', open_claims: 3 }, { region: 'East', open_claims: 2 }] };
  });
  const run = createAskPipelineRouteExecutor({
    projectRoot: root,
    executor: { executeQuery } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => semanticLayer,
    getManifest: () => ({ snapshotId: 'snapshot:harbor', manifest }),
    selectProvider: async () => provider,
    semanticEngine: async () => 'native',
    compileSemantic: async () => ({ sql: "SELECT region, COUNT(DISTINCT claim_id) AS claim_count FROM claims WHERE status = 'open' GROUP BY region", engine: 'native' }),
    priorIntent: () => undefined,
    ...options.extra,
  });
  return async () => {
    const result = await run({ runId: 'run:harbor', request: { question: 'How many open claims are there by region?', requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => undefined }) as unknown as Run;
    return { trust: result.trustState, pipeline: result.artifacts[0]!.payload.askPipeline! };
  };
}

// Enterprise's sourceAccess allows every source that has no steward restriction.
const allowEverything: NonNullable<AskPipelineHostDeps['admitSources']> = { key: () => 'u-explorer:', admit: async (source) => source };

describe('the Harbor certified block answers Certified, with or without a host sourceAccess hook', () => {
  it('builds a manifest that holds the real block as certified', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-certified-source-access-'));
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const block = buildManifest({ projectRoot: root }).blocks['Open claims by region'];
    expect(block).toMatchObject({ status: 'certified', domain: 'claims', filePath: BLOCK_PATH });
  });

  for (const [name, extra] of [['no host hook', {}], ['a hook that allows everything', { admitSources: allowEverything }]] as const) {
    it(`attempts the certified block and answers Certified (${name})`, async () => {
      const { trust, pipeline } = await asker({ extra })();
      expect(pipeline.context?.admitted?.byKind?.block).toBe(1);
      expect(pipeline.tiers.find((attempt) => attempt.tier === 'certified')).toMatchObject({ outcome: 'prepared' });
      expect(trust).toBe('certified');
    });
  }
});

describe('a reused preparation still shows what the tiers said the first time', () => {
  it('a block that does not entail the metric is refused in the first run, and the second run (reuse: preparation) still names that refusal', async () => {
    const ask = asker({ blockCount: 'COUNT(*)', extra: { admitSources: allowEverything } });
    const first = await ask();
    expect(first.trust).toBe('governed');
    expect(first.pipeline.reuse).toBe('none');
    const refused = first.pipeline.tiers.find((attempt) => attempt.tier === 'certified');
    expect(refused).toMatchObject({ outcome: 'refused' });
    expect(refused?.detail).toMatch(/block:claims\.Open claims by region/);

    const second = await ask();
    expect(second.trust).toBe('governed');
    expect(second.pipeline.reuse).toBe('preparation');
    // The live gate saw tiers = [] and refusals = [] here: no sign the block was ever tried.
    expect(second.pipeline.tiers.find((attempt) => attempt.tier === 'certified')).toMatchObject({ outcome: 'refused', detail: refused?.detail });
    expect(second.pipeline.refusals.find((refusal) => refusal.tier === 'certified')).toMatchObject({ code: 'block_not_applicable' });
  });
});
