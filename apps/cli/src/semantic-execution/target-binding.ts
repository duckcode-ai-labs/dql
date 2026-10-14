import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compareWarehouseTargets,
  createSemanticTargetBinding,
  createWarehouseTargetIdentity,
  semanticExecutionFingerprint,
  type SemanticAdapterIdV1,
  type SemanticCompileTargetV1,
  type SemanticSnapshotRefV1,
  type SemanticTargetBindingV1,
  type WarehouseTargetIdentityV1,
  type WarehouseTargetMismatchV1,
} from '@zlens/core';
import { getEffectiveDbtCloudSemanticSettings } from '../semantic-runtime-settings.js';

export class SemanticExecutionTargetMismatchError extends Error {
  readonly code = 'EXECUTION_TARGET_MISMATCH';
  readonly details: {
    adapterId: SemanticAdapterIdV1;
    expectedTargetFingerprint: string;
    actualTargetFingerprint: string;
    mismatches: WarehouseTargetMismatchV1[];
  };

  constructor(input: {
    adapterId: SemanticAdapterIdV1;
    expected: WarehouseTargetIdentityV1;
    actual: WarehouseTargetIdentityV1;
    mismatches: WarehouseTargetMismatchV1[];
  }) {
    const fields = input.mismatches.map((item) => item.field).join(', ') || 'target fingerprint';
    super(
      `Semantic compilation target does not match the active warehouse execution target (${fields}). `
      + 'Select the matching ZLens connection or reapply the semantic runtime settings against this connection.',
    );
    this.name = 'SemanticExecutionTargetMismatchError';
    this.details = {
      adapterId: input.adapterId,
      expectedTargetFingerprint: input.expected.identityFingerprint,
      actualTargetFingerprint: input.actual.identityFingerprint,
      mismatches: input.mismatches,
    };
  }
}

export class SemanticAdapterDriftError extends Error {
  readonly code = 'SEMANTIC_ADAPTER_DRIFT';
  readonly details: { plannedAdapter: SemanticAdapterIdV1; compiledAdapter: SemanticAdapterIdV1 };

  constructor(plannedAdapter: SemanticAdapterIdV1, compiledAdapter: SemanticAdapterIdV1) {
    super(`Semantic planning selected ${plannedAdapter}, but compilation returned ${compiledAdapter}. Nothing was executed.`);
    this.name = 'SemanticAdapterDriftError';
    this.details = { plannedAdapter, compiledAdapter };
  }
}

export class SemanticSourceBindingMissingError extends Error {
  readonly code = 'SEMANTIC_SOURCE_DRIFT';
  readonly details: {
    adapterId: 'dbt-cloud';
    environmentId?: string;
    metricInventoryState: 'missing' | 'partial';
    safeActions: string[];
  };

  constructor(input: { environmentId?: string; metricInventoryState: 'missing' | 'partial' }) {
    super(
      'The dbt Cloud compiler target has no complete persisted metric inventory. '
      + 'Reapply dbt Cloud Semantic Layer settings after deploying the intended semantic project.',
    );
    this.name = 'SemanticSourceBindingMissingError';
    this.details = {
      adapterId: 'dbt-cloud',
      environmentId: input.environmentId,
      metricInventoryState: input.metricInventoryState,
      safeActions: ['refresh_snapshot', 'reapply_semantic_runtime'],
    };
  }
}

export interface MetricFlowTargetMetadata {
  expectedTarget?: WarehouseTargetIdentityV1;
  profileName?: string;
  targetName?: string;
  profilesPath?: string;
  runtimeVersion?: string;
}

export function assertSemanticExecutionTarget(input: {
  projectRoot: string;
  adapterId: SemanticAdapterIdV1;
  executionTarget: WarehouseTargetIdentityV1;
  metricFlow?: MetricFlowTargetMetadata;
}): WarehouseTargetIdentityV1 {
  const expected = expectedExecutionTarget(input);
  const mismatches = compareWarehouseTargets(expected, input.executionTarget);
  if (mismatches.length > 0) {
    throw new SemanticExecutionTargetMismatchError({
      adapterId: input.adapterId,
      expected,
      actual: input.executionTarget,
      mismatches,
    });
  }
  return expected;
}

export function buildSemanticTargetBinding(input: {
  projectRoot: string;
  adapterId: SemanticAdapterIdV1;
  executionTarget: WarehouseTargetIdentityV1;
  metricFlow?: MetricFlowTargetMetadata;
}): SemanticTargetBindingV1 {
  if (input.adapterId === 'dbt-cloud') {
    const cloud = getEffectiveDbtCloudSemanticSettings(input.projectRoot);
    if (!cloud.metricNames || !cloud.semanticCatalogFingerprint || !cloud.metricInventoryComplete) {
      throw new SemanticSourceBindingMissingError({
        environmentId: cloud.environmentId,
        metricInventoryState: cloud.metricNames ? 'partial' : 'missing',
      });
    }
  }
  const expected = assertSemanticExecutionTarget(input);
  const semanticSnapshot = semanticSnapshotForProject(input.projectRoot);
  const compileTarget = compileTargetFor(input, semanticSnapshot);
  const adapterImplementationFingerprint = semanticExecutionFingerprint({
    adapterId: input.adapterId,
    contract: 1,
    implementation: 'dql-cli-semantic-execution-gateway-v1',
  });
  const credentialRevision = input.adapterId === 'dbt-cloud'
    ? semanticExecutionFingerprint({
        testedAt: getEffectiveDbtCloudSemanticSettings(input.projectRoot).testedAt ?? 'unknown',
      })
    : 'credential-revision:not-applicable';
  return createSemanticTargetBinding({
    bindingId: `semantic-binding:${semanticExecutionFingerprint({
      adapterId: input.adapterId,
      snapshotId: semanticSnapshot.snapshotId,
      target: expected.identityFingerprint,
    }).slice(0, 24)}`,
    adapterId: input.adapterId,
    adapterImplementationFingerprint,
    credentialRevision,
    semanticSnapshot,
    compileTarget,
    executionTarget: input.executionTarget,
    proof: {
      status: 'verified',
      checks: [
        { kind: 'semantic_source', fingerprint: semanticSnapshot.sourceFingerprint },
        ...(compileTarget.kind === 'dbt_cloud_environment'
          ? [{ kind: 'semantic_catalog' as const, fingerprint: compileTarget.semanticCatalogFingerprint }]
          : []),
        { kind: 'adapter_target_pin', fingerprint: expected.identityFingerprint },
        { kind: 'dialect', fingerprint: semanticExecutionFingerprint(expected.dialect) },
        { kind: 'warehouse_context', fingerprint: semanticExecutionFingerprint(expected.redactedContext) },
      ],
    },
  });
}

function expectedExecutionTarget(input: {
  projectRoot: string;
  adapterId: SemanticAdapterIdV1;
  executionTarget: WarehouseTargetIdentityV1;
  metricFlow?: MetricFlowTargetMetadata;
}): WarehouseTargetIdentityV1 {
  if (input.adapterId === 'metricflow-cli' && input.metricFlow?.expectedTarget) {
    return input.metricFlow.expectedTarget;
  }
  if (input.adapterId === 'dbt-cloud') {
    const settings = getEffectiveDbtCloudSemanticSettings(input.projectRoot);
    if (!settings.executionTargetFingerprint || !settings.executionTargetContext) {
      throw new Error(
        'dbt Cloud Semantic Layer is tested but not bound to a warehouse execution target. '
        + 'Reapply the settings with the intended DQL warehouse connection active.',
      );
    }
    const expected = createWarehouseTargetIdentity({
      connectionRef: 'connection:dbt-cloud-bound-target',
      driver: settings.dialect ?? input.executionTarget.driver,
      dialect: settings.dialect ?? input.executionTarget.dialect,
      redactedContext: settings.executionTargetContext,
    });
    return {
      ...expected,
      identityFingerprint: settings.executionTargetFingerprint,
    };
  }
  return input.executionTarget;
}

function semanticSnapshotForProject(projectRoot: string): SemanticSnapshotRefV1 {
  const candidates: Array<{ path: string; kind: NonNullable<SemanticSnapshotRefV1['artifact']>['kind'] }> = [
    { path: join(projectRoot, 'target', 'semantic_manifest.json'), kind: 'semantic_manifest' },
    { path: join(projectRoot, 'target', 'manifest.json'), kind: 'manifest' },
    { path: join(projectRoot, 'semantic-layer'), kind: 'semantic_yaml' },
  ];
  const source = candidates.find((candidate) => existsSync(candidate.path));
  const fingerprint = source ? boundedPathFingerprint(source.path) : semanticExecutionFingerprint({
    projectRoot: resolve(projectRoot),
    state: 'semantic-source-missing',
  });
  return {
    version: 1,
    snapshotId: `semantic-snapshot:${fingerprint.slice(0, 24)}`,
    sourceFingerprint: fingerprint,
    semanticCatalogFingerprint: fingerprint,
    ...(source ? {
      artifact: {
        kind: source.kind,
        fingerprint,
        generatedAt: statSync(source.path).mtime.toISOString(),
      },
    } : {}),
  };
}

function compileTargetFor(
  input: {
    projectRoot: string;
    adapterId: SemanticAdapterIdV1;
    executionTarget: WarehouseTargetIdentityV1;
    metricFlow?: MetricFlowTargetMetadata;
  },
  snapshot: SemanticSnapshotRefV1,
): SemanticCompileTargetV1 {
  if (input.adapterId === 'dbt-cloud') {
    const settings = getEffectiveDbtCloudSemanticSettings(input.projectRoot);
    return {
      kind: 'dbt_cloud_environment',
      hostFingerprint: semanticExecutionFingerprint(settings.host ?? 'missing-host'),
      environmentId: settings.environmentId ?? 'missing-environment',
      semanticCatalogFingerprint: settings.semanticCatalogFingerprint
        ?? semanticExecutionFingerprint({
          environmentId: settings.environmentId ?? 'missing-environment',
          state: 'metric-inventory-unverified',
        }),
      dialect: settings.dialect ?? input.executionTarget.dialect,
    };
  }
  if (input.adapterId === 'metricflow-cli') {
    return {
      kind: 'metricflow_target',
      dbtProjectFingerprint: boundedPathFingerprint(resolve(input.projectRoot, '.')),
      profilesFingerprint: input.metricFlow?.profilesPath
        ? boundedPathFingerprint(input.metricFlow.profilesPath)
        : semanticExecutionFingerprint(input.metricFlow?.expectedTarget?.redactedContext ?? {}),
      profileName: input.metricFlow?.profileName ?? 'default',
      targetName: input.metricFlow?.targetName ?? 'default',
      semanticManifestFingerprint: snapshot.semanticCatalogFingerprint,
      runtimeVersion: input.metricFlow?.runtimeVersion ?? 'unknown',
      dialect: input.executionTarget.dialect,
    };
  }
  return {
    kind: 'native_snapshot',
    semanticLayerFingerprint: snapshot.semanticCatalogFingerprint,
    dialect: input.executionTarget.dialect,
  };
}

function boundedPathFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return semanticExecutionFingerprint({
        path: resolve(path),
        modifiedMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    const maxBytes = 64 * 1024 * 1024;
    if (stat.size > maxBytes) {
      return semanticExecutionFingerprint({
        path: resolve(path),
        modifiedMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return semanticExecutionFingerprint({ path: resolve(path), state: 'unreadable' });
  }
}
