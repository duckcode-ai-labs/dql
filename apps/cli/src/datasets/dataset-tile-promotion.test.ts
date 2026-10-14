import { describe, expect, it } from 'vitest';
import { parse } from '@zlens/core';
import { buildExecutionPlan } from '@zlens/notebook';
import { planDatasetTilePromotion, type DatasetTilePromotionInput } from './dataset-tile-promotion.js';

function input(overrides: Partial<DatasetTilePromotionInput> = {}): DatasetTilePromotionInput {
  return {
    appId: 'sales', pageId: 'overview', tileId: 'rev_by_region', name: 'Revenue by region', domain: 'commerce',
    datasetId: 'app:block:commerce:order-lines', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
    query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], filters: [{ field: 'region', op: 'in', values: ['EU', "O'Brien"] }] },
    queryFingerprint: 'sha256:q', filterFingerprint: 'sha256:f', parameterFingerprint: 'sha256:p', interactionFingerprint: 'sha256:i',
    snapshotFingerprint: 'snapshot', targetFingerprint: 'target', personaPolicyFingerprint: 'persona', receiptId: 'run-1',
    sql: [
      'WITH ds AS (SELECT * FROM order_lines WHERE status = $1)',
      'SELECT ds."region" AS "region", SUM(ds."net_amount") AS "revenue"',
      'FROM ds',
      "WHERE ds.\"region\" IN ($2, $3) AND ds.\"region\" <> '$9 literal'",
      'GROUP BY ds."region"',
      'HAVING SUM(ds."net_amount") > $4 -- $2 in a comment',
    ].join('\n'),
    schemaFingerprint: 'sha256:schema', resultFingerprint: 'sha256:result', complete: true, futureBindingsRepresentable: true,
    boundParameters: [
      { position: 1, name: 'status', value: 'complete' },
      { position: 2, name: '__dataset_tile_region_2', value: 'EU' },
      { position: 3, name: '__dataset_tile_region_3', value: "O'Brien \"the\" \\ one" },
      { position: 4, name: '__dataset_tile_revenue_4', value: 1000.5 },
    ],
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    ...overrides,
  };
}

describe('saving a dataset tile as a review block', () => {
  it('declares every bound value as a typed params default so the block runs on its own', () => {
    const plan = planDatasetTilePromotion(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.source).toContain('  params {');
    expect(plan.source).toContain('    status: string = "complete"');
    expect(plan.source).toContain('    tile_param_2: string = "EU"');
    expect(plan.source).toContain('    tile_param_4: number = 1000.5');
    // Placeholders become named references; quoted text and comments are untouched.
    expect(plan.source).toContain('WITH ds AS (SELECT * FROM order_lines WHERE status = ${status})');
    expect(plan.source).toContain("IN (${tile_param_2}, ${tile_param_3}) AND ds.\"region\" <> '$9 literal'");
    expect(plan.source).toContain('> ${tile_param_4} -- $2 in a comment');
    const executable = plan.source.replace("'$9 literal'", '').replace('-- $2 in a comment', '');
    expect(executable).not.toMatch(/\$[0-9]/);

    // The saved block compiles back to the same positional statement with
    // the same values, which is what makes the replacement proof meaningful.
    const block = buildExecutionPlan({ id: 'saved', type: 'dql', source: plan.source, title: 'Saved' }, { driver: 'duckdb' });
    expect(block).toBeTruthy();
    const values = block!.sqlParams.map((parameter) => block!.variables[parameter.name]);
    expect(values).toEqual(['complete', 'EU', "O'Brien \"the\" \\ one", 1000.5]);
    expect(parse(plan.source).statements).toHaveLength(1);
  });

  it('refuses instead of writing a block that cannot run or would run differently', () => {
    const missing = planDatasetTilePromotion(input({ boundParameters: input().boundParameters.slice(0, 3) }));
    expect(missing).toMatchObject({ ok: false, code: 'dataset_tile_dynamic_binding_not_representable' });

    const arrayValue = planDatasetTilePromotion(input({
      boundParameters: input().boundParameters.map((parameter) => (parameter.position === 2 ? { ...parameter, value: ['EU', 'US'] } : parameter)),
    }));
    expect(arrayValue).toMatchObject({ ok: false, code: 'dataset_tile_dynamic_binding_not_representable' });

    const anonymous = planDatasetTilePromotion(input({ sql: 'SELECT * FROM order_lines WHERE region = ?', boundParameters: [] }));
    expect(anonymous).toMatchObject({ ok: false, code: 'dataset_tile_dynamic_binding_not_representable' });
  });

  it('writes no params section for a tile with no bound values', () => {
    const plan = planDatasetTilePromotion(input({ sql: 'SELECT region, SUM(net_amount) AS revenue FROM order_lines GROUP BY region', boundParameters: [] }));
    expect(plan.ok && plan.source.includes('params {')).toBe(false);
  });
});
