import { createHash } from 'node:crypto';

import {
  datasetTileVisualizationCompatibility,
  tileQueryHash,
  tileQueryValidationRuns,
  validateTileQuery,
  type DashboardGridItem,
  type DashboardSemanticQueryRef,
  type DatasetDescriptor,
  type MetricCapabilityContract,
  type SemanticTileConversionProvenanceV1,
  type TileFilterOperator,
  type TileQuery,
} from '@zlens/core';

/**
 * The conversion planner deliberately accepts a narrow, server-resolved
 * semantic source. It never searches by a member's display name: the caller
 * must supply the current descriptor and immutable metric capabilities that
 * the catalog already bound to one semantic model.
 */
export interface SemanticTileConversionSource {
  sourceId: string;
  sourceRevision: string;
  snapshotId: string;
  descriptor: DatasetDescriptor;
  metricCapabilities: Readonly<Record<string, MetricCapabilityContract>>;
  /** Exact provider model name recovered from approved member references. */
  semanticModelName: string;
}

export type SemanticTileConversionRefusalCode =
  | 'legacy_semantic_identity_incomplete'
  | 'legacy_semantic_source_mismatch'
  | 'legacy_semantic_snapshot_stale'
  | 'legacy_semantic_intent_unsupported'
  | 'legacy_semantic_member_unmapped'
  | 'legacy_semantic_query_invalid';

export type SemanticTileConversionPlan =
  | {
    ok: true;
    query: TileQuery;
    queryFingerprint: string;
    provenance: Omit<SemanticTileConversionProvenanceV1, 'equivalenceProofFingerprint' | 'convertedAt'>;
  }
  | { ok: false; code: SemanticTileConversionRefusalCode; message: string };

/**
 * Map a legacy semantic tile to an already-governed semantic Dataset query.
 * This is a planner, not execution authority. The runtime still resolves the
 * catalog, executes both sides in one read scope, and makes the atomic write.
 */
export function planSemanticTileConversion(input: {
  tile: DashboardGridItem;
  source: SemanticTileConversionSource;
}): SemanticTileConversionPlan {
  const semantic = input.tile.semantic;
  if (!semantic) return refusal('legacy_semantic_intent_unsupported', 'Select a legacy semantic tile before previewing a Dataset conversion.');
  const descriptor = input.source.descriptor;
  if (semantic.provider !== 'native' || descriptor.kind !== 'semantic' || descriptor.execution.adapterId !== 'native') {
    return refusal('legacy_semantic_intent_unsupported', 'This semantic tile does not use the native Dataset adapter required for an exact same-read-scope conversion.');
  }
  if (!semantic.snapshotId || semantic.snapshotId !== input.source.snapshotId) {
    return refusal('legacy_semantic_snapshot_stale', 'The legacy semantic snapshot no longer matches the current governed Dataset source. Run a fresh legacy preview or keep the original tile.');
  }
  if (!semantic.definitionFingerprint.trim() || !semantic.id.trim()) {
    return refusal('legacy_semantic_identity_incomplete', 'This legacy semantic tile has no complete immutable definition identity, so ZLens cannot convert it safely.');
  }
  const model = input.source.semanticModelName.trim();
  if (!model || !semantic.semanticModelRefs.length || semantic.semanticModelRefs.length !== 1 || semantic.semanticModelRefs[0] !== model) {
    return refusal('legacy_semantic_source_mismatch', 'The legacy semantic tile does not name exactly the current provider model selected by the governed Dataset.');
  }
  if (!semantic.qualifiedModelIds?.length || semantic.qualifiedModelIds.length !== 1 || semantic.qualifiedModelIds[0] !== descriptor.contractRef.id) {
    return refusal('legacy_semantic_identity_incomplete', 'The legacy semantic tile lacks the exact qualified provider-model identity required for conversion.');
  }
  if (!semantic.qualifiedMetricIds?.length || semantic.qualifiedMetricIds.length !== semantic.metrics.length) {
    return refusal('legacy_semantic_identity_incomplete', 'The legacy semantic tile lacks one exact qualified metric identity for every selected metric.');
  }
  if ((input.tile.filterBindings?.length ?? 0) > 0 || (input.tile.parameterBindings?.length ?? 0) > 0) {
    return refusal('legacy_semantic_intent_unsupported', 'This legacy semantic tile has dashboard filter or parameter bindings that the current Dataset conversion cannot represent exactly.');
  }
  if (semantic.dimensions?.length && semantic.limit === undefined) {
    return refusal('legacy_semantic_intent_unsupported', 'A grouped legacy semantic tile needs an explicit result limit before ZLens can prove an exact bounded conversion.');
  }

  const measures = semantic.metrics.flatMap((metric, index) => {
    const qualifiedMetricId = semantic.qualifiedMetricIds![index];
    const exactReference = `${model}.${metric}`;
    const candidates = descriptor.fields.filter((field) => field.kind === 'measure'
      && field.semanticReference === exactReference
      && field.metricId === qualifiedMetricId
      && input.source.metricCapabilities[qualifiedMetricId]?.metricId === qualifiedMetricId);
    return candidates.length === 1 ? [{ measure: candidates[0]!.name }] : [];
  });
  if (measures.length !== semantic.metrics.length) {
    return refusal('legacy_semantic_member_unmapped', 'One or more legacy semantic metrics no longer resolve through the exact governed Dataset metric identity.');
  }

  const dimensions: TileQuery['dimensions'] = [];
  const seenDimensions = new Set<string>();
  for (const member of semantic.dimensions ?? []) {
    const field = exactPhysicalMember(descriptor, model, member);
    if (!field || seenDimensions.has(field.name)) {
      return refusal('legacy_semantic_member_unmapped', `Legacy semantic dimension ${member} does not resolve exactly to one approved Dataset field.`);
    }
    seenDimensions.add(field.name);
    dimensions.push({ field: field.name });
  }
  if (semantic.timeDimension) {
    const time = exactPhysicalMember(descriptor, model, semantic.timeDimension);
    if (!time || time.role !== 'time' || !(time.time?.grains ?? []).includes('month') || seenDimensions.has(time.name)) {
      return refusal('legacy_semantic_member_unmapped', `Legacy semantic time member ${semantic.timeDimension} does not resolve to one approved monthly Dataset field.`);
    }
    seenDimensions.add(time.name);
    dimensions.push({ field: time.name, timeGrain: 'month' });
  }

  const filters = (semantic.filters ?? []).flatMap((filter) => {
    const field = exactPhysicalMember(descriptor, model, filter.field);
    const op = legacyFilterOperator(filter.operator);
    if (!field || !op) return [];
    return [{ field: field.name, op, values: Array.isArray(filter.value) ? [...filter.value] : [filter.value] }];
  });
  if (filters.length !== (semantic.filters ?? []).length) {
    return refusal('legacy_semantic_intent_unsupported', 'A legacy semantic filter is not an exact supported Dataset field predicate.');
  }

  const query: TileQuery = {
    dimensions,
    measures,
    ...(filters.length ? { filters } : {}),
    ...(semantic.orderBy?.length ? {
      orderBy: semantic.orderBy.flatMap((order) => {
        const metricIndex = semantic.metrics.findIndex((metric) => metric === order.field);
        if (metricIndex >= 0) return [{ alias: measures[metricIndex]!.measure, direction: order.direction }];
        const field = exactPhysicalMember(descriptor, model, order.field);
        if (!field) return [];
        const dimension = dimensions.find((candidate) => candidate.field === field.name);
        if (!dimension) return [];
        return [{ alias: dimension.alias ?? (dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : dimension.field), direction: order.direction }];
      }),
    } : {}),
    ...(semantic.limit !== undefined ? { limit: semantic.limit } : {}),
  };
  if ((semantic.orderBy?.length ?? 0) !== (query.orderBy?.length ?? 0)) {
    return refusal('legacy_semantic_intent_unsupported', 'A legacy semantic sort does not name one selected exact Dataset output.');
  }
  const validation = validateTileQuery(descriptor, query);
  if (!tileQueryValidationRuns(validation)) {
    return refusal('legacy_semantic_query_invalid', validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ') || 'The mapped Dataset query is not covered by the current source contract.');
  }
  const visualization = datasetTileVisualizationCompatibility(query, input.tile.viz.type);
  if (!visualization.compatible) {
    return refusal('legacy_semantic_query_invalid', visualization.message ?? 'The mapped Dataset query is not compatible with this tile visualization.');
  }
  const queryFingerprint = tileQueryHash(query);
  return {
    ok: true,
    query,
    queryFingerprint,
    provenance: {
      version: 1,
      kind: 'semantic_tile_conversion_provenance',
      legacyIdentityFingerprint: fingerprint({
        id: semantic.id,
        provider: semantic.provider,
        qualifiedMetricIds: semantic.qualifiedMetricIds,
        qualifiedModelIds: semantic.qualifiedModelIds,
        definitionFingerprint: semantic.definitionFingerprint,
        snapshotId: semantic.snapshotId,
      }),
      legacyTileFingerprint: fingerprint(input.tile),
      legacyPayload: jsonRecord({
        semantic,
        sourceId: input.tile.sourceId,
        sourceRevision: input.tile.sourceRevision,
        title: input.tile.title,
      }),
      datasetId: input.source.sourceId,
      sourceRevision: input.source.sourceRevision,
      contractFingerprint: descriptor.contractRef.fingerprint,
      queryFingerprint,
    },
  };
}

function exactPhysicalMember(descriptor: DatasetDescriptor, model: string, member: string) {
  // A legacy query may persist the fully qualified provider reference or the
  // member spelling scoped by its already-verified model. Both compare to the
  // immutable descriptor bridge; neither is a global leaf-name lookup.
  const expected = member.includes('.') ? member : `${model}.${member}`;
  const candidates = descriptor.fields.filter((field): field is Extract<typeof field, { kind: 'physical' }> => field.kind === 'physical' && field.semanticReference === expected);
  return candidates.length === 1 ? candidates[0]! : undefined;
}

function legacyFilterOperator(value: string): TileFilterOperator | undefined {
  switch (value.toLowerCase()) {
    case '=':
    case 'equals': return 'eq';
    case '!=':
    case '<>':
    case 'not_equals': return 'neq';
    case 'in': return 'in';
    case 'not_in': return 'not_in';
    case '>':
    case 'gt': return 'gt';
    case '>=':
    case 'gte': return 'gte';
    case '<':
    case 'lt': return 'lt';
    case '<=':
    case 'lte': return 'lte';
    default: return undefined;
  }
}

function refusal(code: SemanticTileConversionRefusalCode, message: string): SemanticTileConversionPlan {
  return { ok: false, code, message };
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, candidate]) => candidate !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, canonical(candidate)]));
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
