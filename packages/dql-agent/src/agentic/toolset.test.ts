import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import type { KGStore } from '../kg/sqlite-fts.js';
import { buildSemanticStageTools } from './toolset.js';

describe('search_semantic_layer composition contract', () => {
  it('returns business-metric provenance and only dimensions compatible with the matched metric', async () => {
    const layer = new SemanticLayer({
      metrics: [{
        name: 'total_revenue',
        label: 'Total revenue',
        description: 'Recognized order revenue.',
        domain: 'finance',
        sql: 'amount',
        type: 'sum',
        table: 'orders',
        cube: 'orders',
        semanticModelIds: ['orders'],
      }],
      dimensions: [
        {
          name: 'channel',
          label: 'Channel',
          description: 'Order channel.',
          sql: 'channel',
          type: 'string',
          table: 'orders',
          cube: 'orders',
        },
        {
          name: 'region',
          label: 'Region',
          description: 'Campaign region.',
          sql: 'region',
          type: 'string',
          table: 'campaigns',
          cube: 'campaigns',
        },
      ],
    });
    const search = buildSemanticStageTools({
      semanticLayer: layer,
      kg: {} as KGStore,
    }).find((tool) => tool.name === 'search_semantic_layer');

    const result = await search?.run({ query: 'revenue by channel and region' }) as {
      metrics: Array<{ name: string; semanticModelIds?: string[]; compatibleDimensions?: string[] }>;
      dimensions: Array<{ name: string; semanticModelId?: string }>;
    };

    expect(result.metrics).toEqual([
      expect.objectContaining({
        name: 'total_revenue',
        semanticModelIds: ['orders'],
        compatibleDimensions: ['orders.channel'],
      }),
    ]);
    expect(result.dimensions).toEqual([
      expect.objectContaining({ name: 'orders.channel', semanticModelId: 'orders' }),
    ]);
  });
});

describe('check_compatibility', () => {
  const layer = new SemanticLayer({
    metrics: [
      { name: 'revenue', label: 'Revenue', description: '', domain: 'orders', sql: 'SUM(amount)', type: 'sum', table: 'orders' },
      { name: 'headcount', label: 'Headcount', description: '', domain: 'hr', sql: 'COUNT(*)', type: 'count', table: 'employees' },
    ],
    dimensions: [
      { name: 'order_status', label: 'Order status', description: '', domain: 'orders', sql: 'status', type: 'string', table: 'orders' },
      { name: 'department', label: 'Department', description: '', domain: 'hr', sql: 'dept', type: 'string', table: 'employees' },
    ],
  });
  const tool = () => buildSemanticStageTools({ semanticLayer: layer, kg: undefined as never })
    .find((entry) => entry.name === 'check_compatibility')!;

  it('is exposed alongside the other governed semantic tools', () => {
    expect(tool()).toBeDefined();
  });

  it('reports what a metric CAN be sliced by', async () => {
    const result = await tool().run({ metrics: ['revenue'] }) as Record<string, unknown>;
    expect(result.metrics).toEqual(['revenue']);
    expect(Array.isArray(result.compatibleDimensions)).toBe(true);
  });

  it('answers about the dimension actually asked about, with a typed reason', async () => {
    // The whole point: a modeling gap becomes a fact the agent can route around
    // instead of a terminal "nothing was executed" refusal.
    const result = await tool().run({ metrics: ['revenue'], dimensions: ['department'] }) as {
      requested: Array<{ dimension: string; compatible: boolean; reason?: string; explanation?: string }>;
    };
    const verdict = result.requested.find((entry) => entry.dimension === 'department')!;
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toBeDefined();
    expect(verdict.explanation).toMatch(/join path|not modeled|cannot/i);
  });

  it('names the one-to-many step when the only path to a dimension fans out', async () => {
    // order_items holds the foreign `order_id` and `product` entities, so orders
    // reach products only by walking order_items backwards: one order, many items.
    const shop = new SemanticLayer({
      metrics: [{ name: 'order_total', label: 'Order total', description: '', domain: 'shop', sql: 'SUM(order_total)', type: 'sum', table: 'orders', cube: 'orders' }],
      dimensions: [],
    });
    const cube = (name: string, joins: Array<{ right: string; entity: string }>, dimensions: string[]) => ({
      name, label: name, description: '', sql: name, table: name, domain: 'shop',
      measures: [], timeDimensions: [], segments: [], preAggregations: [],
      dimensions: dimensions.map((dimension) => ({ name: dimension, label: dimension, description: '', sql: dimension, type: 'string' as const, table: name, cube: name })),
      joins: joins.map(({ right, entity }) => ({ name: `${name}_to_${right}`, left: name, right, type: 'left' as const, sql: `\${left}.${entity}_id = \${right}.${entity}_id`, entity })),
    });
    shop.addCube(cube('orders', [], ['order_status']));
    shop.addCube(cube('order_items', [{ right: 'orders', entity: 'order' }, { right: 'products', entity: 'product' }], []));
    shop.addCube(cube('products', [], ['product_name']));
    const check = buildSemanticStageTools({ semanticLayer: shop, kg: undefined as never })
      .find((entry) => entry.name === 'check_compatibility')!;

    const result = await check.run({ metrics: ['order_total'], dimensions: ['product_name'] }) as {
      requested: Array<{ dimension: string; compatible: boolean; reason?: string; explanation?: string }>;
      compatibleDimensions: Array<{ name: string }>;
    };
    expect(result.requested[0]).toMatchObject({ dimension: 'product_name', compatible: false, reason: 'one_to_many_only' });
    expect(result.requested[0].explanation).toContain('orders → order_items');
    expect(result.compatibleDimensions.map((dimension) => dimension.name)).not.toContain('product_name');
  });

  it('refuses an empty metric list with an actionable message, not a crash', async () => {
    const result = await tool().run({ metrics: [] }) as { error?: string };
    expect(result.error).toMatch(/at least one governed metric/i);
  });
});

describe('explain_metric', () => {
  const layer = new SemanticLayer({
    metrics: [
      { name: 'booked_revenue', label: 'Booked revenue', description: 'Revenue at contract signature.',
        domain: 'finance', sql: 'SUM(amount)', type: 'sum', table: 'orders', owner: 'fin@example.com',
        filters: { stage: "= 'booked'" } },
      { name: 'billed_revenue', label: 'Billed revenue', description: 'Revenue at invoice.',
        domain: 'finance', sql: 'SUM(amount)', type: 'sum', table: 'invoices' },
    ],
    dimensions: [],
  });
  const tool = () => buildSemanticStageTools({ semanticLayer: layer, kg: undefined as never })
    .find((entry) => entry.name === 'explain_metric')!;

  it('is exposed with the other governed semantic tools', () => {
    expect(tool()).toBeDefined();
  });

  it('reads a definition without running anything', async () => {
    const result = await tool().run({ metric: 'booked_revenue' }) as Record<string, unknown>;
    expect(result).toMatchObject({
      found: true, name: 'booked_revenue', expression: 'SUM(amount)',
      table: 'orders', owner: 'fin@example.com',
    });
  });

  it('surfaces the definition filter that makes two similar metrics disagree', async () => {
    // booked vs billed revenue share an expression; the filter is the difference,
    // and it is the whole reason the numbers differ.
    const booked = await tool().run({ metric: 'booked_revenue' }) as Record<string, unknown>;
    expect(booked.definitionFilters).toEqual({ stage: "= 'booked'" });
  });

  it('matches on the leaf so a qualified name resolves', async () => {
    expect(await tool().run({ metric: 'finance.billed_revenue' })).toMatchObject({ name: 'billed_revenue' });
  });

  it('names near misses instead of only failing', async () => {
    // A wrong metric name is usually a near miss, and the alternatives ARE the
    // correction the loop needs.
    const result = await tool().run({ metric: 'revenue' }) as { found: boolean; didYouMean?: string[] };
    expect(result.found).toBe(false);
    expect(result.didYouMean).toEqual(expect.arrayContaining(['booked_revenue', 'billed_revenue']));
  });

  it('refuses an empty request with a message', async () => {
    expect(await tool().run({ metric: '  ' })).toMatchObject({ error: expect.stringMatching(/governed metric name/i) });
  });
});
