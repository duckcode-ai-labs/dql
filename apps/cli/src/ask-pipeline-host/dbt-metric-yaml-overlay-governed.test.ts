import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import type { AgentProvider, AgentRunRequest } from '@zlens/agent';
import { applyDbtMetricPatch, buildManifest, previewDbtMetricPatch, resolveSemanticLayer, type DbtMetricAuthoringInput } from '@zlens/core';
import { createAskPipelineRouteExecutor } from './host.js';

// Owner scenario B4 without `dbt parse`: DQL Enterprise never runs dbt and the sandbox workspace commits
// target/manifest.json. A metric added through the dbt-metric apply route lands in the YAML only, and Ask must still
// answer it as Governed. The manifest is the base; YAML edited after it was written is overlaid.
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/harbor-claims');

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
const COLUMNS = ['claim_id', 'region', 'product', 'claim_type', 'status', 'claimed_amount', 'reported_date'];

// Stand-in for the `dbt parse` that ran before the creator edited anything.
function writeManifest(root: string) {
  const document = yaml.load(readFileSync(join(root, 'models', 'claims', 'claims_semantic.yml'), 'utf8')) as {
    semantic_models: Array<{ name: string }>; metrics: Array<{ name: string }>;
  };
  const keyed = (kind: string, items: Array<{ name: string }>) => Object.fromEntries(items.map((item) => [`${kind}.harbor.${item.name}`, item]));
  const path = join(root, 'target', 'manifest.json');
  writeFileSync(path, JSON.stringify({
    nodes: { 'model.harbor.claims': { unique_id: 'model.harbor.claims', resource_type: 'model', name: 'claims', original_file_path: 'models/claims/claims.sql', columns: Object.fromEntries(COLUMNS.map((name) => [name, { name }])) } },
    sources: {}, child_map: {},
    semantic_models: keyed('semantic_model', document.semantic_models),
    metrics: keyed('metric', document.metrics),
  }));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(path, past, past);
}

function dbtHarbor() {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-overlay-governed-'));
  roots.push(root);
  cpSync(fixture, root, { recursive: true });
  rmSync(join(root, 'semantic-layer'), { recursive: true, force: true });
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({
    project: 'harbor-claims', manifestVersion: 3, modeling: { mode: 'dbt-first' }, apps: { datasets: true },
    connections: { default: { driver: 'duckdb', filepath: 'harbor.duckdb' } },
    semanticLayer: { provider: 'dbt' },
    dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }));
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  mkdirSync(join(root, 'models', 'claims'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'models', 'claims', 'claims.sql'), 'select * from raw.claims');
  writeFileSync(join(root, 'models', 'claims', 'claims_semantic.yml'), [
    'version: 2',
    'semantic_models:',
    '  - name: claims',
    "    model: ref('claims')",
    '    defaults: { agg_time_dimension: reported_date }',
    '    entities: [{ name: claim, type: primary, expr: claim_id }]',
    '    dimensions:',
    '      - { name: region, type: categorical }',
    '      - { name: status, type: categorical }',
    '      - { name: reported_date, type: time, type_params: { time_granularity: day } }',
    '    measures:',
    '      - { name: claim_count, agg: count_distinct, expr: claim_id }',
    '      - { name: claimed_amount, agg: sum }',
    'metrics:',
    '  - { name: claim_count, type: simple, type_params: { measure: claim_count } }',
    '  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }',
    '',
  ].join('\n'));
  writeManifest(root);
  return { root, manifestPath: join(root, 'target', 'manifest.json') };
}

const addAverage: DbtMetricAuthoringInput = {
  mode: 'add',
  semanticModel: 'claims',
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', description: 'Mean amount claimed per claim.', aggregation: 'average', column: 'claimed_amount', domain: 'claims' },
  dimensions: [{ name: 'product', column: 'product' }],
};

interface Run { trustState?: string }

async function askAverageByProduct(root: string) {
  const reading = JSON.stringify({
    version: 1, kind: 'analytics', reading: 'Average claimed amount by product.',
    measures: [{ ref: 'metric:claims.average_claimed_amount' }],
    groupBy: [{ ref: 'dimension:claims.product', role: 'categorical' }],
    filters: [], display: [], unresolved: [], provenance: { 'metric:claims.average_claimed_amount': 'q:claims' }, expectedShape: 'breakdown',
  });
  const semanticLayer = resolveSemanticLayer({ provider: 'dbt' }, root)!;
  const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reading };
  const executeQuery = vi.fn(async (statement: string) => {
    if (statement.includes('information_schema.columns')) {
      return { columns: [], rowCount: COLUMNS.length, executionTimeMs: 1, rows: COLUMNS.map((column) => ({ table_schema: 'main', table_name: 'claims', column_name: column, data_type: 'VARCHAR' })) };
    }
    return { columns: ['product', 'average_claimed_amount'], rowCount: 2, executionTimeMs: 1, rows: [{ product: 'Auto', average_claimed_amount: 4200 }, { product: 'Home', average_claimed_amount: 9100 }] };
  });
  const run = createAskPipelineRouteExecutor({
    projectRoot: root,
    executor: { executeQuery } as unknown as QueryExecutor,
    resolveConnection: async () => connection,
    getSemanticLayer: () => semanticLayer,
    getManifest: () => ({ snapshotId: 'snapshot:harbor-dbt', manifest: buildManifest({ projectRoot: root }) }),
    selectProvider: async () => provider,
    semanticEngine: async () => 'native',
    compileSemantic: async () => ({ sql: 'SELECT product, AVG(claimed_amount) AS average_claimed_amount FROM claims GROUP BY product', engine: 'native' }),
    priorIntent: () => undefined,
  });
  const result = await run({ runId: 'run:b4-overlay', request: { question: 'What is the average claimed amount by product?', requestedMode: 'ask' } as AgentRunRequest, route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => undefined }) as unknown as Run;
  return { trust: result.trustState, semanticLayer };
}

describe('B4 without dbt parse: a metric added to the dbt YAML makes Ask answer Governed', () => {
  it('answers Governed right after the apply route writes the YAML, with the manifest untouched', async () => {
    const { root, manifestPath } = dbtHarbor();
    const before = await askAverageByProduct(root);
    expect(before.semanticLayer.getMetric('average_claimed_amount')).toBeUndefined();
    expect(before.trust).not.toBe('governed');

    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const preview = previewDbtMetricPatch(root, manifestPath, addAverage);
    applyDbtMetricPatch(root, manifestPath, addAverage, preview.fingerprint);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);

    const after = await askAverageByProduct(root);
    expect(after.semanticLayer.getMetric('average_claimed_amount')).toMatchObject({ sql: 'AVG(claimed_amount)', cube: 'claims', domain: 'claims', label: 'Average claimed amount' });
    expect(after.semanticLayer.getDimension('product')).toMatchObject({ cube: 'claims', sql: 'product' });
    expect(after.semanticLayer.getDiagnostics()).toContain('Metric "average_claimed_amount" was read from YAML (models/claims/claims_semantic.yml); run dbt parse to confirm.');
    expect(after.trust).toBe('governed');
  });
});
