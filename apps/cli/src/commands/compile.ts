/**
 * `zlens compile` — Generate the ZLens project manifest.
 *
 * Scans all blocks, business views, notebooks, and semantic layer definitions,
 * resolves dependencies, builds lineage, and writes dql-manifest.json.
 *
 * Usage:
 *   zlens compile [path]                        Compile project at path (default: .)
 *   zlens compile --dbt-manifest <path>         Import dbt manifest.json as upstream
 *   zlens compile --datalex-manifest <path>     Validate datalex_contract refs
 *   zlens compile --dbt-hops <n>               Limit upstream dbt hops (default: unlimited)
 *   zlens compile --out-dir <dir>               Write manifest to a specific directory
 *   zlens compile --format json                 Output manifest to stdout (no file write)
 *
 * Selective dbt import (automatic for projects > 200 models):
 *   Only imports the dbt models/sources that are reachable upstream from the
 *   tables your DQL blocks actually reference. This keeps dql-manifest.json
 *   small and fast even in 4000+ model repos.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest, collectInputFiles, resolveDataLexManifestPath, resolveDbtManifestPath, type DQLManifest } from '@zlens/core';
import { ManifestCache, type TrackedFile } from '@zlens/project';
import { ensureMetadataCatalogFresh, isAgentProjectIndexReady } from '@zlens/agent';
import type { CLIFlags } from '../args.js';

// APP-034 adds compile-time Dataset source/field drift diagnostics. Bump the
// semantic cache key so an older manifest cannot hide a newly-detected page
// contract error behind a warm cache entry.
const MANIFEST_COMPILER_CACHE_VERSION = 'dql2-qualified-domain-context-v3';

export function manifestCacheTrackedFiles(inputFiles: string[], dqlVersion: string): TrackedFile[] {
  return [
    ...inputFiles.map((path) => ({ path })),
    { path: '__dql_compiler_version__', contentHash: dqlVersion },
    { path: '__dql_compiler_semantics__', contentHash: MANIFEST_COMPILER_CACHE_VERSION },
  ];
}

export function readCliDqlVersion(): string {
  let dqlVersion = '0.6.0';
  try {
    const pkgPath = join(import.meta.dirname ?? __dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      dqlVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? dqlVersion;
    }
  } catch { /* use default */ }
  return dqlVersion;
}

/**
 * The compile result is deliberately small: callers such as `zlens sync dbt`
 * need to know whether a cache hit also left the persisted retrieval snapshot
 * usable.  They must not infer that from the compiler cache alone because the
 * metadata/KG snapshot has an independent source-version contract.
 */
export interface CompileResult {
  cacheHit: boolean;
  /** True only when the project-root manifest was unchanged and the persisted
   * metadata + KG snapshot was already prepared for that exact source version. */
  reusedPreparedAgentIndex: boolean;
}

export async function runCompile(
  pathArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<CompileResult | undefined> {
  // Collect all args (pathArg might be a flag if no path was given)
  const allArgs = [...(pathArg ? [pathArg] : []), ...rest];

  // Parse --dbt-manifest flag
  let dbtManifestPath: string | undefined;
  const dbtIdx = allArgs.indexOf('--dbt-manifest');
  if (dbtIdx >= 0 && allArgs[dbtIdx + 1]) {
    dbtManifestPath = resolve(allArgs[dbtIdx + 1]);
    if (!existsSync(dbtManifestPath)) {
      console.error(`dbt manifest not found: ${dbtManifestPath}`);
      process.exitCode = 1;
      return;
    }
  }

  // Parse --datalex-manifest flag
  let datalexManifestPath: string | undefined;
  const datalexIdx = allArgs.indexOf('--datalex-manifest');
  if (datalexIdx >= 0 && allArgs[datalexIdx + 1]) {
    datalexManifestPath = resolve(allArgs[datalexIdx + 1]);
    if (!existsSync(datalexManifestPath)) {
      console.error(`DataLex manifest not found: ${datalexManifestPath}`);
      process.exitCode = 1;
      return;
    }
  }

  // Parse --dbt-hops flag (max upstream hops for selective import)
  let maxDbtHops: number | undefined;
  const hopsIdx = allArgs.indexOf('--dbt-hops');
  if (hopsIdx >= 0 && allArgs[hopsIdx + 1]) {
    const parsed = parseInt(allArgs[hopsIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) maxDbtHops = parsed;
  }

  // Determine project root — first non-flag positional arg, or cwd
  const pathCandidates = allArgs.filter((a) => !a.startsWith('-'));
  // Remove the dbt manifest path from candidates (only if --dbt-manifest was found)
  const filteredCandidates = dbtIdx >= 0
    ? pathCandidates.filter((c) => c !== allArgs[dbtIdx + 1])
    : pathCandidates;
  const projectCandidates = datalexIdx >= 0
    ? filteredCandidates.filter((c) => c !== allArgs[datalexIdx + 1])
    : filteredCandidates;
  const projectRoot = resolve(projectCandidates[0] ?? '.');

  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    console.error('No ZLens project found (missing dql.config.json). Run from a project root or pass a project path.');
    process.exitCode = 1;
    return;
  }

  const dqlVersion = readCliDqlVersion();

  // Resolve via explicit flag → dql.config.json `dbt:` → target/manifest.json
  const resolvedDbt = resolveDbtManifestPath(projectRoot, dbtManifestPath);
  if (resolvedDbt) dbtManifestPath = resolvedDbt;
  const explicitDataLexManifestPath = flags.datalexManifestPath ?? datalexManifestPath;
  datalexManifestPath = resolveDataLexManifestPath(projectRoot, explicitDataLexManifestPath) ?? undefined;
  if (explicitDataLexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    console.error(`DataLex manifest not found: ${datalexManifestPath ?? explicitDataLexManifestPath}`);
    process.exitCode = 1;
    return;
  }

  const noCache = allArgs.includes('--no-cache');

  // Build manifest (with cache when possible)
  const startTime = Date.now();
  let manifest: DQLManifest;
  let cacheHit = false;

  const buildOptions = { projectRoot, dqlVersion, dbtManifestPath, maxDbtHops, datalexManifestPath };

  try {
    if (noCache) {
      manifest = buildManifest(buildOptions);
    } else {
      const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');
      const cache = new ManifestCache({ path: cachePath });
      try {
        const files = manifestCacheTrackedFiles(collectInputFiles(buildOptions), dqlVersion);
        const fingerprint = cache.fingerprint(files);
        const lookup = cache.lookup<DQLManifest>(fingerprint, files);
        if (lookup.hit) {
          manifest = lookup.value;
          cacheHit = true;
        } else {
          manifest = buildManifest(buildOptions);
          cache.put(fingerprint, manifest, files);
        }
      } finally {
        cache.close();
      }
    }
  } catch (err) {
    console.error(`Failed to compile project: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const elapsed = Date.now() - startTime;

  // JSON mode: output to stdout
  if (flags.format === 'json') {
    if (!noCache) {
      await refreshMetadataCatalog(projectRoot, manifest, true);
    }
    console.log(JSON.stringify(manifest, null, 2));
    return { cacheHit, reusedPreparedAgentIndex: false };
  }

  // Write manifest file
  const outDir = flags.outDir ? resolve(flags.outDir) : projectRoot;
  const manifestPath = join(outDir, 'dql-manifest.json');
  const manifestWritten = writeManifestIfChanged(manifestPath, manifest);
  // A compiler-cache hit is only a full warm path when the manifest file was
  // left untouched AND the persisted metadata/KG snapshot already represents
  // the same source version.  Rewriting identical JSON changes its mtime,
  // invalidates that version, and made `zlens sync dbt` rebuild every index after
  // reporting a 3ms compile cache hit.
  const reusedPreparedAgentIndex = !noCache
    && cacheHit
    && outDir === projectRoot
    && !manifestWritten
    && isAgentProjectIndexReady(projectRoot);
  const metadataRefresh = noCache || reusedPreparedAgentIndex
    ? null
    : await refreshMetadataCatalog(projectRoot, manifest, false);

  // Print summary
  const blockCount = Object.keys(manifest.blocks).length;
  const businessViews = manifest.businessViews ?? {};
  const businessViewCount = Object.keys(businessViews).length;
  const terms = manifest.terms ?? {};
  const termCount = Object.keys(terms).length;
  const notebookCount = Object.keys(manifest.notebooks).length;
  const metricCount = Object.keys(manifest.metrics).length;
  const dimensionCount = Object.keys(manifest.dimensions).length;
  const sourceCount = Object.keys(manifest.sources).length;
  const nodeCount = manifest.lineage.nodes.length;
  const edgeCount = manifest.lineage.edges.length;
  const domainCount = manifest.lineage.domains.length;

  console.log(`\n  ZLens Compile — ${manifest.project}`);
  console.log('  ' + '='.repeat(50));
  console.log('\n  Manifest:');
  console.log('    dql-manifest.json is the dbt-like compiled artifact for this ZLens project.');
  console.log('    It records blocks, terms, business views, notebooks, Apps, dashboards, semantic objects, sources, dbt imports, and lineage.');
  console.log(`\n  Scanned:`);
  console.log(`    ${blockCount} block(s)`);
  console.log(`    ${termCount} term(s)`);
  console.log(`    ${businessViewCount} business view(s)`);
  console.log(`    ${notebookCount} notebook(s)`);
  console.log(`    ${metricCount} metric(s)`);
  console.log(`    ${dimensionCount} dimension(s)`);
  console.log(`    ${sourceCount} source table(s)`);

  console.log(`\n  Lineage:`);
  console.log(`    ${nodeCount} nodes, ${edgeCount} edges, ${domainCount} domain(s)`);

  if (manifest.lineage.crossDomainFlows.length > 0) {
    console.log(`    ${manifest.lineage.crossDomainFlows.length} cross-domain flow(s)`);
  }

  if (manifest.dbtImport) {
    const dbt = manifest.dbtImport;
    console.log(`\n  dbt Import:`);
    if (dbt.selective && dbt.totalDbtModels !== undefined && dbt.totalDbtModels > dbt.modelsImported) {
      console.log(`    ${dbt.modelsImported} of ${dbt.totalDbtModels} model(s) (selective — upstream of DQL blocks only)`);
      if (dbt.maxHops !== undefined) {
        console.log(`    depth: ${dbt.maxHops} hop(s) upstream`);
      }
    } else {
      console.log(`    ${dbt.modelsImported} model(s), ${dbt.sourcesImported} source(s)`);
    }
    console.log(`    from: ${dbt.manifestPath}`);
  }

  if (datalexManifestPath) {
    console.log(`\n  DataLex Contracts:`);
    console.log(`    from: ${datalexManifestPath}`);
  }

  console.log(`\n  Manifest written to: ${manifestPath}`);
  if (metadataRefresh) {
    console.log(`  Metadata catalog ${metadataRefresh.refreshed ? 'refreshed' : 'up to date'}: .dql/cache/metadata.sqlite`);
    if (metadataRefresh.diagnostics.length > 0) {
      const warnCount = metadataRefresh.diagnostics.filter((d) => d.severity === 'warning').length;
      const errCount = metadataRefresh.diagnostics.filter((d) => d.severity === 'error').length;
      console.log(`  Metadata diagnostics: ${errCount} error(s), ${warnCount} warning(s)`);
    }
  }
  if (reusedPreparedAgentIndex) {
    console.log('  Metadata catalog and agent index reused: prepared snapshot matches this manifest.');
  }
  console.log(`  ${cacheHit ? 'Served from cache' : 'Compiled'} in ${elapsed}ms`);

  // Surface non-fatal problems — a silent "0 blocks" should never happen again.
  const diagnostics = manifest.diagnostics ?? [];
  const errs = diagnostics.filter((d) => d.severity === 'error');
  const warns = diagnostics.filter((d) => d.severity === 'warning');
  if (diagnostics.length > 0) {
    console.log('');
    if (errs.length > 0) {
      console.log(`  ${errs.length} error(s):`);
      for (const d of errs) {
        const where = d.filePath ? `${d.filePath}: ` : '';
        console.log(`    ✗ ${where}${d.message}`);
      }
    }
    if (warns.length > 0) {
      console.log(`  ${warns.length} warning(s):`);
      for (const d of warns) {
        const where = d.filePath ? `${d.filePath}: ` : '';
        console.log(`    ⚠ ${where}${d.message}`);
      }
    }
    if (errs.length > 0) process.exitCode = 1;
  }
  console.log('');

  if (flags.verbose) {
    // Show block details
    console.log('  Blocks:');
    for (const block of Object.values(manifest.blocks)) {
      const deps = block.allDependencies;
      const meta = [block.domain, block.owner].filter(Boolean).join(', ');
      console.log(`    ${block.name}${meta ? ` (${meta})` : ''}`);
      if (deps.length > 0) {
        console.log(`      depends on: ${deps.join(', ')}`);
      }
    }

    if (termCount > 0) {
      console.log('\n  Terms:');
      for (const term of Object.values(terms)) {
        const meta = [term.domain, term.termType, term.owner].filter(Boolean).join(', ');
        console.log(`    ${term.name}${meta ? ` (${meta})` : ''}`);
        if (term.identifiers && term.identifiers.length > 0) {
          console.log(`      identifiers: ${term.identifiers.join(', ')}`);
        }
      }
    }

    if (businessViewCount > 0) {
      console.log('\n  Business Views:');
      for (const view of Object.values(businessViews)) {
        const meta = [view.domain, view.owner].filter(Boolean).join(', ');
        const refs = [...view.blockRefs.map((ref) => `block:${ref}`), ...view.businessViewRefs.map((ref) => `business_view:${ref}`)];
        console.log(`    ${view.name}${meta ? ` (${meta})` : ''}`);
        if (refs.length > 0) {
          console.log(`      includes: ${refs.join(', ')}`);
        }
        if (view.termRefs.length > 0) {
          console.log(`      terms: ${view.termRefs.join(', ')}`);
        }
      }
    }

    if (Object.keys(manifest.notebooks).length > 0) {
      console.log('\n  Notebooks:');
      for (const nb of Object.values(manifest.notebooks)) {
        console.log(`    ${nb.title} (${nb.cells.length} cells) — ${nb.filePath}`);
      }
    }

    console.log('');
  }

  return { cacheHit, reusedPreparedAgentIndex };
}

/**
 * Avoid mtime-only invalidation of the persisted agent snapshot on a compile
 * cache hit. The emitted manifest is canonical JSON, so byte equality means
 * the active project contract did not change. A missing/unreadable file still
 * gets written normally.
 */
function writeManifestIfChanged(path: string, manifest: DQLManifest): boolean {
  const serialized = JSON.stringify(manifest, null, 2);
  try {
    if (readFileSync(path, 'utf-8') === serialized) return false;
  } catch {
    // The first compile (or an interrupted prior write) needs a fresh file.
  }
  writeFileSync(path, serialized);
  return true;
}

async function refreshMetadataCatalog(
  projectRoot: string,
  manifest: DQLManifest,
  silent: boolean,
) {
  try {
    return await ensureMetadataCatalogFresh(projectRoot, { manifest });
  } catch (err) {
    if (!silent) {
      console.log(`  Metadata catalog warning: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}
