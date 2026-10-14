import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SemanticLayer, type DQLManifest } from '@zlens/core';
import { buildMetadataSnapshot } from '../metadata/catalog.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('native semantic Dataset catalog projection', () => {
  it('groups exact certified native metrics by model and keeps a review metric out of that source', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-native-semantic-dataset-'));
    roots.push(projectRoot);
    const layer = nativeOrderLinesLayer();
    const snapshot = buildMetadataSnapshot(projectRoot, minimalManifest(projectRoot), layer, []);
    const sources = snapshot.objects.filter((object) =>
      object.objectType === 'dql_block_source' && object.payload?.kind === 'semantic',
    );
    const certified = sources.find((source) => source.status === 'certified');
    const review = sources.find((source) => source.status === 'review');

    expect(certified?.payload).toMatchObject({
      kind: 'semantic',
      lifecycle: 'certified',
      semanticModel: 'order_lines',
      measures: ['semantic_customer_count', 'semantic_revenue'],
      dataset: {
        kind: 'semantic',
        execution: { route: 'semantic', adapterId: 'native' },
        trust: 'certified',
      },
    });
    expect((certified?.payload?.dataset as { fields?: Array<{ name: string; kind: string; additivity?: unknown; format?: unknown }> } | undefined)?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'semantic_revenue', kind: 'measure', additivity: { entities: 'additive', time: 'additive' }, format: { kind: 'currency', currency: 'USD', decimals: 2 } }),
        expect.objectContaining({ name: 'semantic_customer_count', kind: 'measure', additivity: { entities: 'non_additive', time: 'non_additive' } }),
      ]));
    expect(certified?.payload?.metricCapabilities).toEqual(expect.objectContaining({
      semantic_revenue: expect.objectContaining({ metricId: 'semantic:metric:order_lines.semantic_revenue' }),
      semantic_customer_count: expect.objectContaining({ metricId: 'semantic:metric:order_lines.semantic_customer_count' }),
    }));
    expect(review?.payload).toMatchObject({
      lifecycle: 'review',
      trust: 'review_required',
      measures: ['semantic_margin_rate'],
    });
  });
});

function nativeOrderLinesLayer(): SemanticLayer {
  const layer = new SemanticLayer();
  layer.addCube({
    name: 'order_lines', label: 'Order lines', description: '', domain: 'commerce', sql: 'SELECT * FROM order_lines', table: 'order_lines',
    measures: [
      { name: 'semantic_revenue', label: 'Revenue', description: '', sql: 'SUM(net_amount)', type: 'sum', aggregation: 'sum', table: 'order_lines', cube: 'order_lines', domain: 'commerce', aggTimeDimension: 'order_date' },
      { name: 'semantic_customer_count', label: 'Distinct customers', description: '', sql: 'COUNT(DISTINCT customer_id)', type: 'count_distinct', aggregation: 'count_distinct', table: 'order_lines', cube: 'order_lines', domain: 'commerce', aggTimeDimension: 'order_date' },
      { name: 'semantic_margin_amount', label: 'Margin amount', description: '', sql: 'SUM(margin_amount)', type: 'sum', aggregation: 'sum', table: 'order_lines', cube: 'order_lines', domain: 'commerce', aggTimeDimension: 'order_date' },
    ],
    dimensions: [{ name: 'region', label: 'Region', description: '', sql: 'region', type: 'string', table: 'order_lines', cube: 'order_lines', domain: 'commerce', entityLink: 'order_line' }],
    timeDimensions: [{ name: 'order_date', label: 'Order date', description: '', sql: 'order_date', type: 'date', table: 'order_lines', cube: 'order_lines', domain: 'commerce', entityLink: 'order_line', isTimeDimension: true, granularities: ['day', 'month'], primaryTime: true }],
    joins: [], segments: [], preAggregations: [], defaultTimeDimension: 'order_date',
    source: { provider: 'dql', objectType: 'cube', objectId: 'order_lines' },
  });
  layer.addEntity({ name: 'order_line', label: 'Order line', description: '', domain: 'commerce', type: 'primary', expr: 'order_line_id', table: 'order_lines', cube: 'order_lines', source: { provider: 'dql', objectType: 'entity', objectId: 'order_line' } });
  layer.addSemanticModel({ name: 'order_lines', label: 'Order lines', description: '', domain: 'commerce', table: 'order_lines', entities: ['order_line'], measures: ['semantic_revenue', 'semantic_customer_count', 'semantic_margin_amount'], dimensions: ['region'], timeDimensions: ['order_date'], source: { provider: 'dql', objectType: 'semantic_model', objectId: 'order_lines' } });
  layer.addMetric({ name: 'semantic_revenue', label: 'Revenue', description: '', domain: 'commerce', status: 'certified', sql: 'SUM(net_amount)', type: 'sum', aggregation: 'sum', metricType: 'simple', table: 'order_lines', cube: 'order_lines', typeParams: { measure: 'semantic_revenue' }, aggTimeDimension: 'order_date', displayFormat: { kind: 'currency', currency: 'USD', decimals: 2 }, source: { provider: 'dql', objectType: 'metric', objectId: 'order_lines.semantic_revenue' } });
  layer.addMetric({ name: 'semantic_customer_count', label: 'Distinct customers', description: '', domain: 'commerce', status: 'certified', sql: 'COUNT(DISTINCT customer_id)', type: 'count_distinct', aggregation: 'count_distinct', metricType: 'simple', table: 'order_lines', cube: 'order_lines', typeParams: { measure: 'semantic_customer_count' }, aggTimeDimension: 'order_date', source: { provider: 'dql', objectType: 'metric', objectId: 'order_lines.semantic_customer_count' } });
  layer.addMetric({ name: 'semantic_margin_rate', label: 'Margin rate', description: '', domain: 'commerce', status: 'review', sql: '(1.0 * SUM(margin_amount)) / NULLIF(SUM(net_amount), 0)', type: 'custom', aggregation: 'ratio', metricType: 'ratio', table: 'order_lines', cube: 'order_lines', typeParams: { input_measures: ['semantic_margin_amount', 'semantic_revenue'] }, aggTimeDimension: 'order_date', source: { provider: 'dql', objectType: 'metric', objectId: 'order_lines.semantic_margin_rate' } });
  return layer;
}

function minimalManifest(projectRoot: string): DQLManifest {
  return {
    manifestVersion: 3,
    dqlVersion: 'test',
    generatedAt: '2026-09-11T00:00:00.000Z',
    project: 'native-semantic-dataset',
    projectRoot,
    domains: { commerce: { id: 'commerce', name: 'Commerce', filePath: 'domains/commerce/domain.dql' } },
    blocks: {}, businessViews: {}, terms: {}, notebooks: {}, metrics: {}, dimensions: {}, sources: {}, apps: {}, dashboards: {},
    lineage: { nodes: [], edges: [] }, diagnostics: [],
  } as DQLManifest;
}
