import { describe, expect, it } from 'vitest';
import { buildManifest, relationshipValidationProofFingerprint, type DQLManifest } from '@zlens/core';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDbtFirstGeneratedSql } from './dbt-first-safety.js';
import { planAnalyticalPath } from './analytical-policy.js';
import { resolveDomainContextEnvelope } from '../domain-context.js';

const commerceFixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/cli/test/fixtures/dbt-first-commerce');

describe('evaluateDbtFirstGeneratedSql', () => {
  it('allows a certified fanout-safe relationship path', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select sum(o.order_total) from fct_orders o join dim_customers c on o.customer_id = c.customer_id',
      manifest(),
    );

    expect(decision).toMatchObject({ safe: true, relationshipIds: ['order_to_customer'] });
  });

  it('requires attribution policy for a many-touch path', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select sum(o.order_total) from fct_campaign_touches t join fct_orders o on t.customer_id = o.customer_id',
      manifest(),
    );

    expect(decision).toMatchObject({ safe: false, code: 'attribution_policy_required', relationshipIds: ['touch_to_order'] });
    expect(decision.message).toContain('attribution policy');
  });

  it('withdraws automatic proof when a certification is stale', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_customer.staleCertification = true;
    value.modeling!.relationships.order_to_customer.automaticJoinAllowed = false;

    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join dim_customers c on o.customer_id = c.customer_id',
      value,
    );

    expect(decision).toMatchObject({ safe: false, code: 'stale_certification' });
  });

  it('does not trust an automatic flag when warehouse evidence is missing', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_customer.validation = undefined;

    const decision = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(decision).toMatchObject({
      safe: false,
      code: 'relationship_evidence_missing',
      relationshipIds: ['order_to_customer'],
    });
  });

  it('withdraws an automatic path when warehouse evidence has expired', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_customer.evidenceExpiresAt = '2020-01-01T00:00:00.000Z';

    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join dim_customers c on o.customer_id = c.customer_id',
      value,
    );

    expect(decision).toMatchObject({ safe: false, code: 'relationship_evidence_expired' });
  });

  it.each([
    ['failed validation', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.status = 'failed'; }],
    ['missing certification fingerprint', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.certificationFingerprint = undefined; }],
    ['invalid validation timestamp', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.checkedAt = 'not-a-date'; }],
    ['empty validation query fingerprint', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.queryFingerprint = ''; }],
    ['changed validation query fingerprint', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.queryFingerprint = 'tampered-query'; }],
    ['legacy validation without bound proof', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.proofFingerprint = undefined; }],
    ['mismatched validation proof fingerprint', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.validation!.proofFingerprint = 'proof-for-different-keys'; }],
  ])('withdraws an automatic path for %s', (_label, invalidate) => {
    const value = manifest();
    invalidate(value);

    const decision = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(decision).toMatchObject({ safe: false, code: 'relationship_proof_invalid' });
  });

  it('requires the compiler authorization bit even when the source proof looks valid', () => {
    const value = manifest();
    value.modeling!.relationships.order_to_customer.automaticJoinAllowed = false;

    const decision = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(decision).toMatchObject({ safe: false, code: 'unsafe_relationship' });
  });

  it('rejects a connected table pair when the SQL uses the wrong join keys', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join dim_customers c on o.order_id = c.customer_id',
      manifest(),
    );
    expect(decision).toMatchObject({ safe: false, code: 'join_key_mismatch', relationshipIds: ['order_to_customer'] });
  });

  it('rejects an unbound relation in generated join SQL', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join mystery_table m on o.customer_id = m.customer_id',
      manifest(),
    );
    expect(decision).toMatchObject({ safe: false, code: 'unbound_relation' });
  });

  it('uses the compiled Commerce to Growth safe path and blocks raw campaign-touch attribution', () => {
    const compiled = buildManifest({ projectRoot: commerceFixture, dbtManifestPath: join(commerceFixture, 'target/manifest.json') });
    const domainContext = resolveDomainContextEnvelope({
      manifest: compiled,
      activeDomain: 'growth',
      purpose: 'growth_attribution',
      source: 'explicit_api',
    });
    const safe = planAnalyticalPath(compiled, {
      entityIds: ['commerce::entity::order', 'growth::entity::acquisition'],
      purpose: 'growth_attribution',
      domainContext,
      question: 'gross revenue by acquisition channel',
    });
    expect(safe).toMatchObject({ safe: true, relationshipIds: [
      'commerce::relationship::order_to_customer',
      'growth::relationship::acquisition_to_customer',
    ] });

    const unsafe = planAnalyticalPath(compiled, {
      entityIds: ['growth::entity::campaign_touch', 'commerce::entity::order'],
      purpose: 'growth_attribution',
      domainContext,
      question: 'gross revenue by raw campaign touch',
    });
    expect(unsafe).toMatchObject({
      safe: false,
      code: 'attribution_policy_required',
      relationshipIds: ['growth::relationship::touch_to_order_attribution'],
    });
  });

  it('blocks a compiled cross-domain path without explicit purpose and a server-resolved envelope', () => {
    const compiled = buildManifest({ projectRoot: commerceFixture, dbtManifestPath: join(commerceFixture, 'target/manifest.json') });
    const decision = planAnalyticalPath(compiled, {
      entityIds: ['commerce::entity::order', 'growth::entity::acquisition'],
    });
    expect(decision).toMatchObject({ safe: false, code: 'purpose_not_allowed' });
  });

  it('blocks a cross-domain path when the export contract is absent from the resolved snapshot', () => {
    const compiled = buildManifest({ projectRoot: commerceFixture, dbtManifestPath: join(commerceFixture, 'target/manifest.json') });
    delete compiled.modeling!.contracts['commerce::contract::customer_identity_contract'];
    const domainContext = resolveDomainContextEnvelope({
      manifest: compiled,
      activeDomain: 'growth',
      purpose: 'growth_attribution',
    });
    const decision = planAnalyticalPath(compiled, {
      entityIds: ['commerce::entity::order', 'growth::entity::acquisition'],
      purpose: 'growth_attribution',
      domainContext,
    });
    expect(domainContext.allowedImports).not.toContainEqual(expect.objectContaining({ exportRef: 'commerce.customer_identity@1' }));
    expect(decision).toMatchObject({ safe: false, code: 'relationship_not_exported' });
  });

  it('does not accept a client purpose when the resolved envelope has no allowed import', () => {
    const compiled = buildManifest({ projectRoot: commerceFixture, dbtManifestPath: join(commerceFixture, 'target/manifest.json') });
    const resolved = resolveDomainContextEnvelope({ manifest: compiled, activeDomain: 'growth', purpose: 'growth_attribution' });
    const decision = planAnalyticalPath(compiled, {
      entityIds: ['commerce::entity::order', 'growth::entity::acquisition'],
      purpose: 'growth_attribution',
      domainContext: { ...resolved, allowedImports: [] },
    });
    expect(decision).toMatchObject({ safe: false, code: 'relationship_not_exported' });
  });
});

function manifest(): DQLManifest {
  return {
    manifestVersion: 3,
    dqlVersion: '2.0.0',
    generatedAt: '2026-07-10T00:00:00.000Z',
    project: 'commerce',
    projectRoot: '/fixture',
    blocks: {},
    businessViews: {},
    terms: {},
    notebooks: {},
    metrics: {},
    dimensions: {},
    sources: {},
    lineage: { nodes: [], edges: [], domains: [], crossDomainFlows: [], domainTrust: {} },
    dbtProvenance: {
      manifestPath: '/fixture/target/manifest.json',
      manifestFingerprint: 'manifest',
      nodes: {
        'model.commerce.fct_orders': node('model.commerce.fct_orders', 'fct_orders'),
        'model.commerce.dim_customers': node('model.commerce.dim_customers', 'dim_customers'),
        'model.growth.fct_campaign_touches': node('model.growth.fct_campaign_touches', 'fct_campaign_touches'),
      },
      metricFlow: {},
    },
    modeling: {
      mode: 'dbt-first',
      packages: {},
      entities: {
        order: entity('order', 'model.commerce.fct_orders', 'commerce'),
        customer: entity('customer', 'model.commerce.dim_customers', 'commerce'),
        campaign_touch: entity('campaign_touch', 'model.growth.fct_campaign_touches', 'growth'),
      },
      relationships: {
        order_to_customer: relationship('order_to_customer', 'order', 'customer', { status: 'certified', automaticJoinAllowed: true }),
        touch_to_order: relationship('touch_to_order', 'campaign_touch', 'order', {
          cardinality: 'many_to_many',
          fanout: 'attribution_required',
          status: 'draft',
        }),
      },
      contracts: {},
      conformance: {},
      rules: {},
      domainLineage: [],
    },
  };
}

function node(uniqueId: string, name: string) {
  return {
    uniqueId,
    resourceType: 'model' as const,
    name,
    relation: `analytics.marts.${name}`,
    identityFingerprint: uniqueId,
    available: { description: true, columns: true, tests: true, catalogTypes: true, dqlMeta: true },
  };
}

function entity(id: string, dbtUniqueId: string, domain: string) {
  const qualifiedId = `${domain}::entity::${id}`;
  return { id: qualifiedId, localId: id, qualifiedId, dbtUniqueId, domain, grain: `${id}_id`, keys: ['customer_id'], sourcePath: 'entities.dql.yaml', identityFingerprint: id };
}

function relationship(
  id: string,
  from: string,
  to: string,
  overrides: Partial<DQLManifest['modeling'] extends infer T ? T extends { relationships: Record<string, infer R> } ? R : never : never> = {},
) {
  const queryFingerprint = `${id}-validation-query`;
  const fromRelation = `analytics.marts.${from === 'order' ? 'fct_orders' : from === 'customer' ? 'dim_customers' : 'fct_campaign_touches'}`;
  const toRelation = `analytics.marts.${to === 'order' ? 'fct_orders' : to === 'customer' ? 'dim_customers' : 'fct_campaign_touches'}`;
  return {
    id,
    localId: id,
    qualifiedId: `commerce::relationship::${id}`,
    from,
    to,
    keys: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'many_to_one' as const,
    fanout: 'safe' as const,
    status: 'certified' as const,
    crossDomain: false,
    sourcePath: 'relationships.dql.yaml',
    fingerprint: id,
    certificationFingerprint: `${id}-certification`,
    validation: {
      status: 'passed' as const,
      checkedAt: '2026-07-11T00:00:00.000Z',
      queryFingerprint,
      proofFingerprint: relationshipValidationProofFingerprint({
        fromRelation,
        toRelation,
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'many_to_one',
        fanout: 'safe',
        queryFingerprint,
      }),
      fromRows: 10,
      toRows: 5,
      joinedRows: 10,
      fromNullKeys: 0,
      toNullKeys: 0,
      unmatchedFrom: 0,
      maxFromPerKey: 5,
      maxToPerKey: 1,
    },
    staleCertification: false,
    automaticJoinAllowed: false,
    ...overrides,
  };
}
