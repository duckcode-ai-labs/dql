import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { DbtProvider } from '../semantic/providers/dbt-provider.js';
import { applyDbtMetricPatch, previewDbtMetricPatch, type DbtMetricAuthoringInput } from './dbt-metric-authoring.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BASE_YAML = [
  'version: 2',
  'semantic_models:',
  '  - name: claims',
  "    model: ref('claims')",
  '    defaults: { agg_time_dimension: reported_date }',
  '    entities: [{ name: claim, type: primary, expr: claim_id }]',
  '    dimensions:',
  '      - { name: reported_date, type: time, type_params: { time_granularity: day } }',
  '    measures:',
  '      - { name: claimed_amount, agg: sum }',
  '      - { name: claim_count, agg: count, expr: claim_id }',
  'metrics:',
  '  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }',
  '',
].join('\n');

function project(extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-syn-'));
  roots.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  writeFileSync(join(root, 'models', 'claims.sql'), 'select 1 as claim_id');
  writeFileSync(join(root, 'models', 'claims.yml'), BASE_YAML + extra);
  const manifestPath = join(root, 'target', 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    nodes: { 'model.harbor.claims': { unique_id: 'model.harbor.claims', resource_type: 'model', name: 'claims', original_file_path: 'models/claims.sql', columns: { claim_id: { name: 'claim_id' }, claimed_amount: { name: 'claimed_amount' }, product: { name: 'product' }, reported_date: { name: 'reported_date' } } } },
    sources: {}, metrics: {}, semantic_models: {}, child_map: {},
  }));
  return { root, manifestPath };
}

const add: DbtMetricAuthoringInput = {
  mode: 'add',
  semanticModel: 'claims',
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', aggregation: 'average', column: 'claimed_amount', synonyms: ['avg claim', ' mean claim size ', 'AVG CLAIM'] },
};

describe('metric synonyms travel in the same dbt YAML patch', () => {
  it('previews config.meta.synonyms (trimmed, de-duplicated) beside the metric', () => {
    const { root, manifestPath } = project();
    const preview = previewDbtMetricPatch(root, manifestPath, add);
    expect(preview.patches).toHaveLength(1);
    const document = yaml.load(preview.patches[0]!.after) as { metrics: Array<{ name: string; config?: { meta?: { synonyms?: string[] } } }> };
    expect(document.metrics.find((metric) => metric.name === 'average_claimed_amount')?.config?.meta?.synonyms).toEqual(['avg claim', 'mean claim size']);
  });

  it('changing only the synonyms changes the fingerprint, so a reviewed patch cannot be applied with other words', () => {
    const { root, manifestPath } = project();
    const reviewed = previewDbtMetricPatch(root, manifestPath, add);
    const other = { ...add, metric: { ...add.metric, synonyms: ['typical claim'] } };
    expect(() => applyDbtMetricPatch(root, manifestPath, other, reviewed.fingerprint)).toThrow(/changed after the preview/);
    expect(readFileSync(join(root, 'models', 'claims.yml'), 'utf8')).not.toContain('typical claim');
  });

  it('keeps the existing meta and synonyms of a metric that is edited without new synonyms', () => {
    const { root, manifestPath } = project();
    applyDbtMetricPatch(root, manifestPath, add, previewDbtMetricPatch(root, manifestPath, add).fingerprint);
    const edit: DbtMetricAuthoringInput = { ...add, mode: 'edit', metric: { ...add.metric, description: 'Mean claimed amount.', synonyms: undefined } };
    const after = yaml.load(previewDbtMetricPatch(root, manifestPath, edit).patches[0]!.after) as { metrics: Array<{ name: string; config?: { meta?: { synonyms?: string[] } } }> };
    expect(after.metrics.find((metric) => metric.name === 'average_claimed_amount')?.config?.meta?.synonyms).toEqual(['avg claim', 'mean claim size']);
  });

  it('is read back by DQL as aliases of the metric once the YAML is applied', () => {
    const { root, manifestPath } = project();
    applyDbtMetricPatch(root, manifestPath, add, previewDbtMetricPatch(root, manifestPath, add).fingerprint);
    // Without a manifest DQL reads the project YAML, the way a project that has not run dbt parse yet is read.
    rmSync(manifestPath);
    const layer = new DbtProvider().load({ provider: 'dbt' }, root);
    expect(layer.listMetrics().find((metric) => metric.name === 'average_claimed_amount')?.synonyms).toEqual(['avg claim', 'mean claim size']);
  });

  it('reads synonyms from a compiled manifest metric too', () => {
    const { root, manifestPath } = project();
    writeFileSync(manifestPath, JSON.stringify({
      nodes: {},
      semantic_models: { 'semantic_model.harbor.claims': { name: 'claims', model: "ref('claims')", defaults: { agg_time_dimension: 'reported_date' }, entities: [{ name: 'claim', type: 'primary' }], dimensions: [{ name: 'reported_date', type: 'time', type_params: { time_granularity: 'day' } }], measures: [{ name: 'average_claimed_amount', agg: 'average', expr: 'claimed_amount' }] } },
      metrics: { 'metric.harbor.average_claimed_amount': { name: 'average_claimed_amount', type: 'simple', type_params: { measure: 'average_claimed_amount' }, config: { meta: { synonyms: ['avg claim'] } } } },
    }));
    const layer = new DbtProvider().load({ provider: 'dbt' }, root);
    expect(layer.listMetrics().find((metric) => metric.name === 'average_claimed_amount')?.synonyms).toEqual(['avg claim']);
  });
});

describe('editing a metric never silently changes a measure other metrics use', () => {
  const ratio = [
    '  - name: claim_rate',
    '    type: ratio',
    '    type_params:',
    '      numerator: claimed_amount',
    '      denominator: claim_count',
    '',
  ].join('\n');
  const edit: DbtMetricAuthoringInput = { mode: 'edit', semanticModel: 'claims', metric: { name: 'claimed_amount', aggregation: 'average', column: 'claimed_amount' } };

  it('refuses a new aggregation when a ratio metric uses the measure, and names that metric', () => {
    const { root, manifestPath } = project(ratio);
    let message = '';
    try { previewDbtMetricPatch(root, manifestPath, edit); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/"claim_rate"/);
    expect(message).toMatch(/also used by/);
  });

  it('refuses when only the dbt manifest (not the YAML files) shows the other metric', () => {
    const { root, manifestPath } = project();
    writeFileSync(manifestPath, JSON.stringify({
      nodes: {}, sources: {}, semantic_models: {}, child_map: {},
      metrics: { 'metric.harbor.big_claims': { name: 'big_claims', type: 'simple', type_params: { measure: { name: 'claimed_amount' } } } },
    }));
    expect(() => previewDbtMetricPatch(root, manifestPath, edit)).toThrow(/"big_claims"/);
  });

  it('refuses a changed column as well as a changed aggregation', () => {
    const { root, manifestPath } = project(ratio);
    expect(() => previewDbtMetricPatch(root, manifestPath, { ...edit, metric: { ...edit.metric, aggregation: 'sum', column: 'product' } })).toThrow(/"claim_rate"/);
  });

  it('allows a label, description or synonym edit, which does not change what the measure computes', () => {
    const { root, manifestPath } = project(ratio);
    const same: DbtMetricAuthoringInput = { ...edit, metric: { name: 'claimed_amount', aggregation: 'sum', column: 'claimed_amount', description: 'Total claimed.', synonyms: ['total claims'] } };
    expect(previewDbtMetricPatch(root, manifestPath, same).patches[0]?.changed).toBe(true);
  });

  it('allows the aggregation to change when nothing else uses the measure', () => {
    const { root, manifestPath } = project();
    const preview = previewDbtMetricPatch(root, manifestPath, edit);
    expect(preview.patches[0]!.after).toContain('agg: average');
  });
});
