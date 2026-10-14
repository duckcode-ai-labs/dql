import { describe, expect, it } from 'vitest';
import { relationshipValidationProofFingerprint, type DQLManifest } from '@zlens/core';
import { evaluateDbtFirstGeneratedSql } from './dbt-first-safety.js';
import { analyticalPolicyUserFacingReason, planAnalyticalPath } from './analytical-policy.js';

/**
 * Disposition-contract tests over a jaffle-shop-shaped manifest: five entities
 * with a COMPLETE declared join chain (order_item→order/product,
 * order→customer/location) that is entirely `status: draft` — the exact shape
 * that used to dead-end in "No certified, validated, fanout-safe DQL path
 * connects …" instead of the review-required exploratory lane.
 */
describe('planAnalyticalPath dispositions', () => {
  const ALL_FIVE = ['customer', 'location', 'order', 'order_item', 'product'];

  it('offers the declared draft path for the full five-entity ask', () => {
    const plan = planAnalyticalPath(jaffleDraftManifest(), { entityIds: ALL_FIVE });

    expect(plan.disposition).toBe('exploratory_candidate');
    expect(plan.reasonCode).toBe('relationship_not_certified');
    expect(plan.exploratoryPath?.edges.map((edge) => edge.relationshipId).sort()).toEqual([
      'order_item_to_order', 'order_item_to_product', 'order_to_customer', 'order_to_location',
    ]);
    expect(plan.exploratoryPath?.edges.every((edge) => edge.lifecycle === 'draft')).toBe(true);
    expect(plan.exploratoryPath?.edges.every((edge) => edge.keys.length > 0)).toBe(true);
    expect(plan.exploratoryPath?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Deprecated projections stay coherent for pre-disposition consumers.
    expect(plan).toMatchObject({ safe: false, code: 'relationship_not_certified' });
    expect(plan.relationshipIds).toHaveLength(4);
    // The chat-facing reason is business language, never qualified ids.
    expect(plan.userFacingReason).toContain('draft join path');
    expect(plan.userFacingReason).not.toContain('::');
  });

  it('spans customer to product through the draft bridge entities', () => {
    const plan = planAnalyticalPath(jaffleDraftManifest(), { entityIds: ['customer', 'product'] });

    expect(plan.disposition).toBe('exploratory_candidate');
    expect(plan.exploratoryPath?.edges.map((edge) => edge.relationshipId).sort()).toEqual([
      'order_item_to_order', 'order_item_to_product', 'order_to_customer',
    ]);
  });

  it('prefers a fully governed span over draft alternatives', () => {
    const value = jaffleDraftManifest();
    value.modeling!.relationships.order_to_customer = certifiedRelationship('order_to_customer', 'order', 'customer', 'fct_orders', 'dim_customers', 'customer_id');

    const plan = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(plan.disposition).toBe('governed');
    expect(plan).toMatchObject({ safe: true, relationshipIds: ['order_to_customer'] });
    expect(plan.exploratoryPath).toBeUndefined();
  });

  it('mixes certified and draft edges in one exploratory path', () => {
    const value = jaffleDraftManifest();
    value.modeling!.relationships.order_to_customer = certifiedRelationship('order_to_customer', 'order', 'customer', 'fct_orders', 'dim_customers', 'customer_id');

    const plan = planAnalyticalPath(value, { entityIds: ['customer', 'product'] });

    expect(plan.disposition).toBe('exploratory_candidate');
    const lifecycles = Object.fromEntries((plan.exploratoryPath?.edges ?? []).map((edge) => [edge.relationshipId, edge.lifecycle]));
    expect(lifecycles).toEqual({
      order_to_customer: 'certified',
      order_item_to_order: 'draft',
      order_item_to_product: 'draft',
    });
  });

  it.each([
    ['deprecated', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.status = 'deprecated'; }],
    ['cross-domain', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.crossDomain = true; }],
    ['attribution-required fanout', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.fanout = 'attribution_required'; }],
    ['many-to-many', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.cardinality = 'many_to_many' as never; }],
    ['keyless', (value: DQLManifest) => { value.modeling!.relationships.order_to_customer.keys = []; }],
  ])('never suggests a %s draft edge', (_label, sabotage) => {
    const value = jaffleDraftManifest();
    sabotage(value);

    const plan = planAnalyticalPath(value, { entityIds: ['customer', 'product'] });

    expect(plan.disposition).toBe('blocked');
    expect(plan.exploratoryPath).toBeUndefined();
  });

  it('keeps a certified-but-unauthorized relationship terminal (no draft resurrection)', () => {
    const value = jaffleDraftManifest();
    value.modeling!.relationships.order_to_customer = certifiedRelationship('order_to_customer', 'order', 'customer', 'fct_orders', 'dim_customers', 'customer_id');
    value.modeling!.relationships.order_to_customer.automaticJoinAllowed = false;

    const plan = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(plan.disposition).toBe('blocked');
    expect(plan.reasonCode).toBe('unsafe_relationship');
    expect(plan.exploratoryPath).toBeUndefined();
  });

  it('refuses with a focused ambiguity when two same-tier relationships use different keys', () => {
    const value = jaffleDraftManifest();
    value.modeling!.relationships.order_to_billing_location = draftRelationship(
      'order_to_billing_location', 'order', 'location', 'fct_orders', 'dim_locations', 'billing_location_id', 'location_id');

    const plan = planAnalyticalPath(value, { entityIds: ['order', 'location'] });

    expect(plan.disposition).toBe('blocked');
    expect(plan.reasonCode).toBe('relationship_ambiguous');
    expect(plan.technicalDetail).toContain('order_to_billing_location');
    expect(plan.userFacingReason).toContain('which relationship');
  });

  it('keeps attribution boundaries terminal for directly-requested entity pairs', () => {
    const value = jaffleDraftManifest();
    value.modeling!.relationships.order_to_customer.fanout = 'attribution_required';

    const plan = planAnalyticalPath(value, { entityIds: ['order', 'customer'] });

    expect(plan.disposition).toBe('blocked');
    expect(plan.reasonCode).toBe('attribution_policy_required');
    expect(plan.exploratoryPath).toBeUndefined();
  });
});

describe('evaluateDbtFirstGeneratedSql with declared draft paths', () => {
  it('re-binds the exploratory path to the SQL actual joins', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      `select p.product_name, l.location_name, c.customer_name, sum(oi.subtotal)
       from fct_order_items oi
       join fct_orders o on oi.order_id = o.order_id
       join dim_products p on oi.product_id = p.product_id
       join dim_customers c on o.customer_id = c.customer_id
       join dim_locations l on o.location_id = l.location_id
       group by 1, 2, 3`,
      jaffleDraftManifest(),
    );

    expect(decision.disposition).toBe('exploratory_candidate');
    expect(decision.exploratoryPath?.edges.map((edge) => edge.relationshipId).sort()).toEqual([
      'order_item_to_order', 'order_item_to_product', 'order_to_customer', 'order_to_location',
    ]);
    expect(decision.userFacingReason).not.toContain('::');
    expect(decision.technicalDetail).toContain('uncertified edge');
  });

  it('blocks a join that ignores the declared keys', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select * from fct_orders o join dim_customers c on o.order_id = c.customer_id',
      jaffleDraftManifest(),
    );

    expect(decision.disposition).toBe('blocked');
    expect(decision.code).toBe('join_key_mismatch');
    expect(decision.exploratoryPath).toBeUndefined();
  });

  it('blocks a join between entities with no declared relationship', () => {
    const decision = evaluateDbtFirstGeneratedSql(
      'select * from dim_customers c join dim_products p on c.customer_id = p.product_id',
      jaffleDraftManifest(),
    );

    expect(decision.disposition).toBe('blocked');
    expect(decision.code).toBe('unplanned_join');
  });
});

describe('analyticalPolicyUserFacingReason', () => {
  it('humanizes qualified entity ids for every code', () => {
    const entities = ['commerce::entity::order_item', 'commerce::entity::customer'];
    for (const code of [
      'attribution_policy_required', 'relationship_not_exported', 'purpose_not_allowed', 'stale_certification',
      'relationship_evidence_missing', 'relationship_not_certified', 'relationship_ambiguous',
      'unbound_relation', 'unplanned_join', 'join_key_mismatch', 'unsafe_relationship',
    ] as const) {
      const reason = analyticalPolicyUserFacingReason(code, entities);
      expect(reason).not.toContain('::');
      expect(reason.length).toBeGreaterThan(40);
    }
    expect(analyticalPolicyUserFacingReason('unsafe_relationship', entities)).toContain('order item');
  });
});

function jaffleDraftManifest(): DQLManifest {
  const models: Array<[string, string]> = [
    ['order', 'fct_orders'],
    ['customer', 'dim_customers'],
    ['order_item', 'fct_order_items'],
    ['product', 'dim_products'],
    ['location', 'dim_locations'],
  ];
  return {
    manifestVersion: 3,
    dqlVersion: '2.0.0',
    generatedAt: '2026-07-19T00:00:00.000Z',
    project: 'jaffle',
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
      nodes: Object.fromEntries(models.map(([, name]) => [`model.jaffle.${name}`, node(`model.jaffle.${name}`, name)])),
      metricFlow: {},
    },
    modeling: {
      mode: 'dbt-first',
      packages: {},
      entities: Object.fromEntries(models.map(([id, name]) => [id, entity(id, `model.jaffle.${name}`)])),
      relationships: {
        order_item_to_order: draftRelationship('order_item_to_order', 'order_item', 'order', 'fct_order_items', 'fct_orders', 'order_id', 'order_id'),
        order_item_to_product: draftRelationship('order_item_to_product', 'order_item', 'product', 'fct_order_items', 'dim_products', 'product_id', 'product_id'),
        order_to_customer: draftRelationship('order_to_customer', 'order', 'customer', 'fct_orders', 'dim_customers', 'customer_id', 'customer_id'),
        order_to_location: draftRelationship('order_to_location', 'order', 'location', 'fct_orders', 'dim_locations', 'location_id', 'location_id'),
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

function entity(id: string, dbtUniqueId: string) {
  const qualifiedId = `commerce::entity::${id}`;
  return { id: qualifiedId, localId: id, qualifiedId, dbtUniqueId, domain: 'commerce', grain: `${id}_id`, keys: [`${id}_id`], sourcePath: 'modeling/model.dql.yaml', identityFingerprint: id };
}

function draftRelationship(
  id: string,
  from: string,
  to: string,
  _fromModel: string,
  _toModel: string,
  fromKey: string,
  toKey: string = fromKey,
) {
  return {
    id,
    localId: id,
    qualifiedId: `commerce::relationship::${id}`,
    from,
    to,
    keys: [{ from: fromKey, to: toKey }],
    cardinality: 'many_to_one' as const,
    fanout: 'safe' as const,
    status: 'draft' as const,
    crossDomain: false,
    sourcePath: 'modeling/model.dql.yaml',
    fingerprint: id,
    staleCertification: false,
    automaticJoinAllowed: false,
  };
}

function certifiedRelationship(
  id: string,
  from: string,
  to: string,
  fromModel: string,
  toModel: string,
  key: string,
) {
  const queryFingerprint = `${id}-validation-query`;
  return {
    ...draftRelationship(id, from, to, fromModel, toModel, key),
    status: 'certified' as const,
    automaticJoinAllowed: true,
    certificationFingerprint: `${id}-certification`,
    validation: {
      status: 'passed' as const,
      checkedAt: '2026-07-18T00:00:00.000Z',
      queryFingerprint,
      proofFingerprint: relationshipValidationProofFingerprint({
        fromRelation: `analytics.marts.${fromModel}`,
        toRelation: `analytics.marts.${toModel}`,
        keys: [{ from: key, to: key }],
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
  };
}
