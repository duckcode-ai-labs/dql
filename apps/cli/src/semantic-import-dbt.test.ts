/**
 * `zlens semantic import dbt`: dbt Labs' insurance semantic layer in miniature.
 * Two semantic models declare the same entity, a metric is scoped by a
 * dimension on another model, and a derived metric adds two metrics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticLayerFromDir } from '@zlens/core';
import { performSemanticImport } from './semantic-import.js';

const relation = (name: string) => ({ alias: name, schema_name: 'main', database: 'acme', relation_name: `"acme"."main"."${name}"` });
const measure = (name: string, agg: string, expr: string) => ({ name, agg, expr, description: null, create_metric: false, agg_params: null, non_additive_dimension: null, agg_time_dimension: null, label: null, metadata: null, config: { meta: {} } });
const simpleMeasureInput = (name: string) => ({ name, filter: null, alias: null, join_to_timespine: false, fill_nulls_with: null });

const SEMANTIC_MANIFEST = {
  semantic_models: [
    {
      name: 'claim_amount', description: null, node_relation: relation('claim_amount'), defaults: null, primary_entity: null, label: null, metadata: null, config: { meta: {} },
      entities: [{ name: 'claim_amount', type: 'primary', expr: 'claim_amount_identifier', description: null, role: null, metadata: null, label: null }],
      dimensions: [{ name: 'amount_type_code', type: 'categorical', expr: null, description: null, is_partition: false, type_params: null, metadata: null, label: null }],
      measures: [measure('total_claim_amount', 'sum', 'claim_amount')],
    },
    {
      name: 'loss_payment', description: null, node_relation: relation('loss_payment'), defaults: null, primary_entity: null, label: null, metadata: null, config: { meta: {} },
      entities: [{ name: 'claim_amount', type: 'primary', expr: 'claim_amount_identifier', description: null, role: null, metadata: null, label: null }],
      dimensions: [{ name: 'has_loss_payment', type: 'categorical', expr: '1', description: null, is_partition: false, type_params: null, metadata: null, label: null }],
      measures: [],
    },
  ],
  metrics: [
    { name: 'total_claim_amount', type: 'simple', label: 'Total claim amount', description: '', filter: null, metadata: null, config: { meta: {} }, time_granularity: null, type_params: { measure: simpleMeasureInput('total_claim_amount'), input_measures: [simpleMeasureInput('total_claim_amount')], metrics: [], numerator: null, denominator: null, expr: null, window: null, grain_to_date: null, conversion_type_params: null, cumulative_type_params: null } },
    { name: 'loss_payment_amount', type: 'simple', label: 'Loss payment amount', description: '', filter: { where_filters: [{ where_sql_template: "{{Dimension('claim_amount__has_loss_payment')}} = 1\n" }] }, metadata: null, config: { meta: {} }, time_granularity: null, type_params: { measure: simpleMeasureInput('total_claim_amount'), input_measures: [simpleMeasureInput('total_claim_amount')], metrics: [], numerator: null, denominator: null, expr: null, window: null, grain_to_date: null, conversion_type_params: null, cumulative_type_params: null } },
    { name: 'total_loss_amount', type: 'derived', label: 'Loss amount', description: 'loss payments plus loss reserves', filter: null, metadata: null, config: { meta: {} }, time_granularity: null, type_params: { measure: null, input_measures: [simpleMeasureInput('total_claim_amount')], metrics: [{ name: 'loss_payment_amount', filter: null, alias: null, offset_window: null, offset_to_grain: null }], numerator: null, denominator: null, expr: 'loss_payment_amount', window: null, grain_to_date: null, conversion_type_params: null, cumulative_type_params: null } },
  ],
  saved_queries: [],
  project_configuration: { time_spine_table_configurations: [], metadata: null, dsi_package_version: {}, time_spines: [] },
};

describe('importing a dbt semantic layer into native DQL YAML', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('keeps entities declared by several models, keeps metric filters and inputs, and never widens a filtered metric', async () => {
    const dbtRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-semantic-'));
    const target = mkdtempSync(join(tmpdir(), 'dql-native-semantic-'));
    roots.push(dbtRoot, target);
    writeFileSync(join(dbtRoot, 'dbt_project.yml'), 'name: acme\nversion: "1.0"\nprofile: acme\n');
    mkdirSync(join(dbtRoot, 'target'), { recursive: true });
    writeFileSync(join(dbtRoot, 'target', 'semantic_manifest.json'), JSON.stringify(SEMANTIC_MANIFEST));
    writeFileSync(join(dbtRoot, 'target', 'manifest.json'), JSON.stringify({ metadata: { project_name: 'acme' }, nodes: {}, sources: {} }));
    writeFileSync(join(target, 'dql.config.json'), JSON.stringify({ project: 'acme', semanticLayer: { provider: 'dql' } }));

    const result = await performSemanticImport({ targetProjectRoot: target, provider: 'dbt', sourceConfig: { provider: 'dbt', projectPath: dbtRoot } });
    // Both declarations of `claim_amount` are kept, one file per model.
    expect(result.counts.entity).toBe(2);
    const entityFiles = readdirSync(join(target, 'semantic-layer', 'entitys'), { recursive: true }).map(String).filter((file) => file.endsWith('.yaml'));
    expect(entityFiles).toHaveLength(2);

    const metricFile = (name: string) => {
      const dir = join(target, 'semantic-layer', 'metrics');
      const file = readdirSync(dir, { recursive: true }).map(String).find((path) => path.endsWith(`${name}.yaml`));
      return readFileSync(join(dir, file!), 'utf-8');
    };
    expect(metricFile('loss_payment_amount')).toContain("{{Dimension('claim_amount__has_loss_payment')}} = 1");
    expect(metricFile('total_loss_amount')).toContain('typeParams:');
    expect(metricFile('loss_payment_amount')).not.toContain('[object Object]');

    const layer = loadSemanticLayerFromDir(join(target, 'semantic-layer'));
    expect(layer.composeQuery({ metrics: ['total_claim_amount'], dimensions: [], driver: 'duckdb' })?.sql).toContain('SUM(claim_amount)');
    // The filter lives on loss_payment, which the metric's query does not
    // join: refusing is right; summing every claim amount would be wrong.
    expect(layer.composeQuery({ metrics: ['loss_payment_amount'], dimensions: [], driver: 'duckdb' })).toBeNull();
  });
});
