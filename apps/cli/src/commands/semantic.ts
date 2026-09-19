/**
 * `dql semantic` CLI subcommands:
 *   dql semantic list [path]       — List metrics, dimensions, hierarchies
 *   dql semantic validate [path]   — Validate semantic layer definitions
 *   dql semantic query [path]      — Compose a SQL query from metric/dimension names
 *   dql semantic pull [path]       — Pull/refresh a remote semantic layer repo cache
 *   dql semantic import <provider> [path] — Import provider metadata into local semantic-layer YAML
 *   dql semantic sync [path]       — Re-run the last semantic import from manifest
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  resolveSemanticLayerWithDiagnostics,
  pullCachedRepo,
} from '@duckcodeailabs/dql-core';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection, resolveProjectSemanticConfig } from '../local-runtime.js';
import { loadSemanticImportManifest, performSemanticImport, syncSemanticImport } from '../semantic-import.js';

export async function runSemantic(
  subcommand: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const targetArg = subcommand === 'import'
    ? (rest[1] ?? '.')
    : subcommand === 'query'
      ? '.'
      : (rest[0] ?? '.');
  const baseDir = resolve(targetArg);
  const projectRoot = findProjectRoot(baseDir);

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error(`No DQL project found at "${baseDir}". Run from a project root or pass a project path.`);
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);
  const semanticConfig = resolveProjectSemanticConfig(config, projectRoot);

  switch (subcommand) {
    case 'list':
      return semanticList(semanticConfig, projectRoot, flags);
    case 'validate':
      return semanticValidate(semanticConfig, projectRoot, flags);
    case 'query':
      // `dql semantic query <metrics> [dims]`: the metrics are the first argument.
      return semanticQuery(semanticConfig, projectRoot, rest, flags);
    case 'pull':
      return semanticPull(semanticConfig, flags);
    case 'import':
      return semanticImport(projectRoot, rest, flags);
    case 'sync':
      return semanticSync(projectRoot, flags);
    default:
      console.log(`
  dql semantic — Semantic layer management

  Subcommands:
    dql semantic list [path]                 List all metrics, dimensions, hierarchies
    dql semantic validate [path]             Validate semantic layer definitions
    dql semantic query <metrics> [dims]      Compose a SQL query from metric/dimension names
    dql semantic pull [path]                 Refresh remote semantic layer cache
    dql semantic import <provider> [path]    Import provider metadata into local semantic-layer YAML
    dql semantic sync [path]                 Refresh the last semantic import from manifest

  Options:
    --format json|text    Output format (default: text)
    --verbose             Show detailed output
`.trim());
      break;
  }
}

// ── list ──────────────────────────────────────────────────────────────────────

function semanticList(
  semanticConfig: unknown,
  projectRoot: string,
  flags: CLIFlags,
): void {
  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`  ✗ ${err}`);
    }
  }

  if (!result.layer) {
    console.error('No semantic layer found. Add YAML files to semantic-layer/ or configure a provider in dql.config.json.');
    process.exit(1);
  }

  const layer = result.layer;
  const metrics = layer.listMetrics();
  const dimensions = layer.listDimensions();
  const hierarchies = layer.listHierarchies();

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      provider: result.detectedProvider ?? 'configured',
      metrics: metrics.map(m => ({ name: m.name, label: m.label, type: m.type, table: m.table, domain: m.domain })),
      dimensions: dimensions.map(d => ({ name: d.name, label: d.label, type: d.type, table: d.table })),
      hierarchies: hierarchies.map(h => ({ name: h.name, label: h.label, levels: h.levels.length })),
    }, null, 2));
    return;
  }

  const provider = result.detectedProvider ?? 'configured';
  console.log(`\n  Semantic Layer (${provider})`);
  console.log(`  ${'─'.repeat(50)}`);

  if (metrics.length > 0) {
    console.log(`\n  Metrics (${metrics.length}):`);
    for (const m of metrics) {
      console.log(`    • ${m.name}  [${m.type}]  ${m.label}`);
      if (flags.verbose && m.description) {
        console.log(`      ${m.description}`);
      }
    }
  } else {
    console.log('\n  Metrics: none');
  }

  if (dimensions.length > 0) {
    console.log(`\n  Dimensions (${dimensions.length}):`);
    for (const d of dimensions) {
      console.log(`    • ${d.name}  [${d.type}]  ${d.label}`);
      if (flags.verbose && d.description) {
        console.log(`      ${d.description}`);
      }
    }
  } else {
    console.log('\n  Dimensions: none');
  }

  if (hierarchies.length > 0) {
    console.log(`\n  Hierarchies (${hierarchies.length}):`);
    for (const h of hierarchies) {
      console.log(`    • ${h.name}  (${h.levels.length} levels)  ${h.label}`);
    }
  }

  console.log('');
}

// ── validate ──────────────────────────────────────────────────────────────────

function semanticValidate(
  semanticConfig: unknown,
  projectRoot: string,
  flags: CLIFlags,
): void {
  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  const issues: Array<{ level: 'error' | 'warning'; message: string }> = [];

  // Collect loading errors
  for (const err of result.errors) {
    issues.push({ level: 'error', message: err });
  }

  if (!result.layer) {
    issues.push({ level: 'error', message: 'No semantic layer could be loaded.' });
  } else {
    const layer = result.layer;
    const metrics = layer.listMetrics();
    const dimensions = layer.listDimensions();

    // Validate metrics
    for (const m of metrics) {
      if (!m.sql || m.sql.trim().length === 0) {
        issues.push({ level: 'error', message: `Metric "${m.name}" has empty SQL expression.` });
      }
      if (!m.table || m.table.trim().length === 0) {
        issues.push({ level: 'warning', message: `Metric "${m.name}" has no table reference.` });
      }
      if (!m.label || m.label.trim().length === 0) {
        issues.push({ level: 'warning', message: `Metric "${m.name}" has no label.` });
      }
    }

    // Validate dimensions
    for (const d of dimensions) {
      if (!d.sql || d.sql.trim().length === 0) {
        issues.push({ level: 'error', message: `Dimension "${d.name}" has empty SQL expression.` });
      }
    }

    // Check for duplicate names
    const metricNames = new Set<string>();
    for (const m of metrics) {
      if (metricNames.has(m.name)) {
        issues.push({ level: 'error', message: `Duplicate metric name: "${m.name}".` });
      }
      metricNames.add(m.name);
    }

    const dimNames = new Set<string>();
    for (const d of dimensions) {
      if (dimNames.has(d.name)) {
        issues.push({ level: 'error', message: `Duplicate dimension name: "${d.name}".` });
      }
      dimNames.add(d.name);
    }

    if (metrics.length === 0 && dimensions.length === 0) {
      issues.push({ level: 'warning', message: 'Semantic layer is empty — no metrics or dimensions found.' });
    }
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ valid: issues.filter(i => i.level === 'error').length === 0, issues }, null, 2));
    return;
  }

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');

  if (errors.length > 0) {
    console.log(`\n  ✗ ${errors.length} error(s):`);
    for (const e of errors) {
      console.log(`    ✗ ${e.message}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n  ⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.log(`    ⚠ ${w.message}`);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n  ✓ Semantic layer is valid.');
  }

  console.log('');

  if (errors.length > 0) {
    process.exit(1);
  }
}

// ── query ─────────────────────────────────────────────────────────────────────

function semanticQuery(
  semanticConfig: unknown,
  projectRoot: string,
  args: string[],
  flags: CLIFlags,
): void {
  if (args.length === 0) {
    console.error('Usage: dql semantic query <metric1,metric2> [dim1,dim2] [--format json]');
    process.exit(1);
  }

  const result = resolveSemanticLayerWithDiagnostics(
    semanticConfig as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0],
    projectRoot,
  );

  if (!result.layer) {
    console.error('No semantic layer found.');
    for (const err of result.errors) console.error(`  ✗ ${err}`);
    process.exit(1);
  }

  const metricNames = args[0].split(',').map(s => s.trim()).filter(Boolean);
  const dimNames = args[1] ? args[1].split(',').map(s => s.trim()).filter(Boolean) : [];

  const composed = result.layer.composeQuery({
    metrics: metricNames,
    dimensions: dimNames,
  });

  if (!composed) {
    console.error(`Could not compose query for metrics [${metricNames.join(', ')}].`);
    console.error('Ensure the metrics exist in your semantic layer definitions.');
    process.exit(1);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ sql: composed, metrics: metricNames, dimensions: dimNames }, null, 2));
  } else {
    console.log(`\n  Composed SQL:\n`);
    console.log(`  ${composed.sql}`);
    console.log('');
  }
}

// ── pull ──────────────────────────────────────────────────────────────────────

function semanticPull(
  semanticConfig: unknown,
  flags: CLIFlags,
): void {
  const cfg = semanticConfig as { repoUrl?: string; branch?: string } | undefined;

  if (!cfg?.repoUrl) {
    console.error('No remote repo configured. Set semanticLayer.repoUrl in dql.config.json.');
    process.exit(1);
  }

  const result = pullCachedRepo(cfg.repoUrl, cfg.branch);

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.freshClone) {
      console.log(`  ✓ Pulled latest from ${cfg.repoUrl} (branch: ${cfg.branch ?? 'main'})`);
    }
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log(`  Cache: ${result.localPath}`);
  }
}

async function semanticImport(
  projectRoot: string,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const provider = rest[0] as 'dbt' | 'cubejs' | 'snowflake' | undefined;
  if (!provider || (provider !== 'dbt' && provider !== 'cubejs' && provider !== 'snowflake')) {
    console.error('Usage: dql semantic import <dbt|cubejs|snowflake> [path] [--input <source-path>]');
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);
  const sourceConfig = buildImportSourceConfig(provider, config.semanticLayer, flags.input, projectRoot);
  const executeQuery = provider === 'snowflake'
    ? createSnowflakeQueryExecutor(config, projectRoot)
    : undefined;
  const result = await performSemanticImport({
    targetProjectRoot: projectRoot,
    provider,
    sourceConfig,
    executeQuery,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  ✓ Imported semantic layer from ${provider}`);
  console.log(`    Target: ${projectRoot}`);
  console.log(`    Manifest: ${join(projectRoot, 'semantic-layer', 'imports', 'manifest.json')}`);
  console.log('');
  console.log('  Imported objects:');
  for (const [kind, count] of Object.entries(result.counts)) {
    console.log(`    ${kind}: ${count}`);
  }
  if (result.manifest.warnings.length > 0) {
    console.log('');
    console.log('  Warnings:');
    for (const warning of result.manifest.warnings) {
      console.log(`    - ${warning}`);
    }
  }
  console.log('');
}

async function semanticSync(
  projectRoot: string,
  flags: CLIFlags,
): Promise<void> {
  const config = loadProjectConfig(projectRoot);
  const manifest = loadSemanticImportManifest(projectRoot);
  if (!manifest) {
    console.error('No semantic import manifest found. Run `dql semantic import <provider>` first.');
    process.exit(1);
  }

  const executeQuery = manifest.provider === 'snowflake'
    ? createSnowflakeQueryExecutor(config, projectRoot)
    : undefined;
  const result = await syncSemanticImport({
    targetProjectRoot: projectRoot,
    executeQuery,
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  ✓ Synced semantic import from ${manifest.provider}`);
  console.log(`    Imported at: ${result.manifest.importedAt}`);
  console.log(`    Manifest: ${join(projectRoot, 'semantic-layer', 'imports', 'manifest.json')}`);
  console.log('');
}

function buildImportSourceConfig(
  provider: 'dbt' | 'cubejs' | 'snowflake',
  semanticConfig: unknown,
  inputPath: string,
  projectRoot: string,
) {
  const current = (semanticConfig ?? {}) as {
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
    source?: 'local' | 'github' | 'gitlab';
  };

  if (provider === 'snowflake') {
    return {
      provider,
      projectPath: current.projectPath,
      connection: current.connection,
    };
  }

  if (inputPath) {
    return {
      provider,
      projectPath: resolve(projectRoot, inputPath),
    };
  }

  return {
    provider,
    projectPath: current.projectPath,
    repoUrl: current.repoUrl,
    branch: current.branch,
    subPath: current.subPath,
    source: current.source,
  };
}

function createSnowflakeQueryExecutor(
  config: ReturnType<typeof loadProjectConfig>,
  projectRoot: string,
) {
  const connection = config.defaultConnection;
  if (!connection || connection.driver !== 'snowflake') {
    throw new Error('Snowflake semantic import requires a default Snowflake connection in dql.config.json.');
  }
  const executor = new QueryExecutor();
  const normalizedConnection = normalizeProjectConnection(connection, projectRoot);
  return async (sql: string) => {
    const result = await executor.executeQuery(sql, [], {}, normalizedConnection);
    return { rows: result.rows };
  };
}
