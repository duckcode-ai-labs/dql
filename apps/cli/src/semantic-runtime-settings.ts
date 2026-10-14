import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WarehouseTargetContextV1, WarehouseTargetIdentityV1 } from '@zlens/core';

export type SemanticRuntimePreference = 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud';
export type SemanticRuntimeTestState = 'missing' | 'configured' | 'passed' | 'failed';

export interface DbtCloudSemanticSettingsInput {
  host?: string;
  environmentId?: string;
  serviceToken?: string;
}

export interface SemanticRuntimeSettingsInput {
  preference?: SemanticRuntimePreference;
  dbtCloud?: DbtCloudSemanticSettingsInput;
}

interface StoredDbtCloudSemanticSettings {
  host?: string;
  environmentId?: string;
  serviceToken?: string;
  testedFingerprint?: string;
  testState?: 'passed' | 'failed';
  testedAt?: string;
  testMessage?: string;
  dialect?: string;
  metricCount?: number;
  metricNames?: string[];
  semanticCatalogFingerprint?: string;
  metricInventoryComplete?: boolean;
  executionTargetFingerprint?: string;
  executionTargetContext?: WarehouseTargetContextV1;
}

interface StoredSemanticRuntimeSettings {
  version: 1;
  preference?: SemanticRuntimePreference;
  dbtCloud?: StoredDbtCloudSemanticSettings;
}

export interface EffectiveDbtCloudSemanticSettings {
  host?: string;
  endpoint?: string;
  environmentId?: string;
  serviceToken?: string;
  source: 'local' | 'env' | 'none';
  configured: boolean;
  fingerprint?: string;
  testState: SemanticRuntimeTestState;
  testedAt?: string;
  testMessage?: string;
  dialect?: string;
  metricCount?: number;
  metricNames?: string[];
  semanticCatalogFingerprint?: string;
  metricInventoryComplete?: boolean;
  executionTargetFingerprint?: string;
  executionTargetContext?: WarehouseTargetContextV1;
}

export interface RedactedSemanticRuntimeSettings {
  preference: SemanticRuntimePreference;
  dbtCloud: {
    host?: string;
    environmentId?: string;
    hasServiceToken: boolean;
    serviceTokenPreview?: string;
    source: 'local' | 'env' | 'none';
    configured: boolean;
    testState: SemanticRuntimeTestState;
    testedAt?: string;
    testMessage?: string;
    dialect?: string;
    metricCount?: number;
    semanticCatalogFingerprint?: string;
    metricInventoryState: 'missing' | 'partial' | 'complete';
    executionTargetFingerprint?: string;
    executionTargetContext?: WarehouseTargetContextV1;
    targetBindingState: 'missing' | 'bound';
    envVars: string[];
  };
}

const HOST_ENV_VARS = ['DBT_CLOUD_SEMANTIC_LAYER_HOST', 'DBT_SEMANTIC_LAYER_HOST'] as const;
const ENVIRONMENT_ENV_VARS = ['DBT_CLOUD_ENVIRONMENT_ID', 'DBT_SEMANTIC_LAYER_ENVIRONMENT_ID'] as const;
const TOKEN_ENV_VARS = ['DBT_CLOUD_SERVICE_TOKEN', 'DBT_SEMANTIC_LAYER_TOKEN'] as const;

export function semanticRuntimeSettingsPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'semantic-runtime-settings.json');
}

export function getSemanticRuntimeSettings(projectRoot: string): RedactedSemanticRuntimeSettings {
  const stored = readStored(projectRoot);
  const effective = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const localToken = stored.dbtCloud?.serviceToken?.trim();
  return {
    preference: stored.preference ?? 'auto',
    dbtCloud: {
      host: effective.host,
      environmentId: effective.environmentId,
      hasServiceToken: Boolean(effective.serviceToken),
      serviceTokenPreview: localToken
        ? previewSecret(localToken)
        : effective.source === 'env'
          ? `${firstPresentEnvName(TOKEN_ENV_VARS) ?? 'DBT_CLOUD_SERVICE_TOKEN'}=set`
          : undefined,
      source: effective.source,
      configured: effective.configured,
      testState: effective.testState,
      testedAt: effective.testedAt,
      testMessage: effective.testMessage,
      dialect: effective.dialect,
      metricCount: effective.metricCount,
      semanticCatalogFingerprint: effective.semanticCatalogFingerprint,
      metricInventoryState: !effective.metricNames
        ? 'missing'
        : effective.metricInventoryComplete
          ? 'complete'
          : 'partial',
      executionTargetFingerprint: effective.executionTargetFingerprint,
      executionTargetContext: effective.executionTargetContext,
      targetBindingState: effective.executionTargetFingerprint ? 'bound' : 'missing',
      envVars: [...HOST_ENV_VARS, ...ENVIRONMENT_ENV_VARS, ...TOKEN_ENV_VARS],
    },
  };
}

export function getEffectiveDbtCloudSemanticSettings(projectRoot: string): EffectiveDbtCloudSemanticSettings {
  const stored = readStored(projectRoot);
  const local = stored.dbtCloud;
  const envHost = firstPresentEnv(HOST_ENV_VARS);
  const envEnvironmentId = firstPresentEnv(ENVIRONMENT_ENV_VARS);
  const envToken = firstPresentEnv(TOKEN_ENV_VARS);
  const host = normalizeDbtCloudHost(local?.host || envHost);
  const environmentId = local?.environmentId?.trim() || envEnvironmentId?.trim() || undefined;
  const serviceToken = local?.serviceToken?.trim() || envToken?.trim() || undefined;
  const configured = Boolean(host && environmentId && serviceToken);
  const fingerprint = host && environmentId && serviceToken
    ? semanticRuntimeFingerprint({ host, environmentId, serviceToken })
    : undefined;
  const locallyTested = Boolean(fingerprint && local?.testedFingerprint === fingerprint);
  const testState: SemanticRuntimeTestState = !configured
    ? 'missing'
    : locallyTested && local?.testState
      ? local.testState
      : 'configured';
  return {
    host,
    endpoint: host ? semanticLayerGraphqlEndpoint(host) : undefined,
    environmentId,
    serviceToken,
    source: local?.host || local?.environmentId || local?.serviceToken ? 'local' : envHost || envEnvironmentId || envToken ? 'env' : 'none',
    configured,
    fingerprint,
    testState,
    testedAt: locallyTested ? local?.testedAt : undefined,
    testMessage: locallyTested ? local?.testMessage : undefined,
    dialect: locallyTested ? local?.dialect : undefined,
    metricCount: locallyTested ? local?.metricCount : undefined,
    metricNames: locallyTested && Array.isArray(local?.metricNames)
      ? local.metricNames.filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
      : undefined,
    semanticCatalogFingerprint: locallyTested ? local?.semanticCatalogFingerprint : undefined,
    metricInventoryComplete: locallyTested ? local?.metricInventoryComplete : undefined,
    executionTargetFingerprint: locallyTested ? local?.executionTargetFingerprint : undefined,
    executionTargetContext: locallyTested ? local?.executionTargetContext : undefined,
  };
}

export function saveTestedSemanticRuntimeSettings(
  projectRoot: string,
  input: SemanticRuntimeSettingsInput,
  test: {
    ok: boolean;
    message: string;
    dialect?: string;
    metricCount?: number;
    metricNames?: string[];
    semanticCatalogFingerprint?: string;
    metricInventoryComplete?: boolean;
  },
  executionTarget?: WarehouseTargetIdentityV1,
): RedactedSemanticRuntimeSettings {
  if (!test.ok) throw new Error(test.message || 'dbt Cloud Semantic Layer test failed.');
  const stored = readStored(projectRoot);
  const existing = stored.dbtCloud;
  const host = normalizeDbtCloudHost(input.dbtCloud?.host === undefined ? existing?.host : input.dbtCloud.host);
  const environmentId = input.dbtCloud?.environmentId === undefined
    ? existing?.environmentId
    : input.dbtCloud.environmentId.trim() || undefined;
  const serviceToken = input.dbtCloud?.serviceToken === undefined || input.dbtCloud.serviceToken.trim() === ''
    ? existing?.serviceToken
    : input.dbtCloud.serviceToken.trim();
  const effectiveHost = host || firstPresentEnv(HOST_ENV_VARS);
  const effectiveEnvironmentId = environmentId || firstPresentEnv(ENVIRONMENT_ENV_VARS);
  const effectiveToken = serviceToken || firstPresentEnv(TOKEN_ENV_VARS);
  if (!effectiveHost || !effectiveEnvironmentId || !effectiveToken) {
    throw new Error('dbt Cloud Semantic Layer requires Host, Environment ID, and Service Token.');
  }
  const testedFingerprint = semanticRuntimeFingerprint({
    host: effectiveHost,
    environmentId: effectiveEnvironmentId,
    serviceToken: effectiveToken,
  });
  stored.preference = input.preference ?? stored.preference ?? 'auto';
  stored.dbtCloud = {
    host,
    environmentId,
    serviceToken,
    testedFingerprint,
    testState: 'passed',
    testedAt: new Date().toISOString(),
    testMessage: test.message,
    dialect: test.dialect,
    metricCount: test.metricCount,
    metricNames: test.metricNames,
    semanticCatalogFingerprint: test.semanticCatalogFingerprint,
    metricInventoryComplete: test.metricInventoryComplete,
    executionTargetFingerprint: executionTarget?.identityFingerprint,
    executionTargetContext: executionTarget?.redactedContext,
  };
  writeStored(projectRoot, stored);
  return getSemanticRuntimeSettings(projectRoot);
}

/**
 * Persist ONLY the runtime preference (auto / native / metricflow-cli /
 * dbt-cloud). Unlike saveTestedSemanticRuntimeSettings this requires no dbt
 * Cloud test, so a user can prefer Native or Local MetricFlow without any
 * cloud credentials configured.
 */
export function saveSemanticRuntimePreference(
  projectRoot: string,
  preference: SemanticRuntimePreference,
): RedactedSemanticRuntimeSettings {
  const stored = readStored(projectRoot);
  stored.preference = preference;
  writeStored(projectRoot, stored);
  return getSemanticRuntimeSettings(projectRoot);
}

export function semanticRuntimeDraft(
  projectRoot: string,
  input: SemanticRuntimeSettingsInput,
): EffectiveDbtCloudSemanticSettings {
  const current = getEffectiveDbtCloudSemanticSettings(projectRoot);
  const host = normalizeDbtCloudHost(input.dbtCloud?.host === undefined ? current.host : input.dbtCloud.host);
  const environmentId = input.dbtCloud?.environmentId === undefined
    ? current.environmentId
    : input.dbtCloud.environmentId.trim() || undefined;
  const serviceToken = input.dbtCloud?.serviceToken === undefined || input.dbtCloud.serviceToken.trim() === ''
    ? current.serviceToken
    : input.dbtCloud.serviceToken.trim();
  const configured = Boolean(host && environmentId && serviceToken);
  return {
    host,
    endpoint: host ? semanticLayerGraphqlEndpoint(host) : undefined,
    environmentId,
    serviceToken,
    source: current.source,
    configured,
    fingerprint: configured ? semanticRuntimeFingerprint({ host: host!, environmentId: environmentId!, serviceToken: serviceToken! }) : undefined,
    testState: configured ? 'configured' : 'missing',
  };
}

export function semanticLayerGraphqlEndpoint(host: string): string {
  const normalized = normalizeDbtCloudHost(host)!;
  return normalized.endsWith('/api/graphql') ? normalized : `${normalized}/api/graphql`;
}

export function normalizeDbtCloudHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function semanticRuntimeFingerprint(input: { host: string; environmentId: string; serviceToken: string }): string {
  return createHash('sha256')
    .update(`${normalizeDbtCloudHost(input.host)}\n${input.environmentId.trim()}\n${input.serviceToken.trim()}`)
    .digest('hex');
}

function readStored(projectRoot: string): StoredSemanticRuntimeSettings {
  const path = semanticRuntimeSettingsPath(projectRoot);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredSemanticRuntimeSettings;
    return {
      version: 1,
      preference: isSemanticRuntimePreference(parsed.preference) ? parsed.preference : undefined,
      dbtCloud: parsed.dbtCloud && typeof parsed.dbtCloud === 'object' ? parsed.dbtCloud : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

function writeStored(projectRoot: string, settings: StoredSemanticRuntimeSettings): void {
  const path = semanticRuntimeSettingsPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort for filesystems that support POSIX permissions.
  }
}

function isSemanticRuntimePreference(value: unknown): value is SemanticRuntimePreference {
  return value === 'auto' || value === 'native' || value === 'metricflow-cli' || value === 'dbt-cloud';
}

function firstPresentEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function firstPresentEnvName(names: readonly string[]): string | undefined {
  return names.find((name) => Boolean(process.env[name]?.trim()));
}

function previewSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
