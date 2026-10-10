import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDbtMetricPatch, previewDbtMetricPatch, type DbtMetricAuthoringInput } from './dbt-metric-authoring.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const COLUMNS = ['claim_id', 'region', 'product', 'status', 'claimed_amount', 'reported_date'];

/** A dbt project with one model (`claims`), its columns documented in the manifest, and optionally a semantic model. */
function project(options: { semantic?: boolean; columns?: string[]; manifest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-'));
  roots.push(root);
  mkdirSync(join(root, 'models', 'claims'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  writeFileSync(join(root, 'models', 'claims', 'claims.sql'), 'select 1 as claim_id');
  if (options.semantic !== false) {
    writeFileSync(join(root, 'models', 'claims', 'claims_semantic.yml'), [
      'version: 2',
      'semantic_models:',
      '  - name: claims',
      "    model: ref('claims')",
      '    defaults:',
      '      agg_time_dimension: reported_date',
      '    entities:',
      '      - name: claim',
      '        type: primary',
      '        expr: claim_id',
      '    dimensions:',
      '      - name: region',
      '        type: categorical',
      '      - name: reported_date',
      '        type: time',
      '        type_params:',
      '          time_granularity: day',
      '    measures:',
      '      - name: claimed_amount',
      '        agg: sum',
      '',
      'metrics:',
      '  - name: claimed_amount',
      '    type: simple',
      '    type_params:',
      '      measure: claimed_amount',
      '',
    ].join('\n'));
  }
  const manifestPath = join(root, 'target', 'manifest.json');
  if (options.manifest !== false) {
    const columns = Object.fromEntries((options.columns ?? COLUMNS).map((name) => [name, { name }]));
    writeFileSync(manifestPath, JSON.stringify({
      nodes: { 'model.harbor.claims': { unique_id: 'model.harbor.claims', resource_type: 'model', name: 'claims', original_file_path: 'models/claims/claims.sql', columns } },
      sources: {}, metrics: {}, semantic_models: {}, child_map: {},
    }));
  }
  return { root, manifestPath };
}

const average: DbtMetricAuthoringInput = {
  mode: 'add',
  semanticModel: 'claims',
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', aggregation: 'average', column: 'claimed_amount' },
  dimensions: [{ name: 'product', column: 'product' }],
};

const message = (run: () => unknown): string => {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return '';
};

describe('previewDbtMetricPatch', () => {
  it('adds the measure, the metric and the dimension to the file that already defines the semantic model', () => {
    const { root, manifestPath } = project();
    const preview = previewDbtMetricPatch(root, manifestPath, average);
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]).toMatchObject({ path: 'models/claims/claims_semantic.yml', changed: true });
    const after = yaml.load(preview.patches[0]!.after) as { semantic_models: Array<Record<string, any>>; metrics: Array<Record<string, any>> };
    const model = after.semantic_models[0]!;
    expect(model.measures).toContainEqual({ name: 'average_claimed_amount', agg: 'average', expr: 'claimed_amount' });
    expect(model.dimensions).toContainEqual({ name: 'product', type: 'categorical' });
    expect(model.measures[0]).toEqual({ name: 'claimed_amount', agg: 'sum' });
    expect(after.metrics.find((metric) => metric.name === 'average_claimed_amount')).toEqual({
      name: 'average_claimed_amount', label: 'Average claimed amount', type: 'simple', type_params: { measure: 'average_claimed_amount' },
    });
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not write anything while previewing', () => {
    const { root, manifestPath } = project();
    const file = join(root, 'models', 'claims', 'claims_semantic.yml');
    const before = readFileSync(file, 'utf8');
    previewDbtMetricPatch(root, manifestPath, average);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('accepts avg for average and records the domain as metric meta', () => {
    const { root, manifestPath } = project();
    const preview = previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, aggregation: 'AVG', domain: 'claims' } });
    const after = yaml.load(preview.patches[0]!.after) as { semantic_models: Array<Record<string, any>>; metrics: Array<Record<string, any>> };
    expect(after.semantic_models[0]!.measures.at(-1).agg).toBe('average');
    expect(after.metrics.at(-1)!.config).toEqual({ meta: { domain: 'claims' } });
  });

  it('creates a semantic model in a new file beside the dbt model when none exists', () => {
    const { root, manifestPath } = project({ semantic: false });
    const preview = previewDbtMetricPatch(root, manifestPath, {
      ...average,
      modelUniqueId: 'model.harbor.claims',
      primaryEntity: { name: 'claim', column: 'claim_id' },
      timeDimension: { name: 'reported_date', column: 'reported_date' },
    });
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]).toMatchObject({ path: 'models/claims/claims_semantic.yml', before: '', changed: true });
    const after = yaml.load(preview.patches[0]!.after) as { semantic_models: Array<Record<string, any>>; metrics: unknown[] };
    expect(after.semantic_models[0]).toMatchObject({
      name: 'claims',
      model: "ref('claims')",
      defaults: { agg_time_dimension: 'reported_date' },
      entities: [{ name: 'claim', type: 'primary', expr: 'claim_id' }],
    });
    expect(after.semantic_models[0]!.dimensions.map((dimension: { name: string }) => dimension.name)).toEqual(['reported_date', 'product']);
    expect(after.metrics).toHaveLength(1);
  });

  it('edits an existing metric in place and keeps its other fields', () => {
    const { root, manifestPath } = project();
    const applied = applyDbtMetricPatch(root, manifestPath, average, previewDbtMetricPatch(root, manifestPath, average).fingerprint);
    expect(applied.patches[0]!.changed).toBe(true);
    const edit: DbtMetricAuthoringInput = { ...average, mode: 'edit', dimensions: [], metric: { ...average.metric, description: 'Mean claimed amount per claim.', aggregation: 'max' } };
    const preview = previewDbtMetricPatch(root, manifestPath, edit);
    const after = yaml.load(preview.patches[0]!.after) as { semantic_models: Array<Record<string, any>>; metrics: Array<Record<string, any>> };
    const measures = after.semantic_models[0]!.measures.filter((measure: { name: string }) => measure.name === 'average_claimed_amount');
    expect(measures).toEqual([{ name: 'average_claimed_amount', description: 'Mean claimed amount per claim.', agg: 'max', expr: 'claimed_amount' }]);
    expect(after.metrics.filter((metric) => metric.name === 'average_claimed_amount')).toHaveLength(1);
  });

  describe('refuses with a clear message', () => {
    it('a duplicate metric name', () => {
      const { root, manifestPath } = project();
      expect(message(() => previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, name: 'claimed_amount' } })))
        .toMatch(/A metric named "claimed_amount" already exists in models\/claims\/claims_semantic\.yml/);
    });

    it('a duplicate metric name that only the dbt manifest knows', () => {
      const { root, manifestPath } = project();
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.metrics = { 'metric.harbor.average_claimed_amount': { name: 'average_claimed_amount' } };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(message(() => previewDbtMetricPatch(root, manifestPath, average))).toMatch(/already exists in the dbt manifest/);
    });

    it('an unsupported aggregation, naming the supported ones', () => {
      const { root, manifestPath } = project();
      const text = message(() => previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, aggregation: 'median' } }));
      expect(text).toMatch(/Unsupported aggregation "median"/);
      expect(text).toContain('sum, count, count_distinct, average, min, max');
    });

    it('an unknown column, listing the columns the model has', () => {
      const { root, manifestPath } = project();
      const text = message(() => previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, column: 'claimed_amt' } }));
      expect(text).toMatch(/Unknown column "claimed_amt" for the metric on dbt model "claims"/);
      expect(text).toContain('claimed_amount');
    });

    it('an unknown dimension column, and reports every problem at once', () => {
      const { root, manifestPath } = project();
      try {
        previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, column: 'nope' }, dimensions: [{ name: 'tier', column: 'tier' }] });
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('DBT_METRIC_INVALID');
        expect((error as { issues: string[] }).issues).toHaveLength(2);
      }
    });

    it('a bad metric name and a column that is an expression', () => {
      const { root, manifestPath } = project();
      const text = message(() => previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, name: 'Average Claim', column: 'claimed_amount * 2' } }));
      expect(text).toMatch(/Metric name "Average Claim" must be lowercase/);
      expect(text).toMatch(/expressions are not supported/);
    });

    it('a dimension that already exists on another column', () => {
      const { root, manifestPath } = project();
      expect(message(() => previewDbtMetricPatch(root, manifestPath, { ...average, dimensions: [{ name: 'region', column: 'status' }] })))
        .toMatch(/Dimension "region" already exists on "claims" with column "region"/);
    });

    it('a new semantic model without its entity and time column', () => {
      const { root, manifestPath } = project({ semantic: false });
      const text = message(() => previewDbtMetricPatch(root, manifestPath, { ...average, modelUniqueId: 'model.harbor.claims' }));
      expect(text).toMatch(/needs a primary entity/);
      expect(text).toMatch(/needs a time column/);
    });

    it('an edit of a metric that does not exist', () => {
      const { root, manifestPath } = project();
      expect(message(() => previewDbtMetricPatch(root, manifestPath, { ...average, mode: 'edit' }))).toMatch(/no metric named "average_claimed_amount"/);
    });
  });

  it('cannot check columns without documentation, and says so instead of guessing', () => {
    const { root, manifestPath } = project({ columns: [] });
    const preview = previewDbtMetricPatch(root, manifestPath, { ...average, metric: { ...average.metric, column: 'anything' }, dimensions: [] });
    expect(preview.warnings.join(' ')).toMatch(/not documented in the manifest, so column names were not checked/);
  });
});

describe('applyDbtMetricPatch', () => {
  it('writes the reviewed patch and refuses a changed source', () => {
    const { root, manifestPath } = project();
    const file = join(root, 'models', 'claims', 'claims_semantic.yml');
    const preview = previewDbtMetricPatch(root, manifestPath, average);
    expect(() => applyDbtMetricPatch(root, manifestPath, average, 'stale')).toThrow(/changed after the preview/);
    expect(() => applyDbtMetricPatch(root, manifestPath, average, '')).toThrow(/changed after the preview/);
    applyDbtMetricPatch(root, manifestPath, average, preview.fingerprint);
    expect(readFileSync(file, 'utf8')).toBe(preview.patches[0]!.after);
    // The same request again is now a duplicate rather than a second write.
    expect(() => applyDbtMetricPatch(root, manifestPath, average, preview.fingerprint)).toThrow(/already exists/);
  });

  it('refuses when the source changed between preview and apply', () => {
    const { root, manifestPath } = project();
    const preview = previewDbtMetricPatch(root, manifestPath, average);
    const file = join(root, 'models', 'claims', 'claims_semantic.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# edited by someone else\n`);
    expect(() => applyDbtMetricPatch(root, manifestPath, average, preview.fingerprint)).toThrow(/changed after the preview/);
  });
});
