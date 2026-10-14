import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import {
  diffDQL,
  diffNotebook,
  renderDiffText,
  computeImpactFromDiff,
  renderImpactText,
  changedBlocksFromDiff,
  LineageGraph,
  type DiffReport,
  type ImpactReport,
  type RecertItem,
} from '@zlens/core';
import { findRepoContext, readHeadBlob } from '../git-service.js';
import type { CLIFlags } from '../args.js';

export async function runDiff(
  firstArg: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  const secondArg = rest.find((a) => !a.startsWith('-')) ?? undefined;

  if (!firstArg) {
    console.error('Usage: zlens diff <path> [--impact] | zlens diff <before> <after> [--impact]');
    process.exit(1);
  }

  const report = secondArg
    ? await diffTwoFiles(firstArg, secondArg)
    : await diffAgainstHead(firstArg);

  // ---- Impact mode: --impact turns `zlens diff` into an impact/re-cert gate ----
  if (flags.impact) {
    const impactContext = computeImpact(firstArg, report, flags);
    const impact = impactContext?.impact ?? null;
    const recertificationChangeset = impact && flags.writeRecertification
      ? writeRecertificationChangeset(impactContext!.projectRoot, impact)
      : null;
    emitImpact(report, impact, flags, recertificationChangeset);
    // Gate: non-zero when certified downstream is invalidated without re-cert.
    if (impact && impact.hasCertifiedInvalidation) {
      const unresolved = recertificationChangeset ? recertificationChangeset.skipped > 0 : true;
      if (unresolved) process.exit(1);
    }
    return;
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDiffText(report));
  }

  // Exit 1 when there are changes — makes it scriptable as a gate
  // (`zlens diff a b && echo unchanged`), mirroring git-diff and fmt --check.
  if (!report.identical) process.exit(1);
}

async function diffTwoFiles(beforePath: string, afterPath: string): Promise<DiffReport> {
  const before = readFileSync(beforePath, 'utf-8');
  const after = readFileSync(afterPath, 'utf-8');
  return diffByExtension(afterPath, before, after);
}

async function diffAgainstHead(path: string): Promise<DiffReport> {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    console.error(`Error: file not found: ${path}`);
    process.exit(1);
  }
  const ctx = findRepoContext(absPath);
  if (!ctx) {
    console.error(`Error: ${path} is not inside a git repository. Use: zlens diff <before> <after>`);
    process.exit(1);
  }
  const before = await readHeadBlob(ctx);
  const after = readFileSync(absPath, 'utf-8');
  return diffByExtension(absPath, before, after);
}

function diffByExtension(path: string, before: string | null, after: string): DiffReport {
  if (path.endsWith('.dqlnb')) {
    return diffNotebook(before, after);
  }
  // diffDQL doesn't accept null — newly added files diff against empty source.
  return diffDQL(before ?? '', after);
}

// ---- Impact analysis (--impact) ----

/**
 * Compute the downstream impact + re-cert report for a diff. Resolves the
 * project's lineage graph by walking up from the changed file to the nearest
 * `dql.config.json`, then reading `dql-manifest.json` (the compiled lineage).
 * Returns `null` when no project/manifest can be located — in that case the
 * gate is a no-op (we cannot know downstream impact without a graph).
 */
interface ImpactContext {
  projectRoot: string;
  impact: ImpactReport;
}

function computeImpact(changedPath: string, report: DiffReport, flags: CLIFlags): ImpactContext | null {
  const graphContext = loadProjectLineageGraph(changedPath, flags);
  if (!graphContext) return null;
  return {
    projectRoot: graphContext.projectRoot,
    impact: computeImpactFromDiff(graphContext.graph, report.changes),
  };
}

interface RecertificationChangesetResult {
  written: number;
  skipped: number;
  paths: string[];
  skippedItems: Array<{ id: string; reason: string }>;
}

function emitImpact(
  report: DiffReport,
  impact: ImpactReport | null,
  flags: CLIFlags,
  recertificationChangeset: RecertificationChangesetResult | null = null,
): void {
  if (flags.format === 'json') {
    if (impact) {
      console.log(JSON.stringify(recertificationChangeset ? { ...impact, recertificationChangeset } : impact, null, 2));
    } else {
      // No graph available — emit a minimal, still-structured payload so the
      // `--format json` contract holds and consumers can detect the gap.
      console.log(
        JSON.stringify(
          {
            changedBlocks: changedBlocksFromDiff(report.changes),
            downstream: [],
            crossDomainImpacts: [],
            requiresRecert: [],
            domainTrustDelta: [],
            hasCertifiedInvalidation: false,
            note: 'No compiled lineage graph found (dql-manifest.json). Run `zlens compile` for downstream impact.',
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (!impact) {
    console.log(renderDiffText(report));
    console.log('');
    console.log('  Impact: no compiled lineage graph found (dql-manifest.json).');
    console.log('  Run `zlens compile` to enable downstream impact + re-cert gating.');
    return;
  }
  console.log(renderImpactText(impact));
  if (recertificationChangeset) {
    console.log('');
    console.log(`  Recertification changeset: ${recertificationChangeset.written} file(s) updated, ${recertificationChangeset.skipped} skipped.`);
    for (const path of recertificationChangeset.paths) {
      console.log(`    - ${path}`);
    }
  }
}

/**
 * Locate the project root for a changed file and load its compiled lineage
 * graph from `dql-manifest.json`. Walks up from the file looking for
 * `dql.config.json`; falls back to cwd. Returns `null` if no manifest is found.
 */
function loadProjectLineageGraph(changedPath: string, _flags: CLIFlags): { projectRoot: string; graph: LineageGraph } | null {
  const projectRoot = findProjectRoot(resolve(changedPath));
  if (!projectRoot) return null;

  const manifestPath = join(projectRoot, 'dql-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (manifest.lineage?.nodes && manifest.lineage?.edges) {
      return {
        projectRoot,
        graph: LineageGraph.fromJSON({
          nodes: manifest.lineage.nodes,
          edges: manifest.lineage.edges,
        }),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeRecertificationChangeset(projectRoot: string, impact: ImpactReport): RecertificationChangesetResult {
  const result: RecertificationChangesetResult = {
    written: 0,
    skipped: 0,
    paths: [],
    skippedItems: [],
  };
  for (const item of impact.requiresRecert) {
    if (item.type !== 'metric' && item.type !== 'dimension') {
      result.skipped += 1;
      result.skippedItems.push({ id: item.id, reason: 'only semantic metric and dimension YAML files are writable' });
      continue;
    }
    if (!item.filePath) {
      result.skipped += 1;
      result.skippedItems.push({ id: item.id, reason: 'missing semantic definition file path' });
      continue;
    }
    const relativePath = normalizeRecertificationPath(item.filePath);
    if (!relativePath.startsWith('semantic-layer/')) {
      result.skipped += 1;
      result.skippedItems.push({ id: item.id, reason: 'semantic file path is outside semantic-layer/' });
      continue;
    }
    const absolutePath = join(projectRoot, relativePath);
    if (!existsSync(absolutePath)) {
      result.skipped += 1;
      result.skippedItems.push({ id: item.id, reason: 'semantic definition file does not exist' });
      continue;
    }
    const updated = markSemanticDefinitionPending(readFileSync(absolutePath, 'utf-8'), item);
    if (!updated) {
      result.skipped += 1;
      result.skippedItems.push({ id: item.id, reason: 'could not find matching semantic definition in YAML' });
      continue;
    }
    writeFileSync(absolutePath, updated, 'utf-8');
    result.written += 1;
    result.paths.push(relativePath);
  }
  return result;
}

function normalizeRecertificationPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function markSemanticDefinitionPending(content: string, item: RecertItem): string | null {
  const raw = loadYaml(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const document = raw as Record<string, unknown>;
  const collectionKey = item.type === 'metric' ? 'metrics' : 'dimensions';
  let changed = false;

  if (typeof document.name === 'string' && document.name === item.name) {
    document.status = 'pending_recertification';
    changed = true;
  }

  const collection = document[collectionKey];
  if (Array.isArray(collection)) {
    for (const entry of collection) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.name === item.name) {
        record.status = 'pending_recertification';
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return dumpYaml(document, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

/** Walk up from a path to the nearest directory containing `dql.config.json`. */
function findProjectRoot(fromPath: string): string | null {
  let dir = existsSync(fromPath) && isDirectory(fromPath) ? fromPath : dirname(fromPath);
  while (true) {
    if (existsSync(join(dir, 'dql.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd if it is itself a project.
  const cwd = resolve('.');
  if (existsSync(join(cwd, 'dql.config.json'))) return cwd;
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
