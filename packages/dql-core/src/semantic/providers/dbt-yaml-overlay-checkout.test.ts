import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveSemanticLayerWithDiagnostics } from './registry.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// A git checkout writes models/ before target/manifest.json, so the YAML holding a metric Add metric wrote can look
// older than the manifest. That metric (marked meta.dql.authored) and the measure it needs must still be read;
// any other YAML-only metric in an older file stays out, as before.
function checkout(metricLines: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-checkout-'));
  roots.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  const yamlPath = join(root, 'models', 'claims_semantic.yml');
  writeFileSync(yamlPath, [
    'version: 2',
    'semantic_models:',
    '  - name: claims',
    "    model: ref('claims')",
    '    defaults: { agg_time_dimension: reported_date }',
    '    entities: [{ name: claim, type: primary, expr: claim_id }]',
    '    dimensions:',
    '      - { name: product, type: categorical }',
    '      - { name: reported_date, type: time, type_params: { time_granularity: day } }',
    '    measures:',
    '      - { name: claimed_amount, agg: sum }',
    '      - { name: average_claimed_amount, agg: average, expr: claimed_amount }',
    '      - { name: other_measure, agg: max, expr: claimed_amount }',
    'metrics:',
    '  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }',
    ...metricLines,
    '',
  ].join('\n'));
  writeFileSync(join(root, 'target', 'manifest.json'), JSON.stringify({
    nodes: {},
    semantic_models: {
      'semantic_model.harbor.claims': {
        name: 'claims', model: "ref('claims')", defaults: { agg_time_dimension: 'reported_date' },
        entities: [{ name: 'claim', type: 'primary', expr: 'claim_id' }],
        dimensions: [{ name: 'product', type: 'categorical' }, { name: 'reported_date', type: 'time', type_params: { time_granularity: 'day' } }],
        measures: [{ name: 'claimed_amount', agg: 'sum' }],
      },
    },
    metrics: { 'metric.harbor.claimed_amount': { name: 'claimed_amount', type: 'simple', type_params: { measure: { name: 'claimed_amount' } } } },
  }));
  const older = new Date(Date.now() - 60_000);
  utimesSync(yamlPath, older, older);
  return root;
}

const AUTHORED = '  - { name: average_claimed_amount, type: simple, type_params: { measure: average_claimed_amount }, config: { meta: { dql: { authored: true } } } }';

describe('dbt YAML overlay after a git checkout (YAML older than the manifest)', () => {
  it('reads a metric Add metric wrote that the manifest lacks, with the measure it needs', () => {
    const { layer, diagnostics } = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, checkout([AUTHORED]));
    expect(layer!.getMetric('average_claimed_amount')).toMatchObject({ sql: 'AVG(claimed_amount)', cube: 'claims' });
    expect(layer!.getMetric('claimed_amount')).toBeDefined();
    expect(diagnostics).toContain('Metric "average_claimed_amount" was read from YAML (models/claims_semantic.yml); run dbt parse to confirm.');
  });

  it('leaves out a YAML-only metric Add metric did not write', () => {
    const root = checkout(['  - { name: other_metric, type: simple, type_params: { measure: other_measure } }']);
    const { layer } = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(layer!.getMetric('other_metric')).toBeUndefined();
  });

  it('leaves out an authored metric that dbt disables', () => {
    const root = checkout(['  - { name: average_claimed_amount, type: simple, type_params: { measure: average_claimed_amount }, config: { enabled: false, meta: { dql: { authored: true } } } }']);
    const { layer } = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(layer!.getMetric('average_claimed_amount')).toBeUndefined();
  });
});
