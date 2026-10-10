import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { AgentProvider, AgentRunRequest } from '@duckcodeailabs/dql-agent';
import { SemanticLayer } from '@duckcodeailabs/dql-core';
import { createAskPipelineRouteExecutor, type AskPipelineHostDeps } from './host.js';

// The Harbor sandbox shape: a certified block "Open claims by region" over the claims table, a claim_count
// metric, and the reading the live run recorded (metric claim_count, status = 'open' as exact text, by region).
const BLOCK_PATH = 'domains/claims/blocks/open-claims-by-region.dql';
const blockSql = (count: string) => `SELECT region, ${count} AS open_claims FROM claims WHERE status = 'open' GROUP BY region`;
const blockSource = (sql: string) => `// dql-format: 1
block "Open claims by region" {
  domain = "claims"
  type = "custom"
  status = "certified"
  description = "Open claims by region."
  owner = "claims-team"
  outputs = ["region", "open_claims"]
  query = """
    ${sql}
  """
}
`;

const root = mkdtempSync(join(tmpdir(), 'dql-certified-source-access-'));
mkdirSync(join(root, 'domains/claims/blocks'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;

const semanticLayer = new SemanticLayer({
  metrics: [{ name: 'claim_count', label: 'Claim count', description: 'Distinct claims.', domain: 'claims', sql: 'claim_id', type: 'count_distinct', metricType: 'simple', table: 'main.claims' }],
  dimensions: [
    { name: 'region', label: 'Region', description: '', domain: 'claims', sql: 'region', type: 'string', table: 'main.claims' },
    { name: 'status', label: 'Status', description: '', domain: 'claims', sql: 'status', type: 'string', table: 'main.claims' },
  ],
} as never);

const reading = JSON.stringify({
  version: 1, kind: 'analytics', reading: 'Count of open claims by region.',
  measures: [{ ref: 'metric:claim_count' }],
  groupBy: [{ ref: 'dimension:claims.region', role: 'categorical' }],
  filters: [{ ref: 'dimension:claims.status', op: 'eq', values: ['open'], source: 'question' }],
  display: [], unresolved: [], provenance: { 'metric:claim_count': 'q:claims' }, expectedShape: 'breakdown',
});

interface Pipeline { tiers: Array<{ tier: string; outcome: string; detail?: string }>; refusals: Array<{ tier: string; code: string; message: string }>; reuse: string; context?: { admitted?: { byKind?: Record<string, number> } } }
interface Run { trustState?: string; artifacts: Array<{ payload: { askPipeline?: Pipeline } }> }

function asker(options: { block: string; extra?: Partial<AskPipelineHostDeps> }) {
  writeFileSync(join(root, BLOCK_PATH), blockSource(options.block));
  const manifest = {
    blocks: {
      'Open claims by region': {
        name: 'Open claims by region', domain: 'claims', status: 'certified', description: 'Open claims by region.', filePath: BLOCK_PATH, sql: options.block,
        declaredOutputs: ['region', 'open_claims'], tags: [], tableDependencies: ['claims'],
      },
    },
    sources: {
      claims: {
        name: 'claims', origin: 'dbt', referencedBy: [],
        dbtModel: { uniqueId: 'model.harbor.claims', schema: 'main', columns: { claim_id: { name: 'claim_id' }, region: { name: 'region' }, status: { name: 'status' } } },
      },
    },
  };
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
    getManifest: () => ({ snapshotId: 'snapshot:harbor', manifest: manifest as never }),
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

describe('the certified tier runs first, with or without a host sourceAccess hook', () => {
  for (const [name, extra] of [['no host hook', {}], ['a hook that allows everything', { admitSources: allowEverything }]] as const) {
    it(`attempts the certified block and answers Certified (${name})`, async () => {
      const ask = asker({ block: blockSql('COUNT(DISTINCT claim_id)'), extra });
      const { trust, pipeline } = await ask();
      expect(pipeline.context?.admitted?.byKind?.block).toBe(1);
      expect(pipeline.tiers.find((attempt) => attempt.tier === 'certified')).toMatchObject({ outcome: 'prepared' });
      expect(trust).toBe('certified');
    });
  }
});

describe('a reused preparation still shows what the tiers said the first time', () => {
  it('a block that does not entail the metric is refused in the first run, and the second run (reuse: preparation) still names that refusal', async () => {
    const ask = asker({ block: blockSql('COUNT(*)'), extra: { admitSources: allowEverything } });
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
