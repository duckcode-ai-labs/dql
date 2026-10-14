import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  datasetProofFingerprint,
  isDatasetGrainProof,
  validateDatasetGrainProof,
  type DatasetDescriptor,
  type DatasetGrainProofV1,
  type DatasetOperation,
  type DatasetMeasureField,
  type DatasetPhysicalField,
  type ManifestBlock,
  type MetricCapabilityContract,
} from '@zlens/core';
import { parseDatasetAggregateExpression } from '@zlens/core/datasets/aggregate-expression.node';

/** Optional reviewed portable proof registry retained for source compatibility. */
export const DATASET_PROOF_RELATIVE_PATH = 'datasets/proofs.json';
/** Target-bound proof results are local runtime evidence, never generated Git artifacts. */
export const LOCAL_DATASET_PROOF_RELATIVE_PATH = '.dql/local/datasets/proofs.json';

export type DatasetProofState = 'not_a_dataset' | 'target_required' | 'valid' | 'missing' | 'invalid' | 'stale';

export interface DatasetCatalogDescriptorResult {
  descriptor?: DatasetDescriptor;
  proof?: DatasetGrainProofV1;
  proofState: DatasetProofState;
  reason?: string;
}

/**
 * Values supplied by the server immediately before execution or preflight.
 *
 * `proofSnapshot*` is scoped to a dataset declaration and its dependencies.
 * `ProjectSnapshotService` also observes app files, so using its global
 * snapshot as reusable grain evidence would invalidate a correct proof every
 * time an app is published. `runtimeSnapshotId` stays on the run receipt and
 * is never substituted into the persisted grain proof.
 */
export interface DatasetBindingAuthority {
  runtimeSnapshotId: string;
  proofSnapshotId: string;
  proofSnapshotFingerprint: string;
  activeTargetFingerprint: string;
}

/**
 * The exact declaration-derived values a persisted grain proof must cover.
 * Keeping this calculation here lets the runtime bind a proof with the same
 * rules as catalog discovery, without treating values embedded in the proof as
 * authoritative current state.
 */
export interface DatasetBlockProofMaterial {
  queryFingerprint: string;
  keyFingerprint: string;
  parameterFingerprint: string;
  contractFingerprint: string;
  scope: { snapshotId: string; snapshotFingerprint: string };
}

export interface SemanticDatasetFieldProjection {
  name: string;
  qualifiedId: string;
  /** Exact provider member reference authorised by the metric capability. */
  semanticReference: string;
  type: DatasetPhysicalField['type'];
  role: DatasetPhysicalField['role'];
  status: DatasetPhysicalField['status'];
  time?: DatasetPhysicalField['time'];
  hierarchy?: DatasetPhysicalField['hierarchy'];
}

export interface SemanticMetricDatasetProjectionInput {
  sourceId: string;
  sourceRevision: string;
  /** Provider metric name used by the semantic compile request. */
  measureName: string;
  /** Exact model-qualified provider metric reference. */
  semanticReference: string;
  label: string;
  domain?: string;
  lifecycle: DatasetDescriptor['lifecycle'];
  /** This is the immutable semantic_metric.payload.analyticalCapability. */
  capability: MetricCapabilityContract;
  fields: SemanticDatasetFieldProjection[];
}

/**
 * A semantic Dataset is model-scoped, while each measure retains the exact
 * immutable capability which authorised it.  The field builder may show the
 * combined model surface, but execution must resolve the selected measure's
 * capability again; this type deliberately does not collapse those contracts
 * into a permissive synthetic capability.
 */
export interface SemanticDatasetMeasureProjection {
  /** Provider metric name used by the semantic compile request. */
  measureName: string;
  /** Exact model-qualified provider reference for the selected metric. */
  semanticReference: string;
  /** Author-declared provider display contract, projected without name guessing. */
  format?: DatasetMeasureField['format'];
  capability: MetricCapabilityContract;
  fields: SemanticDatasetFieldProjection[];
}

export interface SemanticMetricsDatasetProjectionInput {
  sourceId: string;
  sourceRevision: string;
  semanticModelId: string;
  label: string;
  domain?: string;
  lifecycle: DatasetDescriptor['lifecycle'];
  measures: SemanticDatasetMeasureProjection[];
}

/**
 * Read the narrow, versioned grain-proof registry. Corrupt files do not throw
 * the catalog off its immutable snapshot path; the source instead asks for a
 * target binding before it can execute or publish.
 */
export function loadDatasetGrainProofs(projectRoot: string): Map<string, DatasetGrainProofV1> {
  const proofs = new Map<string, DatasetGrainProofV1>();
  // A fresh local target validation intentionally wins over a portable proof
  // with the same declared ID. Both remain fail-closed when any material no
  // longer matches the active source, parameters, or warehouse.
  for (const relativePath of [DATASET_PROOF_RELATIVE_PATH, LOCAL_DATASET_PROOF_RELATIVE_PATH]) {
    const path = join(projectRoot, relativePath);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; proofs?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.proofs)) continue;
      for (const candidate of raw.proofs) {
        if (isDatasetGrainProof(candidate)) proofs.set(candidate.id, candidate);
      }
    } catch {
      // A corrupt local receipt is not authority. Other proof sources remain
      // usable only if they independently match all current bindings.
    }
  }
  return proofs;
}

/**
 * Return the stable content scope that a grain proof may cover. The scope does
 * not include `dql.app.json`, `.dqld`, a proof artifact, or project mtime
 * metadata. It changes when the dataset DQL source, query, contract, key, or
 * declared physical dependencies change.
 */
export function datasetProofScope(input: {
  sourceId: string;
  sourceRevision: string;
  queryFingerprint: string;
  keyFingerprint: string;
  parameterFingerprint: string;
  contractFingerprint: string;
  dependencies: string[];
}): { snapshotId: string; snapshotFingerprint: string } {
  const snapshotFingerprint = datasetProofFingerprint({
    version: 1,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    queryFingerprint: input.queryFingerprint,
    keyFingerprint: input.keyFingerprint,
    parameterFingerprint: input.parameterFingerprint,
    contractFingerprint: input.contractFingerprint,
    dependencies: [...new Set(input.dependencies.map(normalizeIdentity).filter(Boolean))].sort(),
  });
  return {
    snapshotId: `dataset-scope:${snapshotFingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    snapshotFingerprint,
  };
}

export function datasetBlockProofMaterial(input: {
  block: ManifestBlock;
  sourceId: string;
  sourceRevision: string;
  /** Source parameters alter the full Dataset source that is being proven. */
  parameterValues?: Record<string, unknown>;
}): DatasetBlockProofMaterial | undefined {
  const { block, sourceId, sourceRevision } = input;
  if (!block.datasetGrain || !block.datasetFields?.length || !block.datasetMeasures?.length) return undefined;
  const queryFingerprint = datasetProofFingerprint({
    version: 1,
    blockType: block.blockType,
    sql: block.sql.trim(),
    metricsRef: [...(block.metricsRef ?? []), ...(block.metricRef ? [block.metricRef] : [])].sort(),
    dimensionsRef: [...(block.dimensionsRef ?? [])].sort(),
  });
  const keyFingerprint = datasetProofFingerprint({ keys: [...block.datasetGrain.keys].map(normalizeIdentity).sort() });
  const parameterFingerprint = datasetProofFingerprint(input.parameterValues ?? {});
  const contractFingerprint = datasetProofFingerprint({
    grain: {
      entities: [...block.datasetGrain.entities].map(normalizeIdentity).sort(),
      keys: [...block.datasetGrain.keys].map(normalizeIdentity).sort(),
      timeGrain: block.datasetGrain.timeGrain,
      timeBucketBy: block.datasetGrain.timeBucketBy,
      aggregate: block.datasetGrain.aggregate === true,
    },
    fields: block.datasetFields.map((field) => ({ ...field, grains: field.grains ? [...field.grains].sort() : undefined }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    measures: block.datasetMeasures.map((measure) => ({ ...measure, allowedAggs: measure.allowedAggs ? [...measure.allowedAggs].sort() : undefined }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
  return {
    queryFingerprint,
    keyFingerprint,
    parameterFingerprint,
    contractFingerprint,
    scope: datasetProofScope({
      sourceId,
      sourceRevision,
      queryFingerprint,
      keyFingerprint,
      parameterFingerprint,
      contractFingerprint,
      dependencies: [...(block.tableDependencies ?? []), ...(block.rawTableRefs ?? []), ...(block.refDependencies ?? [])],
    }),
  };
}

export function datasetBindingAuthorityForManifestBlock(input: {
  block: ManifestBlock;
  sourceId: string;
  sourceRevision: string;
  runtimeSnapshotId: string;
  activeTargetFingerprint: string;
  parameterValues?: Record<string, unknown>;
}): DatasetBindingAuthority | undefined {
  const material = datasetBlockProofMaterial(input);
  if (!material) return undefined;
  return {
    runtimeSnapshotId: input.runtimeSnapshotId,
    proofSnapshotId: material.scope.snapshotId,
    proofSnapshotFingerprint: material.scope.snapshotFingerprint,
    activeTargetFingerprint: input.activeTargetFingerprint,
  };
}

/**
 * Convert one compiled DQL declaration into the field catalog App Studio
 * consumes. Catalog discovery deliberately has no target authority. In that
 * state a source keeps its declared lifecycle and is labelled
 * `target_required`; it is not silently demoted to a draft or upgraded by a
 * preview. A runtime/preflight caller supplies a binding authority and gets a
 * positive `valid` state only after every proof component matches.
 */
export function datasetDescriptorFromManifestBlock(input: {
  block: ManifestBlock;
  sourceId: string;
  sourceRevision: string;
  proofs: ReadonlyMap<string, DatasetGrainProofV1>;
  authority?: DatasetBindingAuthority;
  parameterValues?: Record<string, unknown>;
}): DatasetCatalogDescriptorResult {
  const { block, sourceId, sourceRevision, proofs, authority, parameterValues } = input;
  if (!block.datasetGrain || !block.datasetFields?.length || !block.datasetMeasures?.length) {
    return { proofState: 'not_a_dataset' };
  }
  const keyEvidence = block.datasetGrain.keyEvidence?.trim();
  const proof = keyEvidence ? proofs.get(keyEvidence) : undefined;
  const material = datasetBlockProofMaterial({ block, sourceId, sourceRevision, parameterValues });
  // The early guard above means material always exists. Keeping the fallback
  // defensive makes future declaration changes fail closed.
  if (!material) return { proofState: 'not_a_dataset' };
  const { queryFingerprint, keyFingerprint, parameterFingerprint, contractFingerprint, scope } = material;
  const authorityMatchesScope = authority
    && authority.proofSnapshotId === scope.snapshotId
    && authority.proofSnapshotFingerprint === scope.snapshotFingerprint;
  const proofValidation = authorityMatchesScope
    ? validateDatasetGrainProof({
      proof,
      sourceFingerprint: sourceRevision,
      queryFingerprint,
      keyFingerprint,
      parameterFingerprint,
      targetFingerprint: authority.activeTargetFingerprint,
      snapshotId: authority.proofSnapshotId,
      snapshotFingerprint: authority.proofSnapshotFingerprint,
    })
    : undefined;
  const proofState: DatasetProofState = !authority
    ? 'target_required'
    : !authorityMatchesScope
      ? 'stale'
      : proofValidation?.valid
        ? 'valid'
        : proofValidation?.reason === 'missing'
          ? 'missing'
          : isStaleProofReason(proofValidation?.reason)
            ? 'stale'
            : 'invalid';
  const declaredLifecycle = lifecycleFromBlockStatus(block.status);
  const calculatedMeasures = block.datasetMeasures.map((measure) => {
    if (!measure.expression?.trim()) return { measure };
    try {
      const parsed = parseDatasetAggregateExpression({
        expression: measure.expression,
        physicalFields: block.datasetFields!.map((field) => field.name),
        allowCountStar: measure.aggregation === 'count' && measure.from === '*',
      });
      if (parsed.aggregation !== measure.aggregation) {
        return { measure, error: `Calculated measure ${measure.name} declares ${measure.aggregation}, but its reviewed expression resolves to ${parsed.aggregation}.` };
      }
      return { measure, parsed };
    } catch (error) {
      return { measure, error: error instanceof Error ? error.message : `Calculated measure ${measure.name} is invalid.` };
    }
  });
  const calculatedFailure = calculatedMeasures.find((candidate) => candidate.error);
  if (calculatedFailure?.error) return { proofState: 'not_a_dataset', reason: `calculated_expression_invalid:${calculatedFailure.error}` };
  const proofValid = proofState === 'valid';
  const sourceDeclaredCertified = declaredLifecycle === 'certified';
  const descriptor: DatasetDescriptor = {
    version: 1,
    id: sourceId,
    kind: 'block',
    sourceRevision,
    // This value reflects the server binding when present. A catalog never
    // borrows it from a stored proof.
    snapshotId: authority?.runtimeSnapshotId ?? 'target-required',
    contractRef: {
      kind: 'block_source',
      id: `${block.domain ?? 'global'}::block::${block.name}`,
      fingerprint: contractFingerprint,
    },
    binding: {
      sourceQualifiedId: `${block.domain ?? 'global'}::block::${block.name}`,
      sourceRevision,
      contractFingerprint,
      state: proofState === 'target_required' ? 'target_required' : proofState === 'valid' ? 'valid' : proofState === 'stale' ? 'stale' : proofState === 'missing' ? 'missing' : 'invalid',
      ...(authority ? {
        activeSnapshotId: authority.runtimeSnapshotId,
        activeSnapshotFingerprint: authority.proofSnapshotFingerprint,
        activeTargetFingerprint: authority.activeTargetFingerprint,
      } : {}),
      ...(proof?.id ? { proofId: proof.id } : {}),
    },
    label: block.name,
    domain: block.domain,
    // Source lifecycle says what was declared; the binding says whether it is
    // currently executable. Do not fabricate a draft state for a certified
    // source merely because no connection has been selected yet.
    lifecycle: declaredLifecycle,
    trust: sourceDeclaredCertified && (!authority || proofValid) ? 'certified' : 'review_required',
    grain: {
      entityIds: block.datasetGrain.entities,
      keyFields: block.datasetGrain.keys,
      keyEvidence,
      timeGrain: block.datasetGrain.timeGrain,
      timeBucketBy: block.datasetGrain.timeBucketBy,
      aggregate: block.datasetGrain.aggregate,
      description: block.datasetGrain.description,
    },
    fields: [
      ...block.datasetFields.map((field) => ({
        kind: 'physical' as const,
        name: field.name,
        qualifiedId: `${sourceId}::field::${field.name}`,
        type: field.type ?? 'string',
        role: field.role,
        status: field.status ?? 'approved',
        ...(field.role === 'time' ? { time: { grains: field.grains ?? [], primary: field.primary } } : {}),
        ...(field.hierarchy && typeof field.level === 'number' ? { hierarchy: { id: field.hierarchy, level: field.level } } : {}),
      })),
      ...calculatedMeasures.map(({ measure, parsed }) => ({
        kind: 'measure' as const,
        name: measure.name,
        qualifiedId: `${sourceId}::measure::${measure.name}`,
        aggregation: measure.aggregation,
        from: measure.from,
        numerator: measure.numerator,
        denominator: measure.denominator,
        ...(parsed ? { expression: parsed.expression, expressionFingerprint: parsed.fingerprint } : {}),
        timeBucketBy: measure.timeBucketBy,
        dependsOn: parsed
          ? parsed.dependencies
          : measure.aggregation === 'ratio'
          ? [measure.numerator, measure.denominator].filter((value): value is string => Boolean(value))
          : measure.from ? [measure.from] : [],
        additivity: {
          entities: measure.entityAdditive ?? measure.additive,
          time: measure.additive,
        },
        allowedAggs: measure.allowedAggs ?? [],
        format: measure.format ? { kind: measure.format, currency: measure.currency } : undefined,
        status: measure.status ?? 'approved',
      })),
    ],
    operations: blockDatasetOperations(block),
    execution: { route: sourceDeclaredCertified && proofValid ? 'certified' : 'governed_sql' },
  };
  return {
    descriptor,
    proof,
    proofState,
    ...(proofState === 'valid' || proofState === 'target_required'
      ? {}
      : { reason: proofValidation?.reason ?? 'scope_mismatch' }),
  };
}

/**
 * Project one exact `semantic_metric.payload.analyticalCapability` into a
 * dataset. No default metric operations are invented here: every exposed field
 * and operation originates in the immutable metric contract assembled by the
 * semantic layer.
 */
export function datasetDescriptorFromSemanticMetric(
  input: SemanticMetricDatasetProjectionInput,
): DatasetCatalogDescriptorResult {
  return datasetDescriptorFromSemanticMetrics({
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    semanticModelId: input.capability.semanticModelId ?? input.capability.metricId,
    label: input.label,
    domain: input.domain,
    lifecycle: input.lifecycle,
    measures: [{
      measureName: input.measureName,
      semanticReference: input.semanticReference,
      capability: input.capability,
      fields: input.fields,
    }],
  });
}

/**
 * Project compatible metric capabilities into one semantic Dataset.  It is a
 * source model, not an aggregation of trust: every field selection is still
 * checked against the selected metric's original contract at execution time.
 */
export function datasetDescriptorFromSemanticMetrics(
  input: SemanticMetricsDatasetProjectionInput,
): DatasetCatalogDescriptorResult {
  if (!input.semanticModelId.trim() || input.measures.length === 0) {
    return { proofState: 'not_a_dataset', reason: 'semantic_capability_incomplete' };
  }
  const seenMeasureNames = new Set<string>();
  const seenMetricIds = new Set<string>();
  const physicalByName = new Map<string, SemanticDatasetFieldProjection>();
  const semanticRoutes: Array<{ adapterId?: string }> = [];
  const aggregations: Array<'sum' | 'count' | 'count_distinct' | 'ratio' | 'avg' | 'min' | 'max'> = [];
  for (const projection of input.measures) {
    const route = projection.capability.executionCapabilities.find((candidate) => candidate.route === 'semantic');
    const aggregation = datasetAggregation(projection.capability.aggregation);
    const measureName = projection.measureName.trim();
    const semanticReference = projection.semanticReference.trim();
    if (!route || !aggregation || !measureName || !semanticReference
      || seenMeasureNames.has(measureName.toLowerCase())
      || seenMetricIds.has(projection.capability.metricId)
      || (projection.capability.semanticModelId && projection.capability.semanticModelId !== input.semanticModelId)
      || projection.fields.some((field) => !field.name.trim() || !field.qualifiedId.trim())) {
      return { proofState: 'not_a_dataset', reason: 'semantic_capability_incomplete' };
    }
    seenMeasureNames.add(measureName.toLowerCase());
    seenMetricIds.add(projection.capability.metricId);
    semanticRoutes.push({ adapterId: route.adapterId });
    aggregations.push(aggregation);
    for (const field of projection.fields) {
      const fieldName = field.name.trim().toLowerCase();
      const existing = physicalByName.get(fieldName);
      // A display name can only resolve to one physical identity in a Dataset.
      // Splitting incompatible capabilities is safer than choosing by order.
      if (existing && (existing.qualifiedId !== field.qualifiedId
        || existing.semanticReference !== field.semanticReference
        || existing.type !== field.type
        || existing.role !== field.role
        || !sameTimeContract(existing.time, field.time))) {
        return { proofState: 'not_a_dataset', reason: 'semantic_field_ambiguous' };
      }
      if (!existing) physicalByName.set(fieldName, { ...field, name: field.name.trim(), qualifiedId: field.qualifiedId.trim() });
    }
  }
  const adapterIds = new Set(semanticRoutes.map((route) => route.adapterId ?? ''));
  if (adapterIds.size !== 1) {
    return { proofState: 'not_a_dataset', reason: 'semantic_adapter_incompatible' };
  }
  const physical = [...physicalByName.values()].sort((left, right) => left.name.localeCompare(right.name));
  const hasPhysicalFields = physical.length > 0;
  const hasGroupFields = physical.some((field) => ['dimension', 'key', 'time', 'attribute'].includes(field.role));
  const hasTimeField = physical.some((field) => field.role === 'time' && (field.time?.grains.length ?? 0) > 0);
  // A Dataset operation is advertised only when every measure in this model
  // declares it.  This prevents a field-builder source from silently granting
  // an operation because one neighbouring metric happened to support it.
  const [firstOperations, ...remainingOperations] = input.measures
    .map((projection) => new Set(projection.capability.operations));
  let commonOperations = new Set(firstOperations ?? []);
  for (const candidateOperations of remainingOperations) {
    commonOperations = new Set([...commonOperations].filter((operation) => candidateOperations.has(operation)));
  }
  const operations: DatasetOperation[] = [];
  if (commonOperations.has('filter') && hasPhysicalFields) operations.push('filter');
  if (commonOperations.has('group') && hasGroupFields) operations.push('group');
  if (commonOperations.has('trend') && hasTimeField) operations.push('trend');
  if (commonOperations.has('compare') && hasTimeField) operations.push('compare');
  if (commonOperations.has('rank') && hasGroupFields) operations.push('rank');
  if (commonOperations.has('having')) operations.push('having');
  // Comparison needs an explicit calendar interaction and detail needs an
  // evidence-backed physical grain. Neither is implied by semantic metadata.
  const entityIds = Array.from(new Set(input.measures.map((projection) => projection.capability.primaryEntityId))).sort();
  const descriptor: DatasetDescriptor = {
    version: 1,
    id: input.sourceId,
    kind: 'semantic',
    sourceRevision: input.sourceRevision,
    snapshotId: 'target-required',
    contractRef: {
      kind: 'semantic_model',
      id: input.semanticModelId,
      fingerprint: input.sourceRevision,
    },
    binding: {
      sourceQualifiedId: input.semanticModelId,
      sourceRevision: input.sourceRevision,
      contractFingerprint: input.sourceRevision,
      state: 'target_required',
    },
    label: input.label,
    domain: input.domain,
    lifecycle: input.lifecycle,
    trust: input.lifecycle === 'certified' ? 'certified' : 'review_required',
    grain: {
      entityIds,
      keyFields: [],
      description: `Semantic model ${input.semanticModelId}`,
    },
    fields: [
      ...physical.map((field) => ({ kind: 'physical' as const, ...field })),
      ...input.measures.map((projection, index) => ({
        kind: 'measure' as const,
        name: projection.measureName.trim(),
        qualifiedId: `${input.sourceId}::measure::${projection.capability.metricId}`,
        semanticReference: projection.semanticReference.trim(),
        aggregation: aggregations[index]!,
        dependsOn: [],
        additivity: projection.capability.additivity,
        allowedAggs: [aggregations[index]!],
        format: projection.format,
        metricId: projection.capability.metricId,
        status: 'approved' as const,
      })),
    ],
    operations,
    execution: { route: 'semantic', adapterId: semanticRoutes[0]?.adapterId },
  };
  return { descriptor, proofState: 'target_required' };
}

function sameTimeContract(
  left: SemanticDatasetFieldProjection['time'],
  right: SemanticDatasetFieldProjection['time'],
): boolean {
  const leftGrains = [...(left?.grains ?? [])].sort();
  const rightGrains = [...(right?.grains ?? [])].sort();
  return left?.primary === right?.primary
    && leftGrains.length === rightGrains.length
    && leftGrains.every((grain, index) => grain === rightGrains[index]);
}

function blockDatasetOperations(block: ManifestBlock): DatasetOperation[] {
  const physical = block.datasetFields ?? [];
  const approvedPhysical = physical.filter((field) => (field.status ?? 'approved') === 'approved');
  const approvedGroupFields = approvedPhysical.filter((field) => ['dimension', 'key', 'time', 'attribute'].includes(field.role));
  const approvedMeasures = (block.datasetMeasures ?? []).filter((measure) =>
    (measure.status ?? 'approved') === 'approved'
    && Boolean(measure.allowedAggs?.includes(measure.aggregation)));
  const operations: DatasetOperation[] = [];
  const aggregateContractReady = !block.datasetGrain?.aggregate || aggregateDatasetRollupContractReady(block, approvedPhysical);
  // Each operation is projected from an explicitly typed physical/measure
  // contract. There is no permissive default list for a partial declaration.
  if (approvedPhysical.length > 0) operations.push('filter');
  if (aggregateContractReady && approvedGroupFields.length > 0 && approvedMeasures.length > 0) operations.push('group');
  if (aggregateContractReady && approvedMeasures.length > 0 && approvedGroupFields.length > 0) operations.push('rank');
  if (approvedMeasures.length > 0) operations.push('having');
  if (aggregateContractReady && approvedMeasures.length > 0 && approvedPhysical.some((field) => field.role === 'time' && (field.grains?.length ?? 0) > 0)) operations.push('trend');
  // Calendar/timezone/completeness still have to be explicit in a TileQuery,
  // but an approved physical time field lets the App offer a comparison
  // control. The runtime resolves its period contract again on each run.
  if (aggregateContractReady && approvedMeasures.length > 0 && approvedPhysical.some((field) => field.role === 'time' && (field.grains?.length ?? 0) > 0)) operations.push('compare');
  // Detail is a declared source capability, separate from current execution
  // eligibility. Discovery and draft composition must retain an author’s
  // bounded detail selection while the source is disconnected; the runtime
  // independently requires a current full-source grain proof before it can
  // execute that selection. Treating `target_required` as a missing operation
  // made a successful source validation impossible to use without a catalog
  // rebuild and invited browsers to invent their own capability state.
  const declaredKeys = block.datasetGrain?.keys ?? [];
  const approvedKeyNames = new Set(approvedPhysical
    .filter((field) => field.role === 'key')
    .map((field) => field.name));
  if (!block.datasetGrain?.aggregate
    && Boolean(block.datasetGrain?.keyEvidence?.trim())
    && declaredKeys.length > 0
    && declaredKeys.every((key) => approvedKeyNames.has(key))) {
    operations.push('detail');
  }
  return operations;
}

/**
 * An aggregate Dataset must name the exact time bucket in its native grain.
 * The runtime separately validates the keyEvidence against the live target;
 * this catalog projection only decides whether grouping controls can be shown.
 */
function aggregateDatasetRollupContractReady(
  block: ManifestBlock,
  physical: NonNullable<ManifestBlock['datasetFields']>,
): boolean {
  const grain = block.datasetGrain;
  if (!grain?.aggregate || !grain.keyEvidence?.trim() || !grain.timeGrain || !grain.timeBucketBy) return false;
  const bucket = physical.find((field) => field.name.toLowerCase() === grain.timeBucketBy!.toLowerCase());
  return Boolean(bucket
    && bucket.role === 'time'
    && bucket.grains?.includes(grain.timeGrain)
    && grain.keys.some((key) => key.toLowerCase() === grain.timeBucketBy!.toLowerCase()));
}

function datasetAggregation(value: string): 'sum' | 'count' | 'count_distinct' | 'ratio' | 'avg' | 'min' | 'max' | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === 'sum' || normalized === 'count' || normalized === 'count_distinct' || normalized === 'ratio' || normalized === 'avg' || normalized === 'min' || normalized === 'max'
    ? normalized
    : undefined;
}

function isStaleProofReason(reason: ReturnType<typeof validateDatasetGrainProof>['reason'] | undefined): boolean {
  return reason === 'source_mismatch'
    || reason === 'query_mismatch'
    || reason === 'key_mismatch'
    || reason === 'target_mismatch'
    || reason === 'snapshot_mismatch';
}

function lifecycleFromBlockStatus(status: string | undefined): DatasetDescriptor['lifecycle'] {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'certified') return 'certified';
  if (normalized === 'review' || normalized === 'review_required') return 'review';
  if (normalized === 'pending_recertification') return 'pending_recertification';
  if (normalized === 'deprecated') return 'deprecated';
  if (normalized === 'draft') return 'draft';
  return 'unknown';
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}
