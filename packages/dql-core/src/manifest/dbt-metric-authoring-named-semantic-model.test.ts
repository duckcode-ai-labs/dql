import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyDbtMetricPatch, previewDbtMetricPatch, type DbtMetricAuthoringInput } from './dbt-metric-authoring.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('uses the existing semantic model of a dbt model even when the names differ', () => {
  const root = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-named-'));
  roots.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  writeFileSync(join(root, 'models', 'fct_orders.sql'), 'select 1');
  const file = join(root, 'models', 'orders_semantic.yml');
  writeFileSync(file, [
    'semantic_models:',
    '  - name: orders',
    "    model: ref('fct_orders')",
    '    defaults:',
    '      agg_time_dimension: ordered_at',
    '    entities:',
    '      - name: order',
    '        type: primary',
    '        expr: order_id',
    '    dimensions:',
    '      - name: ordered_at',
    '        type: time',
    '        expr: ordered_at',
    '        type_params:',
    '          time_granularity: day',
    '    measures: []',
    '',
  ].join('\n'));
  const manifestPath = join(root, 'target', 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    nodes: { 'model.harbor.fct_orders': { unique_id: 'model.harbor.fct_orders', resource_type: 'model', name: 'fct_orders', original_file_path: 'models/fct_orders.sql', columns: { order_id: { name: 'order_id' }, ordered_at: { name: 'ordered_at' }, amount: { name: 'amount' } } } },
    sources: {}, metrics: {}, semantic_models: {}, child_map: {},
  }));
  // The UI defaults the semantic model to the dbt model's name and sends the entity and time fields it was given.
  const input: DbtMetricAuthoringInput = {
    mode: 'add',
    semanticModel: 'fct_orders',
    modelUniqueId: 'model.harbor.fct_orders',
    primaryEntity: { name: 'order', column: 'order_id' },
    timeDimension: { name: 'ordered_at', column: 'ordered_at' },
    metric: { name: 'average_amount', aggregation: 'average', column: 'amount' },
  };
  const preview = previewDbtMetricPatch(root, manifestPath, input);
  expect(preview.semanticModel).toBe('orders');
  expect(preview.patches.map((patch) => patch.path)).toEqual(['models/orders_semantic.yml']);
  expect(preview.warnings.join(' ')).toMatch(/already has the semantic model "orders"/);
  applyDbtMetricPatch(root, manifestPath, input, preview.fingerprint);
  const written = readFileSync(file, 'utf8');
  expect(written.match(/^\s*- name: orders$/gm)).toHaveLength(1);
  expect(written).toContain('average_amount');
});
