import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import { buildExecutionPlan } from './execute.js';

describe('buildExecutionPlan', () => {
  it('extracts SQL, params, and visualization from a DQL block', () => {
    const plan = buildExecutionPlan({
      id: 'cell-1',
      type: 'dql',
      title: 'Revenue',
      source: `block "Revenue" {\n  domain = "finance"\n  type = "custom"\n  params {\n    period = "current_quarter"\n  }\n  query = """SELECT segment, SUM(amount) AS revenue FROM revenue WHERE fiscal_period = ${'${period}'} GROUP BY segment"""\n  visualization {\n    chart = "bar"\n    x = segment\n    y = revenue\n  }\n  tests {\n    assert row_count > 0\n  }\n}`,
    });

    expect(plan?.sql).toContain('$1');
    expect(plan?.variables).toEqual({ period: 'current_quarter' });
    expect(plan?.chartConfig).toEqual({ chart: 'bar', x: 'segment', y: 'revenue' });
    expect(plan?.tests).toHaveLength(1);
  });

  it('passes SQL cells through unchanged', () => {
    const plan = buildExecutionPlan({ id: 'cell-2', type: 'sql', title: 'Ad hoc', source: 'SELECT 1 AS ok' });
    expect(plan?.sql).toBe('SELECT 1 AS ok');
    expect(plan?.sqlParams).toEqual([]);
  });

  it('builds an executable query for a standalone semantic dimension cell', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [],
      dimensions: [{
        name: 'product_name', label: 'Product name', description: '', domain: 'commerce',
        sql: 'product_name', type: 'string', table: 'products',
      }],
    });

    const plan = buildExecutionPlan({
      id: 'cell-semantic-dimension',
      type: 'sql',
      title: 'Product name',
      source: '@dim(product_name)',
    }, {
      semanticLayer,
      tableMapping: { products: 'analytics.products' },
    });

    expect(plan?.sql).toContain('FROM analytics.products AS products');
    expect(plan?.sql).toContain('SELECT DISTINCT product_name AS product_name');
  });

  it('applies semantic table mapping when composing semantic block SQL', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'revenue',
        label: 'Revenue',
        description: '',
        domain: 'revenue',
        sql: 'product_price',
        type: 'sum',
        table: 'order_items',
      }],
      dimensions: [{
        name: 'item_food_flag',
        label: 'Item food flag',
        description: '',
        domain: 'revenue',
        sql: 'is_food_item',
        type: 'boolean',
        table: 'order_items',
      }],
    });

    const plan = buildExecutionPlan({
      id: 'cell-3',
      type: 'dql',
      title: 'Semantic revenue',
      source: `block "Semantic Revenue" {
  domain = "semantic"
  type = "semantic"
  status = "draft"
  metric = "revenue"
  dimensions = ["item_food_flag"]
}`,
    }, {
      semanticLayer,
      driver: 'duckdb',
      tableMapping: { order_items: 'dev.order_items' },
    });

    expect(plan?.sql).toContain('FROM dev.order_items');
    expect(plan?.sql).toContain('SUM(product_price) AS revenue');
    expect(plan?.sql).toContain('is_food_item AS item_food_flag');
  });

  it('applies typed semantic filter and limit parameters to composed SQL', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'revenue', label: 'Revenue', description: '', domain: 'revenue',
        sql: 'product_price', type: 'sum', table: 'order_items',
      }],
      dimensions: [{
        name: 'item_category', label: 'Item category', description: '', domain: 'revenue',
        sql: 'product_category', type: 'string', table: 'order_items',
      }],
    });

    const plan = buildExecutionPlan({
      id: 'cell-4',
      type: 'dql',
      title: 'Revenue by category',
      source: `block "Revenue by category" {
  domain = "revenue"
  type = "semantic"
  metric = "revenue"
  dimensions = ["item_category"]
  params {
    category: string
    top_n: number = 10
  }
  parameterPolicy {
    category = "dynamic"
    top_n = "dynamic"
  }
  filterBindings {
    category = "item_category"
    top_n = "limit"
  }
}`,
    }, {
      semanticLayer,
      driver: 'duckdb',
      parameters: { category: 'Beverage', top_n: 5 },
    });

    expect(plan?.sql).toContain("product_category = 'Beverage'");
    expect(plan?.sql).toContain('LIMIT 5');
  });
});

describe('semantic block compose failures (honest reasons)', () => {
  const semanticBlockSource = (metric: string) => [
    `block "Daily" {`,
    `  domain = "usage"`,
    `  type = "semantic"`,
    `  metric = "${metric}"`,
    `  query = """@metric(${metric})"""`,
    `}`,
  ].join('\n');

  it('names a MetricFlow-only metric as the cause instead of blaming definitions', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'previous_day_bcm', label: 'Previous Day BCM', description: '', domain: 'usage',
        sql: 'previous_day_bcm', type: 'custom', table: '', metricType: 'derived',
        typeParams: { metrics: [{ name: 'bcm' }] },
      }],
      dimensions: [],
    });

    expect(() => buildExecutionPlan({
      id: 'cell-derived',
      type: 'dql',
      title: 'Previous Day BCM',
      source: semanticBlockSource('previous_day_bcm'),
    }, { semanticLayer })).toThrow(/derived metric ZLens cannot compose natively.*MetricFlow/);
  });

  it('API-006/E2E-008 accepts authoritative SQL from the selected semantic runtime', () => {
    const semanticLayer = new SemanticLayer({
      metrics: [{
        name: 'previous_day_bcm', label: 'Previous Day BCM', description: '', domain: 'usage',
        sql: 'previous_day_bcm', type: 'custom', table: '', metricType: 'derived',
        typeParams: { metrics: [{ name: 'bcm' }] },
      }],
      dimensions: [],
    });

    const plan = buildExecutionPlan({
      id: 'cell-derived-runtime',
      type: 'dql',
      title: 'Previous Day BCM',
      source: semanticBlockSource('previous_day_bcm'),
    }, {
      semanticLayer,
      semanticSql: 'SELECT previous_day_bcm FROM metricflow_compiled',
    });

    expect(plan?.sql).toBe('SELECT previous_day_bcm FROM metricflow_compiled');
  });

  it('says the metric is undefined when it really is missing', () => {
    const semanticLayer = new SemanticLayer({ metrics: [], dimensions: [] });
    expect(() => buildExecutionPlan({
      id: 'cell-missing',
      type: 'dql',
      title: 'Missing',
      source: semanticBlockSource('nonexistent_metric'),
    }, { semanticLayer })).toThrow(/not defined in the semantic layer/);
  });
});
