import { createHash } from 'node:crypto';
import type {
  MetricCapabilityContract,
  ResolvedRelationshipProofV1,
} from '@zlens/core';
import type {
  AgentEvidenceCandidate,
  AgentRelationshipSafetyEvidence,
} from './meaning-resolution.js';

/**
 * The immutable, snapshot-bound safety authority for a governed physical
 * relationship. This is deliberately separate from a capability path ID:
 * the path identifies the edge the compiler may use, while this receipt pins
 * the certification and warehouse-validation facts that made that edge safe
 * when the plan froze.
 *
 * This lives beside the local resolved plan rather than the cross-surface
 * semantic proof contract because it describes DQL's local physical registry,
 * not an adapter-native semantic path. Old persisted plans remain readable;
 * a newly compiled cross-entity governed plan must carry this authority.
 */
export interface GovernedRelationshipSafetyProofV1 {
  version: 1;
  relationshipPathId: string;
  relationshipId: string;
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  status: 'certified';
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one';
  fanout: 'safe';
  staleCertification: false;
  automaticJoinAllowed: true;
  certificationFingerprint: string;
  validation: {
    status: 'passed';
    checkedAt: string;
    queryFingerprint: string;
    proofFingerprint: string;
  };
  evidenceExpiresAt?: string;
  snapshotId: string;
  authorityFingerprint: string;
}

/** Build the sole normalized relationship authority for already selected dimensions. */
export function buildResolvedRelationshipProofsV1(input: {
  capability: MetricCapabilityContract;
  dimensionIds: string[];
  route: MetricCapabilityContract['executionCapabilities'][number]['route'];
  adapterId?: string;
  executionId: string;
  snapshotId: string;
}): ResolvedRelationshipProofV1[] {
  const route = input.capability.executionCapabilities.find((candidate) =>
    candidate.route === input.route && candidate.adapterId === input.adapterId);
  if (!route) return [];
  const dimensionIds = new Set(input.dimensionIds);
  return input.capability.dimensions
    .filter((dimension) => dimensionIds.has(dimension.dimensionId))
    .filter((dimension) => dimension.entityId !== input.capability.primaryEntityId)
    .flatMap((dimension) => {
      const relationshipPathIds = uniqueSorted(dimension.relationshipPathIds ?? []);
      const nativeGroupingReference = dimension.nativeGroupingReference?.trim();
      const nativeGroupingPath = dimension.nativeGroupingPath === undefined
        ? undefined
        : [...dimension.nativeGroupingPath];
      // A semantic adapter cannot consume a generic DQL relationship ID.
      // Cross-model semantic execution is authorized only by the exact
      // MetricFlow-native group-by frozen on this metric capability. Keep
      // generic relationship paths for relational/exploratory routes only.
      const kind = input.route === 'semantic'
        ? semanticDimensionUsesExactAdapterGrouping(input.capability, dimension)
          ? 'semantic_native_grouping' as const
          : undefined
        : relationshipPathIds.length > 0
          ? 'dql_relationship_path' as const
          : undefined;
      if (!kind) return [];
      const body = {
        version: 1 as const,
        kind,
        metricId: input.capability.metricId,
        dimensionId: dimension.dimensionId,
        sourceEntityId: input.capability.primaryEntityId,
        targetEntityId: dimension.entityId,
        route: input.route,
        ...(input.adapterId ? { adapterId: input.adapterId } : {}),
        executionId: input.executionId,
        snapshotId: input.snapshotId,
        capabilityFingerprint: input.capability.sourceFingerprint,
        relationshipPathIds,
        ...(nativeGroupingReference ? { nativeGroupingReference } : {}),
        ...(nativeGroupingPath !== undefined ? { nativeGroupingPath } : {}),
      };
      return [{ ...body, authorityFingerprint: fingerprint(body) }];
    })
    .sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

/**
 * Return true only for a cross-model dimension whose capability preserves the
 * exact adapter-native spelling and a non-empty entity path. A leaf name,
 * broad result grain, or DQL relationship is not semantic compiler proof.
 *
 * Own-model dimensions use the primary entity and do not require a
 * relationship proof; callers can handle that case separately.
 */
export function semanticDimensionUsesExactAdapterGrouping(
  capability: MetricCapabilityContract,
  dimension: MetricCapabilityContract['dimensions'][number],
): boolean {
  if (dimension.entityId === capability.primaryEntityId) return false;
  if (!capability.executionCapabilities.some((execution) =>
    execution.route === 'semantic' && Boolean(execution.adapterId?.trim()))) return false;
  const nativeGroupingReference = dimension.nativeGroupingReference?.trim();
  const nativeGroupingPath = dimension.nativeGroupingPath?.map((part) => part.trim()).filter(Boolean) ?? [];
  if (!nativeGroupingReference || nativeGroupingPath.length === 0) return false;
  const leaf = semanticDimensionLeaf(dimension.dimensionId);
  return Boolean(leaf) && nativeGroupingReference === [...nativeGroupingPath, leaf].join('__');
}

/**
 * Return true only when a cross-entity governed capability dimension carries
 * a concrete relationship path that is backed by the *same snapshot's*
 * certified, fresh, automatic, fanout-safe proof records.
 *
 * `resultGrainIds` is intentionally not authority here. It can describe the
 * shape an adapter hopes to return, but cannot prove that the governed DQL
 * compiler has an approved graph from the selected metric entity to the
 * selected dimension. Likewise, a friendly relationship ID without its
 * structured safety record is retrieval evidence, not a join authorization.
 */
export function governedCapabilityDimensionHasFreshAutomaticRelationshipProofV1(input: {
  capability: MetricCapabilityContract;
  dimension: MetricCapabilityContract['dimensions'][number];
  candidates: readonly AgentEvidenceCandidate[];
  /** Captured by the caller when deterministic tests need a stable clock. */
  now?: number;
}): boolean {
  const { capability, dimension } = input;
  if (dimension.entityId === capability.primaryEntityId) return true;

  return governedCapabilityDimensionSafetyProofsV1(input) !== undefined;
}

/**
 * Capture the precise snapshot safety records used by each selected
 * cross-entity governed dimension. The caller persists these in the frozen
 * plan so a registry cannot be silently restamped after planning.
 */
export function buildGovernedRelationshipSafetyProofsV1(input: {
  capability: MetricCapabilityContract;
  dimensions: readonly MetricCapabilityContract['dimensions'][number][];
  candidates: readonly AgentEvidenceCandidate[];
  snapshotId: string;
  /** Captured by the caller when deterministic tests need a stable clock. */
  now?: number;
}): GovernedRelationshipSafetyProofV1[] {
  const proofs = input.dimensions.flatMap((dimension) => {
    if (dimension.entityId === input.capability.primaryEntityId) return [];
    return governedCapabilityDimensionSafetyProofsV1({
      capability: input.capability,
      dimension,
      candidates: input.candidates,
      ...(input.now === undefined ? {} : { now: input.now }),
      snapshotId: input.snapshotId,
    }) ?? [];
  });
  return [...new Map(proofs.map((proof) => [proof.authorityFingerprint, proof] as const)).values()]
    .sort((left, right) => left.relationshipPathId.localeCompare(right.relationshipPathId)
      || left.relationshipId.localeCompare(right.relationshipId));
}

function governedCapabilityDimensionSafetyProofsV1(input: {
  capability: MetricCapabilityContract;
  dimension: MetricCapabilityContract['dimensions'][number];
  candidates: readonly AgentEvidenceCandidate[];
  snapshotId?: string;
  now?: number;
}): GovernedRelationshipSafetyProofV1[] | undefined {
  const { capability, dimension } = input;
  if (dimension.entityId === capability.primaryEntityId) return [];

  const pathIds = new Map((dimension.relationshipPathIds ?? [])
    .map((pathId) => [normalizeRelationshipIdentity(pathId), pathId.trim()] as const)
    .filter(([normalized, original]) => Boolean(normalized && original)));
  if (pathIds.size === 0) return undefined;

  const proofsByPathId = new Map<string, AgentRelationshipSafetyEvidence>();
  for (const candidate of input.candidates) {
    if (candidate.eligible === false) continue;
    const referenced = new Set((candidate.relationshipEvidence ?? [])
      .map(normalizeRelationshipIdentity)
      .filter(Boolean));
    if (referenced.size === 0) continue;
    for (const safety of candidate.relationshipSafety ?? []) {
      if (!relationshipSafetyAllowsFreshAutomaticGovernedProof(safety, input.now)) continue;
      const identities = relationshipSafetyIdentities(safety);
      // A safety object detached from the carrier's relationship evidence is
      // not snapshot authority. This mirrors the router's join gate and
      // prevents a neighboring, unrelated proof from satisfying a path ID.
      if (!identities.some((identity) => referenced.has(identity))) continue;
      for (const pathId of pathIds.keys()) {
        if (identities.includes(pathId)) proofsByPathId.set(pathId, safety);
      }
    }
  }
  if (proofsByPathId.size !== pathIds.size) return undefined;

  // A collection of individually safe proofs still must describe an actual
  // graph from the selected metric entity to this exact cross-entity field.
  // Do not infer a traversal from names, result grain, or shared leaves.
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string): void => {
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  };
  for (const proof of proofsByPathId.values()) {
    const from = normalizeRelationshipIdentity(proof.from ?? '');
    const to = normalizeRelationshipIdentity(proof.to ?? '');
    if (!from || !to) return undefined;
    connect(from, to);
  }
  const source = normalizeRelationshipIdentity(capability.primaryEntityId);
  const target = normalizeRelationshipIdentity(dimension.entityId);
  if (!source || !target) return undefined;
  const pending = [source];
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current === target) {
      return [...proofsByPathId.entries()]
        .map(([normalizedPathId, safety]) => governedRelationshipSafetyProof({
          relationshipPathId: pathIds.get(normalizedPathId)!,
          safety,
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        }));
    }
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return undefined;
}

function governedRelationshipSafetyProof(input: {
  relationshipPathId: string;
  safety: AgentRelationshipSafetyEvidence;
  snapshotId?: string;
}): GovernedRelationshipSafetyProofV1 {
  const validation = input.safety.validation;
  // Callers reach this only after `relationshipSafetyAllowsFreshAutomatic…`.
  // Keep the explicit assertions here so an independent future caller cannot
  // accidentally serialize a partial safety record into a frozen plan.
  if (!relationshipSafetyAllowsFreshAutomaticGovernedProof(input.safety)
    || !validation
    || !input.safety.from
    || !input.safety.to
    || !input.safety.certificationFingerprint
    || !validation.checkedAt
    || !validation.queryFingerprint
    || !validation.proofFingerprint
    || !['one_to_one', 'one_to_many', 'many_to_one'].includes(input.safety.cardinality ?? '')) {
    throw new Error('Cannot serialize an invalid governed relationship safety proof.');
  }
  const body = {
    version: 1 as const,
    relationshipPathId: input.relationshipPathId,
    relationshipId: input.safety.id,
    from: input.safety.from,
    to: input.safety.to,
    keys: [...input.safety.keys]
      .map((key) => ({ from: key.from, to: key.to }))
      .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)),
    status: 'certified' as const,
    cardinality: input.safety.cardinality as GovernedRelationshipSafetyProofV1['cardinality'],
    fanout: 'safe' as const,
    staleCertification: false as const,
    automaticJoinAllowed: true as const,
    certificationFingerprint: input.safety.certificationFingerprint,
    validation: {
      status: 'passed' as const,
      checkedAt: validation.checkedAt,
      queryFingerprint: validation.queryFingerprint,
      proofFingerprint: validation.proofFingerprint,
    },
    ...(input.safety.evidenceExpiresAt ? { evidenceExpiresAt: input.safety.evidenceExpiresAt } : {}),
    snapshotId: input.snapshotId ?? 'snapshot-unavailable',
  };
  return { ...body, authorityFingerprint: fingerprint(body) };
}

/** Reject a mutated persisted plan proof before it can authorize SQL. */
export function governedRelationshipSafetyProofIsSelfConsistentV1(
  proof: GovernedRelationshipSafetyProofV1,
): boolean {
  const { authorityFingerprint, ...body } = proof;
  return fingerprint(body) === authorityFingerprint;
}

export function resolvedRelationshipProofMatches(input: {
  proof: ResolvedRelationshipProofV1;
  capability: MetricCapabilityContract;
  route: MetricCapabilityContract['executionCapabilities'][number]['route'];
  adapterId?: string;
  executionId: string;
  snapshotId: string;
}): boolean {
  const expected = buildResolvedRelationshipProofsV1({
    capability: input.capability,
    dimensionIds: [input.proof.dimensionId],
    route: input.route,
    ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    executionId: input.executionId,
    snapshotId: input.snapshotId,
  });
  return expected.length === 1
    && expected[0]!.authorityFingerprint === input.proof.authorityFingerprint
    && stableStringify(expected[0]) === stableStringify(input.proof);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function relationshipSafetyAllowsFreshAutomaticGovernedProof(
  safety: AgentRelationshipSafetyEvidence,
  now = Date.now(),
): boolean {
  const validation = safety.validation;
  const checkedAt = Date.parse(validation?.checkedAt ?? '');
  const expiresAt = safety.evidenceExpiresAt === undefined
    ? undefined
    : Date.parse(safety.evidenceExpiresAt);
  return safety.status === 'certified'
    && safety.staleCertification === false
    && safety.automaticJoinAllowed === true
    && safety.fanout === 'safe'
    && ['one_to_one', 'one_to_many', 'many_to_one'].includes(safety.cardinality ?? '')
    && Boolean(safety.from?.trim() && safety.to?.trim())
    && Boolean(safety.certificationFingerprint?.trim())
    && Boolean(validation)
    && validation?.status === 'passed'
    && Boolean(validation?.queryFingerprint?.trim())
    && Boolean(validation?.proofFingerprint?.trim())
    && Number.isFinite(checkedAt)
    && (expiresAt === undefined || Number.isFinite(expiresAt) && expiresAt > now)
    && safety.keys.length > 0
    && safety.keys.every((key) => Boolean(key.from.trim() && key.to.trim()));
}

function relationshipSafetyIdentities(safety: AgentRelationshipSafetyEvidence): string[] {
  return uniqueSorted([safety.id, ...(safety.aliases ?? [])]
    .map(normalizeRelationshipIdentity)
    .filter(Boolean));
}

function normalizeRelationshipIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function semanticDimensionLeaf(dimensionId: string): string | undefined {
  const local = dimensionId.split(':').at(-1)?.trim();
  const leaf = local?.split('.').at(-1)?.trim();
  return leaf || undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
