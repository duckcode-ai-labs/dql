import type {
  MetricCapabilityContract,
  ResolvedRelationshipProofV1,
  SemanticAggregationCompilerReceiptV1,
} from '@zlens/core';
import type { LocalContextPack, MetadataObject } from './metadata/catalog.js';
import type { ResolvedAnalyticalPlan } from './resolved-analytical-plan.js';

/** Immutable RAP-only input to semantic aggregation proof. */
export interface SemanticProofAuthorityV1 {
  version: 1;
  planId: string;
  planFingerprint: string;
  snapshotId: string;
  executionId: string;
  capabilityFingerprint: string;
  metricIds: string[];
  dimensionIds: string[];
  entityGrainIds: string[];
  filterDimensionIds: string[];
  order?: 'asc' | 'desc';
  limit?: number;
  compilerReceiptFingerprint?: string;
  relationshipProofs: ResolvedRelationshipProofV1[];
  /** Exact DQL relationship objects only; retrieval candidates never enter. */
  relationshipObjects: MetadataObject[];
}

export function buildSemanticProofAuthorityV1(input: {
  plan: ResolvedAnalyticalPlan;
  capability: MetricCapabilityContract;
  contextPack?: LocalContextPack;
  compilerReceipt?: SemanticAggregationCompilerReceiptV1;
}): SemanticProofAuthorityV1 | undefined {
  const { plan, capability } = input;
  if (plan.mode !== 'authoritative' || plan.schemaVersion !== 2 || !plan.executionId
    || plan.selectedCapabilityFingerprint !== capability.sourceFingerprint
    || plan.analyticalFrame?.metricConceptIds[0] !== capability.metricId) return undefined;
  const relationshipIds = new Set(plan.relationshipPathIds);
  const relationshipObjects = (input.contextPack?.objects ?? []).filter((object) =>
    object.objectType.includes('relationship')
    && [object.objectKey, object.fullName, object.payload?.qualifiedId, object.payload?.registryQualifiedId]
      .some((identity) => typeof identity === 'string' && relationshipIds.has(identity)));
  const frame = plan.analyticalFrame;
  return {
    version: 1,
    planId: plan.planId,
    planFingerprint: plan.fingerprint,
    snapshotId: plan.snapshotId,
    executionId: plan.executionId,
    capabilityFingerprint: capability.sourceFingerprint,
    metricIds: [...new Set(frame.metricConceptIds)].sort(),
    dimensionIds: [...new Set(frame.dimensions
      .filter((binding) => binding.role === 'group_by' || binding.role === 'rank_entity')
      .map((binding) => binding.dimensionId))].sort(),
    entityGrainIds: [...new Set(frame.entityGrainIds)].sort(),
    filterDimensionIds: [...new Set(frame.memberBindings.map((binding) => binding.dimensionId))].sort(),
    ...(plan.query.order ? { order: plan.query.order } : {}),
    ...(plan.query.limit !== undefined ? { limit: plan.query.limit } : {}),
    ...(input.compilerReceipt?.receiptFingerprint
      ? { compilerReceiptFingerprint: input.compilerReceipt.receiptFingerprint }
      : {}),
    relationshipProofs: [...plan.relationshipProofs ?? []],
    relationshipObjects,
  };
}
