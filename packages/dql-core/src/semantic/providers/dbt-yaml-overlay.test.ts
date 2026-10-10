import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveSemanticLayerWithDiagnostics } from './registry.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const BASE_YAML = [
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
];

function project(metricsYaml: string[], yamlAgeSeconds: number) {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-overlay-'));
  roots.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  // The manifest dbt last wrote: one semantic model and one metric.
  const manifest = join(root, 'target', 'manifest.json');
  writeFileSync(manifest, JSON.stringify({
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
  const yamlPath = join(root, 'models', 'claims_semantic.yml');
  writeFileSync(yamlPath, [...BASE_YAML, 'metrics:', ...metricsYaml, ''].join('\n'));
  const when = new Date(Date.now() + yamlAgeSeconds * 1000);
  utimesSync(yamlPath, when, when);
  return { root, yamlPath };
}

const SIMPLE_AVERAGE = [
  '  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }',
  '  - name: average_claimed_amount',
  '    type: simple',
  '    type_params: { measure: average_claimed_amount }',
  '    config: { meta: { synonyms: [mean claim] } }',
];
const AVERAGE_MEASURE = '      - { name: average_claimed_amount, agg: average, expr: claimed_amount }';

describe('dbt YAML overlay on the manifest', () => {
  it('reads a metric that is only in the YAML and says so in diagnostics', () => {
    const { root, yamlPath } = project(SIMPLE_AVERAGE, 60);
    // Add the measure the new metric uses, as Add metric does.
    const text = [...BASE_YAML, AVERAGE_MEASURE, 'metrics:', ...SIMPLE_AVERAGE, ''].join('\n');
    writeFileSync(yamlPath, text);
    utimesSync(yamlPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.errors).toEqual([]);
    expect(result.layer!.getMetric('claimed_amount')).toBeDefined();
    expect(result.layer!.getMetric('average_claimed_amount')).toMatchObject({ sql: 'AVG(claimed_amount)', cube: 'claims', synonyms: ['mean claim'] });
    expect(result.diagnostics).toContain('Metric "average_claimed_amount" was read from YAML (models/claims_semantic.yml); run dbt parse to confirm.');
  });

  it('keeps the manifest as the base: an older YAML does not replace a metric the manifest has', () => {
    const { root } = project(['  - { name: claimed_amount, type: simple, label: From YAML, type_params: { measure: claimed_amount } }'], -3600);
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.layer!.getMetric('claimed_amount')?.label).toBe('claimed_amount');
    expect(result.diagnostics).toEqual([]);
  });

  it('leaves out a YAML metric the manifest lacks when dbt parsed after the file was last edited', () => {
    const { root } = project(['  - { name: disabled_metric, type: simple, type_params: { measure: claimed_amount } }'], -3600);
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.layer!.getMetric('disabled_metric')).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it('uses the YAML for a metric the manifest has when the YAML file is newer', () => {
    const { root } = project(['  - { name: claimed_amount, type: simple, label: From YAML, type_params: { measure: claimed_amount } }'], 60);
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.layer!.getMetric('claimed_amount')?.label).toBe('From YAML');
    expect(result.diagnostics?.[0]).toMatch(/claimed_amount.*read from YAML/);
  });

  it('reports a YAML metric whose measure does not exist as a diagnostic and still loads the rest', () => {
    const { root } = project(['  - { name: broken_metric, type: simple, type_params: { measure: no_such_measure } }'], 60);
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.errors).toEqual([]);
    expect(result.layer!.getMetric('broken_metric')).toBeUndefined();
    expect(result.layer!.getMetric('claimed_amount')).toBeDefined();
    expect(result.diagnostics?.[0]).toBe('Metric "broken_metric" in models/claims_semantic.yml was not read from YAML: "no_such_measure" is not a measure or metric in the manifest or the YAML.');
  });

  it('reports a metric with an invalid name instead of reading it', () => {
    const { root } = project(['  - { name: Bad-Name, type: simple, type_params: { measure: claimed_amount } }'], 60);
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.layer!.getMetric('Bad-Name')).toBeUndefined();
    expect(result.diagnostics?.[0]).toMatch(/Bad-Name.*lowercase letters/);
  });

  it('does not crash on malformed YAML beside valid files', () => {
    const { root } = project(['  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }'], -3600);
    writeFileSync(join(root, 'models', 'broken.yml'), 'metrics: [unclosed');
    const result = resolveSemanticLayerWithDiagnostics({ provider: 'dbt' }, root);
    expect(result.errors).toEqual([]);
    expect(result.layer!.getMetric('claimed_amount')).toBeDefined();
  });
});
