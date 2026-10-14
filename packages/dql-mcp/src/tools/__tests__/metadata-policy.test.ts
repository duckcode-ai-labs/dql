import { describe, expect, it } from 'vitest';
import {
  relationshipValidationProofFingerprint,
  type DQLManifest,
  type ManifestModelRelationship,
} from '@zlens/core';
import { explainRelationshipProof, resolveAnalyticalPath } from '../metadata.js';
import { makeCtx } from './_helpers.js';

describe('manifest v3 relationship policy tools', () => {
  it('reports an executable certified relationship consistently', () => {
    const ctx = makeCtx({}, { manifest: manifest(relationship()) });

    expect(resolveAnalyticalPath(ctx, { entities: ['order', 'customer'] })).toMatchObject({
      safe: true,
      relationshipIds: ['order_to_customer'],
    });
    expect(explainRelationshipProof(ctx, { relationshipId: 'order_to_customer' })).toMatchObject({
      decision: 'automatic_join_allowed',
      policy: { executable: true },
    });
  });

  it('does not expose an expired proof as executable even when its summary bit is true', () => {
    const expired = relationship();
    expired.evidenceExpiresAt = '2020-01-01T00:00:00.000Z';
    const ctx = makeCtx({}, { manifest: manifest(expired) });

    expect(resolveAnalyticalPath(ctx, { entities: ['order', 'customer'] })).toMatchObject({
      safe: false,
      code: 'relationship_evidence_expired',
    });
    expect(explainRelationshipProof(ctx, { relationshipId: 'order_to_customer' })).toMatchObject({
      decision: 'blocked_or_review_required',
      policy: { executable: false, code: 'relationship_evidence_expired' },
    });
  });
});

function relationship(): ManifestModelRelationship {
  return {
    id: 'order_to_customer',
    from: 'order',
    to: 'customer',
    keys: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'many_to_one',
    fanout: 'safe',
    status: 'certified',
    crossDomain: false,
    sourcePath: 'domains/commerce/modeling/model.dql.yaml',
    fingerprint: 'relationship-proof',
    certificationFingerprint: 'certification-proof',
    validation: {
      status: 'passed',
      checkedAt: '2026-07-11T00:00:00.000Z',
      queryFingerprint: 'warehouse-query-proof',
      proofFingerprint: relationshipValidationProofFingerprint({
        keys: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'many_to_one',
        fanout: 'safe',
        queryFingerprint: 'warehouse-query-proof',
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
    automaticJoinAllowed: true,
  };
}

function manifest(value: ManifestModelRelationship): DQLManifest {
  return {
    manifestVersion: 3,
    modeling: {
      mode: 'dbt-first',
      packages: {},
      entities: {
        order: { id: 'order', domain: 'commerce', dbtUniqueId: 'model.commerce.orders', keys: ['customer_id'], sourcePath: 'model.dql.yaml', identityFingerprint: 'order' },
        customer: { id: 'customer', domain: 'commerce', dbtUniqueId: 'model.commerce.customers', keys: ['customer_id'], sourcePath: 'model.dql.yaml', identityFingerprint: 'customer' },
      },
      relationships: { [value.id]: value },
      contracts: {},
      conformance: {},
      rules: {},
      domainLineage: [],
    },
  } as DQLManifest;
}
