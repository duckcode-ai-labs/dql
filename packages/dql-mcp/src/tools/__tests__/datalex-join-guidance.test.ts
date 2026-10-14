import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DataLexContractRegistry } from '@zlens/core';

import { buildDataLexJoinGuidance, queryViaMetadata } from '../query-via-metadata.js';
import { makeCtx } from './_helpers.js';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/enterprise-modeling-foundation.datalex-manifest.json', import.meta.url),
);
const JAFFLE_FIXTURE = fileURLToPath(
  new URL('./fixtures/jaffle-shop.datalex-manifest.json', import.meta.url),
);

type GuidanceRegistry = Parameters<typeof buildDataLexJoinGuidance>[0];

function mockRegistry(overrides: Partial<GuidanceRegistry> = {}): GuidanceRegistry {
  return {
    conformance: () => [],
    relationships: () => [],
    joinPath: () => ({ ok: false, reason: 'no_relationship', message: '' }),
    ...overrides,
  };
}

describe('buildDataLexJoinGuidance (unit)', () => {
  it('returns undefined when no conformance is present (DataLex not adopted / no manifest)', () => {
    expect(buildDataLexJoinGuidance(mockRegistry(), ['dim_customer'])).toBeUndefined();
  });

  it('does NOT gate on isLoaded() — conformance-only (zero-contract) manifests still produce guidance', () => {
    const conformance = [
      {
        concept: 'Customer',
        domain: 'sales',
        canonical_key: ['customer_id'],
        physical: [{ entity: 'DimCustomer', binding: { kind: 'table' as const, ref: 'dim_customer' } }],
      },
    ];
    // Note: no isLoaded() on the mock at all — the helper must not call it.
    const guidance = buildDataLexJoinGuidance(mockRegistry({ conformance: () => conformance }), ['dim_customer']);
    expect(guidance?.entities[0]).toMatchObject({ concept: 'Customer', canonicalKey: ['customer_id'] });
  });

  it('resolves a ref by physical model name, physical entity name, or concept name', () => {
    const conformance = [
      {
        concept: 'Customer',
        domain: 'sales',
        canonical_key: ['customer_id'],
        physical: [{ entity: 'DimCustomer', binding: { kind: 'table' as const, ref: 'dim_customer' } }],
      },
    ];
    const reg = mockRegistry({ conformance: () => conformance });
    for (const ref of ['dim_customer', 'DimCustomer', 'customer']) {
      const guidance = buildDataLexJoinGuidance(reg, [ref]);
      expect(guidance?.entities[0]).toMatchObject({
        concept: 'Customer',
        canonicalKey: ['customer_id'],
        physical: ['dim_customer'],
      });
    }
  });
});

describe('buildDataLexJoinGuidance — real enterprise-modeling-foundation manifest (the aligned demo)', () => {
  const registry = new DataLexContractRegistry({ manifestPath: FIXTURE });

  it('loads conformance + relationships from a modeling-primary manifest', () => {
    expect(registry.conformance().length).toBeGreaterThanOrEqual(2);
    expect(registry.relationships().length).toBeGreaterThanOrEqual(1);
  });

  it('answers a real cross-domain question (Customer × Order) with grain-safe join guidance', () => {
    // The agent says it's looking at dim_customer + fct_order; ask for the modeled joins.
    const guidance = buildDataLexJoinGuidance(registry, ['dim_customer', 'fct_order']);
    expect(guidance).toBeDefined();

    const byConcept = Object.fromEntries(guidance!.entities.map((e) => [e.concept, e]));
    expect(byConcept.Customer).toMatchObject({ canonicalKey: ['customer_id'], physical: ['dim_customer'] });
    expect(byConcept.Order).toMatchObject({ canonicalKey: ['order_id'], physical: ['fct_order'] });

    // Two relationships connect them (conceptual one_to_many + logical FK); the
    // helper must collapse to the single grain-safe orientation: Order -> Customer.
    expect(guidance!.joins).toHaveLength(1);
    const joinGuidance = guidance!.joins[0];
    expect(joinGuidance).toMatchObject({
      from: 'Order',
      to: 'Customer',
      cardinality: 'many_to_one',
      fansOut: false,
      on: 'Order.customer_id = Customer.customer_id',
    });
    expect(joinGuidance.guidance).toMatch(/without fan-out/);
  });
});

describe('buildDataLexJoinGuidance — physical-anchored (jaffle-shop diagram-only manifest)', () => {
  const registry = new DataLexContractRegistry({ manifestPath: JAFFLE_FIXTURE });

  it('resolves dbt-table refs to grain-safe guidance even with no logical<->physical links', () => {
    // jaffle authors its model only as diagrams; the physical tables anchor the
    // conformance concepts directly (DimCustomers -> dim_customers, etc.).
    const guidance = buildDataLexJoinGuidance(registry, ['dim_customers', 'fct_orders']);
    expect(guidance).toBeDefined();

    const byConcept = Object.fromEntries(guidance!.entities.map((e) => [e.concept, e]));
    expect(byConcept.DimCustomers).toMatchObject({ canonicalKey: ['customer_id'], physical: ['dim_customers'] });
    expect(byConcept.FctOrders).toMatchObject({ canonicalKey: ['order_id'], physical: ['fct_orders'] });

    const join = guidance!.joins.find((j) => j.from === 'FctOrders' && j.to === 'DimCustomers');
    expect(join).toMatchObject({
      from: 'FctOrders',
      to: 'DimCustomers',
      cardinality: 'many_to_one',
      fansOut: false,
      on: 'FctOrders.customer_id = DimCustomers.customer_id',
    });
  });
});

describe('queryViaMetadata planning response carries datalexJoinGuidance', () => {
  it('surfaces join guidance to the agent before it writes SQL', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dql-tier2-guidance-'));
    try {
      const registry = new DataLexContractRegistry({ manifestPath: FIXTURE });
      const ctx = makeCtx({}, { projectRoot: tmp, datalexRegistry: registry } as never);
      const res = await queryViaMetadata(ctx, {
        question: 'revenue per customer across orders',
        upstreamRefs: ['dim_customer', 'fct_order'],
        // no proposedSql -> planning-only branch
      });
      expect(res).toMatchObject({ planningOnly: true });
      const guidance = (res as { datalexJoinGuidance?: { joins: Array<{ from: string; to: string; fansOut: boolean }> } }).datalexJoinGuidance;
      expect(guidance?.joins?.[0]).toMatchObject({ from: 'Order', to: 'Customer', fansOut: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
