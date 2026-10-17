import { describe, it, expect } from 'vitest';
import { LineageGraph } from '@zlens/core';

import { lineageImpact } from '../lineage-impact.js';
import { makeCtx } from './_helpers.js';

describe('lineage-impact tool', () => {
  it('bounds returned graph arrays and reports exact truncation counts', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:focus', type: 'block', name: 'focus', domain: 'sales', status: 'certified' });

    for (let i = 0; i < 100; i += 1) {
      graph.addNode({ id: `dashboard:dash_${i}`, type: 'dashboard', name: `dash_${i}`, domain: 'sales' });
      graph.addEdge({ source: 'block:focus', target: `dashboard:dash_${i}`, type: 'visualizes' });
    }

    const result = lineageImpact(makeCtx({}, { lineageGraph: graph }), {
      focus: 'block:focus',
      downstreamDepth: 1,
      nodeLimit: 5,
      edgeLimit: 4,
    });

    expect(result).toMatchObject({
      nodeCount: 101,
      edgeCount: 100,
      returnedNodeCount: 5,
      returnedEdgeCount: 4,
      truncation: {
        nodeLimit: 5,
        edgeLimit: 4,
        nodesTruncated: true,
        edgesTruncated: true,
        omittedNodeCount: 96,
        omittedEdgeCount: 96,
      },
    });
    expect(result.nodes).toHaveLength(5);
    expect(result.edges).toHaveLength(4);
    expect(result.summary).toMatchObject({
      byType: { block: 1, dashboard: 100 },
      byDomain: { sales: 101 },
    });
  });

  it('caps recert impact arrays while preserving impact summary counts', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:focus', type: 'block', name: 'focus', domain: 'sales', status: 'certified' });

    for (let i = 0; i < 60; i += 1) {
      graph.addNode({
        id: `block:child_${i}`,
        type: 'block',
        name: `child_${i}`,
        domain: 'sales',
        status: 'certified',
      });
      graph.addEdge({ source: 'block:focus', target: `block:child_${i}`, type: 'feeds_into' });
    }

    const result = lineageImpact(makeCtx({}, { lineageGraph: graph }), {
      focus: 'block:focus',
      recert: true,
    });

    expect(result.impactSummary).toMatchObject({
      changedBlockCount: 1,
      semanticChangeCount: 1,
      downstreamCount: 60,
      requiresRecertCount: 60,
      itemLimit: 50,
      truncated: true,
    });
    expect(result.impact).toMatchObject({ hasCertifiedInvalidation: true });
    expect(result.impact?.downstream).toHaveLength(50);
    expect(result.impact?.requiresRecert).toHaveLength(50);
  });

  it('finds a warehouse table by its bare name and lists candidates when a name is ambiguous', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:dev.orders', type: 'source_table', name: 'dev.orders' } as never);
    graph.addNode({ id: 'block:store_revenue', type: 'block', name: 'store_revenue' });
    graph.addEdge({ source: 'table:dev.orders', target: 'block:store_revenue', type: 'feeds_into' } as never);
    const found = lineageImpact(makeCtx({}, { lineageGraph: graph }), { focus: 'orders' }) as { focalNode?: { id: string } };
    expect(found.focalNode?.id).toBe('table:dev.orders');

    graph.addNode({ id: 'table:raw.orders', type: 'source_table', name: 'raw.orders' } as never);
    expect(lineageImpact(makeCtx({}, { lineageGraph: graph }), { focus: 'orders' })).toEqual({
      error: 'No node matches "orders". It could be: table:dev.orders, table:raw.orders. Pass one of these ids as focus.',
    });
  });
});
