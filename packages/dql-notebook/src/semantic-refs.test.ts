import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import { hasStandaloneSemanticRef, resolveSemanticRefs } from './semantic-refs.js';

describe('standalone semantic references', () => {
  const semanticLayer = new SemanticLayer({
    metrics: [{
      name: 'revenue',
      label: 'Revenue',
      description: '',
      domain: 'commerce',
      sql: 'revenue',
      type: 'custom',
      table: '',
      metricType: 'simple',
      typeParams: { measure: { name: 'revenue' } },
    }, {
      name: 'revenue_ratio',
      label: 'Revenue ratio',
      description: '',
      domain: 'commerce',
      sql: 'revenue_ratio',
      type: 'custom',
      table: '',
      metricType: 'ratio',
    }],
    dimensions: [{
      name: 'product_name',
      label: 'Product name',
      description: '',
      domain: 'commerce',
      sql: 'product_name',
      type: 'string',
      table: 'products',
    }],
    measures: [{
      name: 'revenue',
      label: 'Revenue',
      description: '',
      domain: 'commerce',
      agg: 'sum',
      expr: 'product_price',
      table: 'order_items',
    }],
  });

  it('compiles a dropped dimension into a bounded query using the live table mapping', () => {
    const result = resolveSemanticRefs('@dim(product_name)', semanticLayer, {
      tableMapping: { products: 'analytics.products' },
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.resolvedDimensions).toEqual(['product_name']);
    expect(result.resolvedSql).toContain('SELECT DISTINCT product_name AS product_name');
    expect(result.resolvedSql).toContain('FROM analytics.products AS products');
    expect(result.resolvedSql).toContain('LIMIT 200');
  });

  it('compiles a dbt simple metric through its input measure and qualified table', () => {
    const result = resolveSemanticRefs('@metric(revenue);', semanticLayer, {
      tableMapping: { order_items: 'analytics.order_items' },
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.resolvedMetrics).toEqual(['revenue']);
    expect(result.resolvedSql).toContain('SUM(product_price) AS revenue');
    expect(result.resolvedSql).toContain('FROM analytics.order_items');
  });

  it('delegates complex dbt metrics instead of compiling an inaccurate SQL expression', () => {
    const result = resolveSemanticRefs('@metric(revenue_ratio)', semanticLayer);

    expect(result.unresolvedRefs).toEqual([
      'metric:revenue_ratio (requires a full semantic query or MetricFlow)',
    ]);
  });

  it('keeps semantic references inside full SQL on the expression-resolution path', () => {
    const result = resolveSemanticRefs(
      'SELECT @dim(product_name) FROM products GROUP BY @dim(product_name)',
      semanticLayer,
      { tableMapping: { products: 'analytics.products' } },
    );

    expect(result.resolvedSql).toBe(
      'SELECT product_name AS product_name FROM products GROUP BY product_name',
    );
  });

  it('only identifies a reference as standalone when it is the entire cell', () => {
    expect(hasStandaloneSemanticRef('  @dimension(product_name); ')).toBe(true);
    expect(hasStandaloneSemanticRef('SELECT @dim(product_name)')).toBe(false);
  });
});
