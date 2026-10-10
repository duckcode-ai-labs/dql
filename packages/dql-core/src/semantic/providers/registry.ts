/**
 * Provider registry: resolves a SemanticLayerProviderConfig to a loaded SemanticLayer.
 * Supports auto-detection when no config is provided.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SemanticLayer } from '../semantic-layer.js';
import type { SemanticLayerProviderConfig } from './provider.js';
import { DqlProvider } from './dql-provider.js';
import { DbtProvider } from './dbt-provider.js';
import { CubejsProvider } from './cubejs-provider.js';
import { SnowflakeSemanticProvider, type SnowflakeQueryExecutor } from './snowflake-provider.js';
import { resolveRepoSource } from './repo-resolver.js';

export interface SemanticLayerResult {
  layer: SemanticLayer | undefined;
  errors: string[];
  /** Load notes that are not failures, e.g. dbt metrics read from YAML because the manifest lacks them. */
  diagnostics?: string[];
  detectedProvider?: string;
}

/**
 * Resolve the semantic layer from config, or auto-detect if no config is given.
 *
 * Auto-detection order:
 *  1. If explicit config is provided, use that provider.
 *  2. If `semantic-layer/` exists in projectRoot, use DQL native provider.
 *  3. If `dbt_project.yml` exists in projectRoot, use dbt provider.
 *  4. If `model/` or `schema/` with cube YAML exists, use cubejs provider.
 *  5. Otherwise return undefined.
 */
export function resolveSemanticLayer(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
): SemanticLayer | undefined {
  return resolveSemanticLayerWithDiagnostics(config, projectRoot).layer;
}

export function resolveSemanticLayerWithDiagnostics(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
): SemanticLayerResult {
  if (config) {
    return loadFromConfig(config, projectRoot);
  }

  return autoDetect(projectRoot);
}

/**
 * Async variant of resolveSemanticLayerWithDiagnostics.
 * Required for the Snowflake provider which needs a live query executor.
 * All other providers fall back to the sync path.
 */
export async function resolveSemanticLayerAsync(
  config: SemanticLayerProviderConfig | undefined,
  projectRoot: string,
  executeQuery?: SnowflakeQueryExecutor,
): Promise<SemanticLayerResult> {
  if (config?.provider === 'snowflake') {
    if (!executeQuery) {
      return { layer: undefined, errors: ['Snowflake provider requires a live query executor. Ensure the connection is initialised before calling resolveSemanticLayerAsync.'] };
    }
    try {
      let effectiveRoot = projectRoot;
      let effectiveConfig = config;
      if (config.source && config.source !== 'local' && config.repoUrl) {
        const resolved = resolveRepoSource(config, projectRoot);
        effectiveRoot = resolved.localPath;
        effectiveConfig = { ...config, projectPath: undefined };
      }
      const provider = new SnowflakeSemanticProvider(executeQuery);
      const layer = await provider.loadAsync(effectiveConfig, effectiveRoot);
      return { layer, errors: [] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { layer: undefined, errors: [`Failed to load snowflake semantic layer: ${msg}`] };
    }
  }
  return resolveSemanticLayerWithDiagnostics(config, projectRoot);
}

function autoDetect(projectRoot: string): SemanticLayerResult {
  // 1. Prefer dbt MetricFlow artifacts when present. Block Studio writes local
  // semantic-layer companion files for drafts, so native files alone should not
  // hide the authoritative dbt semantic model source.
  if (existsSync(join(projectRoot, 'dbt_project.yml')) && hasDbtSemanticArtifacts(projectRoot)) {
    const result = loadFromConfig({ provider: 'dbt' }, projectRoot);
    result.detectedProvider = 'dbt';
    return result;
  }

  // 2. DQL native semantic-layer/ directory
  const nativeDir = join(projectRoot, 'semantic-layer');
  if (existsSync(nativeDir)) {
    const result = loadFromConfig({ provider: 'dql' }, projectRoot);
    result.detectedProvider = 'dql';
    return result;
  }

  // 3. dbt project (dbt_project.yml in root)
  if (existsSync(join(projectRoot, 'dbt_project.yml'))) {
    const result = loadFromConfig({ provider: 'dbt' }, projectRoot);
    result.detectedProvider = 'dbt';
    return result;
  }

  // 4. Cube.js project (model/ or schema/ directory)
  for (const candidate of ['model', 'schema']) {
    if (existsSync(join(projectRoot, candidate))) {
      const result = loadFromConfig({ provider: 'cubejs' }, projectRoot);
      result.detectedProvider = 'cubejs';
      return result;
    }
  }

  return { layer: undefined, errors: [] };
}

function hasDbtSemanticArtifacts(projectRoot: string): boolean {
  // dbt writes both artifacts on every parse, with empty semantic_models and
  // metrics when a project defines none; only a defined model or metric counts.
  const entries = (value: unknown): number => Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
  for (const file of ['target/semantic_manifest.json', 'target/manifest.json']) {
    const path = join(projectRoot, file);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (entries(parsed.semantic_models) > 0 || entries(parsed.metrics) > 0) return true;
    } catch {
      // Continue to YAML discovery below.
    }
  }
  return hasDbtSemanticYaml(projectRoot);
}

function hasDbtSemanticYaml(projectRoot: string): boolean {
  const stack = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dql' || entry.name === 'target') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !/\.(ya?ml)$/i.test(entry.name)) continue;
      try {
        if (statSync(full).size > 2_000_000) continue;
        const content = readFileSync(full, 'utf-8');
        if (/\bsemantic_models\s*:/.test(content) || /\bmetrics\s*:/.test(content)) return true;
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  return false;
}

function loadFromConfig(
  config: SemanticLayerProviderConfig,
  projectRoot: string,
): SemanticLayerResult {
  const errors: string[] = [];

  try {
    // Resolve remote repo source to a local path if needed
    let effectiveRoot = projectRoot;
    if (config.source && config.source !== 'local' && config.repoUrl) {
      const resolved = resolveRepoSource(config, projectRoot);
      effectiveRoot = resolved.localPath;
      if (resolved.warnings.length > 0) {
        errors.push(...resolved.warnings);
      }
      // When using a remote source, the provider should read from the resolved
      // root directly — clear projectPath so the provider doesn't double-join.
      config = { ...config, projectPath: undefined };
    }

    switch (config.provider) {
      case 'dql': {
        const provider = new DqlProvider();
        return { layer: provider.load(config, effectiveRoot), errors };
      }
      case 'dbt': {
        const provider = new DbtProvider();
        const layer = provider.load(config, effectiveRoot);
        return { layer, errors, diagnostics: layer.getDiagnostics() };
      }
      case 'cubejs': {
        const provider = new CubejsProvider();
        return { layer: provider.load(config, effectiveRoot), errors };
      }
      case 'snowflake': {
        errors.push('Snowflake semantic views provider requires a live connection. Use the SnowflakeSemanticProvider directly.');
        return { layer: undefined, errors };
      }
      case 'lookml': {
        errors.push('LookML provider is not yet implemented. Use provider "dql", "dbt", or "cubejs".');
        return { layer: undefined, errors };
      }
      default:
        errors.push(`Unknown semantic layer provider: "${config.provider}". Supported: dql, dbt, cubejs, snowflake, lookml.`);
        return { layer: undefined, errors };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to load ${config.provider} semantic layer: ${msg}`);
    return { layer: undefined, errors };
  }
}
