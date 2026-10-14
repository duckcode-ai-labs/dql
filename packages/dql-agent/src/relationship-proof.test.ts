import { describe, expect, it } from 'vitest';
import type { MetricCapabilityContract } from '@zlens/core';
import {
  buildResolvedRelationshipProofsV1,
  governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1,
  resolvedRelationshipProofMatches,
  semanticDimensionUsesExactAdapterGrouping,
} from './relationship-proof.js';
import type { AgentEvidenceCandidate, AgentRelationshipSafetyEvidence } from './meaning-resolution.js';

const capability: MetricCapabilityContract = {
  metricId: 'semantic:uncategorized:metric:order_item.revenue',
  measureIds: ['semantic:uncategorized:measure:order_item.revenue'],
  primaryEntityId: 'semantic:uncategorized:entity:order_item',
  defaultResultGrainId: 'semantic:uncategorized:entity:order_item',
  resultGrainIds: ['semantic:uncategorized:entity:order_item', 'semantic:uncategorized:entity:customer'],
  aggregation: 'sum',
  additivity: { entities: 'additive', time: 'additive' },
  dimensions: [{
    dimensionId: 'semantic:uncategorized:dimension:customers.customer_name',
    entityId: 'semantic:uncategorized:entity:customer',
    supportedRoles: ['group_by', 'filter', 'display', 'rank_entity'],
    nativeGroupingReference: 'order_id__customer__customer_name',
    nativeGroupingPath: ['order_id', 'customer'],
  }],
  timeDimensions: [],
  operations: ['filter', 'group', 'rank'],
  supportedOutputKinds: ['dimension', 'metric_value', 'rank'],
  executionCapabilities: [{ route: 'semantic', adapterId: 'metricflow-cli' }],
  sourceFingerprint: 'sha256:jaffle-revenue-capability',
};

describe('ResolvedRelationshipProofV1', () => {
  it('pins the exact native grouping path, adapter, snapshot, capability and dimension', () => {
    const [proof] = buildResolvedRelationshipProofsV1({
      capability,
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'semantic',
      adapterId: 'metricflow-cli',
      executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    });
    expect(proof).toMatchObject({
      kind: 'semantic_native_grouping',
      nativeGroupingReference: 'order_id__customer__customer_name',
      nativeGroupingPath: ['order_id', 'customer'],
      relationshipPathIds: [],
      adapterId: 'metricflow-cli',
      snapshotId: 'snapshot-jaffle',
      capabilityFingerprint: capability.sourceFingerprint,
    });
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability, route: 'semantic', adapterId: 'metricflow-cli',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(true);
  });

  it('rejects changed path, capability fingerprint, adapter, and non-semantic native use', () => {
    const [proof] = buildResolvedRelationshipProofsV1({
      capability,
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'semantic',
      adapterId: 'metricflow-cli',
      executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    });
    expect(resolvedRelationshipProofMatches({
      proof: { ...proof!, nativeGroupingPath: ['customer'] },
      capability, route: 'semantic', adapterId: 'metricflow-cli',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability: { ...capability, sourceFingerprint: 'sha256:other' },
      route: 'semantic', adapterId: 'metricflow-cli', executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(resolvedRelationshipProofMatches({
      proof: proof!, capability, route: 'semantic', adapterId: 'native',
      executionId: capability.metricId, snapshotId: 'snapshot-jaffle',
    })).toBe(false);
    expect(buildResolvedRelationshipProofsV1({
      capability: { ...capability, executionCapabilities: [{ route: 'governed_sql', adapterId: 'sql-ast-v1' }] },
      dimensionIds: [capability.dimensions[0]!.dimensionId],
      route: 'governed_sql', adapterId: 'sql-ast-v1', executionId: capability.metricId,
      snapshotId: 'snapshot-jaffle',
    })).toEqual([]);
  });

  it('does not promote a cross-model leaf spelling into MetricFlow authority', () => {
    const flattened = {
      ...capability,
      dimensions: [{
        ...capability.dimensions[0]!,
        nativeGroupingReference: 'customer_name',
        nativeGroupingPath: [],
      }],
    };
    expect(semanticDimensionUsesExactAdapterGrouping(flattened, flattened.dimensions[0]!)).toBe(false);
    expect(buildResolvedRelationshipProofsV1({
      capability: flattened,
      dimensionIds: [flattened.dimensions[0]!.dimensionId],
      route: 'semantic',
      adapterId: 'metricflow-cli',
      executionId: flattened.metricId,
      snapshotId: 'snapshot-jaffle',
    })).toEqual([]);
  });

  it('requires an exact snapshot-backed fresh automatic proof for every governed cross-entity path', () => {
    const governed: MetricCapabilityContract = {
      ...capability,
      primaryEntityId: 'commerce::entity::order_items',
      resultGrainIds: ['commerce::entity::order_items', 'commerce::entity::supplies'],
      dimensions: [{
        dimensionId: 'dql:dimension:supplies.supply_name',
        entityId: 'commerce::entity::supplies',
        supportedRoles: ['group_by', 'filter', 'display'],
        relationshipPathIds: ['commerce::relationship::order_items_to_supplies'],
      }],
      executionCapabilities: [{ route: 'governed_sql', adapterId: 'dql-compiler-v1' }],
    };
    const relationship: AgentRelationshipSafetyEvidence = {
      id: 'commerce::relationship::order_items_to_supplies',
      from: 'commerce::entity::order_items',
      to: 'commerce::entity::supplies',
      keys: [{ from: 'product_id', to: 'product_id' }],
      status: 'certified',
      cardinality: 'many_to_one',
      fanout: 'safe',
      staleCertification: false,
      automaticJoinAllowed: true,
      certificationFingerprint: 'sha256:order-items-supplies',
      validation: {
        status: 'passed',
        checkedAt: '2026-08-24T00:00:00.000Z',
        queryFingerprint: 'sha256:query',
        proofFingerprint: 'sha256:proof',
      },
    };
    const carrier = (safety: AgentRelationshipSafetyEvidence): AgentEvidenceCandidate => ({
      id: 'dql:relationship:order_items_to_supplies',
      kind: 'dql_modeling',
      trustTier: 'governed_sql',
      name: 'order items to supplies',
      relevanceScore: 1,
      matchReasons: ['relationship proof'],
      compatibility: 'compatible',
      relationshipEvidence: [relationship.id],
      relationshipSafety: [safety],
    });

    expect(governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1({
      capability: governed,
      dimension: governed.dimensions[0]!,
      candidates: [carrier(relationship)],
      now: Date.parse('2026-08-24T12:00:00.000Z'),
    })).toBe(true);

    expect(governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1({
      capability: governed,
      dimension: { ...governed.dimensions[0]!, relationshipPathIds: ['commerce::relationship::missing'] },
      candidates: [carrier(relationship)],
      now: Date.parse('2026-08-24T12:00:00.000Z'),
    })).toBe(false);

    for (const safety of [
      { ...relationship, staleCertification: true },
      { ...relationship, status: 'draft' },
      { ...relationship, automaticJoinAllowed: false },
      { ...relationship, fanout: 'attribution_required' },
    ]) {
      expect(governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1({
        capability: governed,
        dimension: governed.dimensions[0]!,
        candidates: [carrier(safety)],
        now: Date.parse('2026-08-24T12:00:00.000Z'),
      })).toBe(false);
    }
  });
});
