import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  canonicalizeNotebook,
  findAppDocuments,
  findDashboardsForApp,
  loadAppDocument,
  loadDashboardDocument,
  parseAppDocument,
  parseDashboardDocument,
} from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

type PromotionKind = 'notebook' | 'app' | 'dashboard';

export async function runPromote(kind: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  if (kind !== 'notebook' && kind !== 'app' && kind !== 'dashboard') {
    throw new Error('Usage: zlens promote <notebook|app|dashboard> <path-or-id> --to shared');
  }
  if (flags.to !== 'shared') {
    throw new Error('Promotion currently supports only --to shared');
  }
  const target = rest[0];
  if (!target) {
    throw new Error(`Usage: zlens promote ${kind} <path-or-id> --to shared`);
  }
  const projectRoot = findProjectRoot(process.cwd());
  const result = promoteArtifact(projectRoot, kind, target);
  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`  ✓ Promoted ${kind} to shared source: ${result.path}`);
  if (result.removedLocalState.length > 0) {
    console.log(`    Removed local-only state: ${result.removedLocalState.join(', ')}`);
  }
}

export function promoteArtifact(
  projectRoot: string,
  kind: PromotionKind,
  target: string,
): { ok: true; kind: PromotionKind; path: string; removedLocalState: string[] } {
  if (kind === 'notebook') return promoteNotebook(projectRoot, target);
  if (kind === 'app') return promoteApp(projectRoot, target);
  return promoteDashboard(projectRoot, target);
}

function promoteNotebook(projectRoot: string, target: string) {
  const absPath = resolveProjectPath(projectRoot, target);
  if (!existsSync(absPath) || !absPath.endsWith('.dqlnb')) {
    throw new Error(`Notebook not found: ${target}`);
  }
  const source = readFileSync(absPath, 'utf-8');
  const raw = JSON.parse(source) as Record<string, unknown>;
  const removed = new Set<string>();
  const cleaned = stripLocalState({
    ...raw,
    metadata: {
      ...(isRecord(raw.metadata) ? raw.metadata : {}),
      visibility: 'shared',
      lifecycle: normalizeLifecycle((raw.metadata as Record<string, unknown> | undefined)?.lifecycle),
    },
  }, removed);
  const text = canonicalizeNotebook(JSON.stringify(cleaned));
  writeFileSync(absPath, text, 'utf-8');
  return promoted('notebook', projectRoot, absPath, removed);
}

function promoteApp(projectRoot: string, appId: string) {
  const appPath = resolveAppJsonPath(projectRoot, appId);
  const source = readFileSync(appPath, 'utf-8');
  const raw = JSON.parse(source) as Record<string, unknown>;
  const removed = new Set<string>();
  const cleaned = stripLocalState({
    ...raw,
    visibility: 'shared',
    lifecycle: normalizeLifecycle(raw.lifecycle),
    notebooks: Array.isArray(raw.notebooks)
      ? raw.notebooks.filter((notebook) =>
          isRecord(notebook) && (notebook.visibility === 'shared' || notebook.visibility === 'template'),
        )
      : undefined,
  }, removed);
  const parsed = parseAppDocument(stableJson(cleaned), appPath);
  if (!parsed.document) {
    throw new Error(`Promoted app is invalid: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  writeFileSync(appPath, stableJson(cleaned), 'utf-8');
  return promoted('app', projectRoot, appPath, removed);
}

function promoteDashboard(projectRoot: string, target: string) {
  const [appId, dashboardId] = target.split('/');
  if (!appId || !dashboardId) {
    throw new Error('Usage: zlens promote dashboard <app-id>/<dashboard-id> --to shared');
  }
  const dashboardPath = resolveDashboardPath(projectRoot, appId, dashboardId);
  const source = readFileSync(dashboardPath, 'utf-8');
  const raw = JSON.parse(source) as Record<string, unknown>;
  const removed = new Set<string>();
  const layout = isRecord(raw.layout) ? raw.layout : {};
  const items = Array.isArray(layout.items)
    ? layout.items.flatMap((item) => {
        if (!isRecord(item)) return [];
        if (item.aiPin) {
          removed.add('aiPin tiles');
          return [];
        }
        return [stripLocalState(promoteDashboardItemDisplay(item), removed)];
      })
    : [];
  const cleaned = stripLocalState({
    ...raw,
    metadata: {
      ...(isRecord(raw.metadata) ? raw.metadata : {}),
      visibility: 'shared',
      lifecycle: normalizeLifecycle((raw.metadata as Record<string, unknown> | undefined)?.lifecycle),
    },
    layout: {
      ...layout,
      items,
    },
  }, removed);
  const parsed = parseDashboardDocument(stableJson(cleaned), dashboardPath);
  if (!parsed.document) {
    throw new Error(`Promoted dashboard is invalid: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  writeFileSync(dashboardPath, stableJson(cleaned), 'utf-8');
  return promoted('dashboard', projectRoot, dashboardPath, removed);
}

function promoteDashboardItemDisplay(item: Record<string, unknown>): Record<string, unknown> {
  if (item.display || !isRecord(item.viz)) return item;
  const options = isRecord(item.viz.options) ? item.viz.options : {};
  if (!isRecord(options.dqlGenUi)) return item;
  const genUi = options.dqlGenUi;
  const display = {
    mode: item.block ? 'block_hint' : 'ai_generated',
    component: typeof genUi.component === 'string' ? genUi.component : 'EvidenceTable',
    defaultVisualization: typeof genUi.defaultVisualization === 'string'
      ? genUi.defaultVisualization
      : typeof item.viz.type === 'string' ? item.viz.type : 'table',
    allowedVisualizations: Array.isArray(genUi.allowedVisualizations)
      ? genUi.allowedVisualizations.filter((value): value is string => typeof value === 'string')
      : [typeof item.viz.type === 'string' ? item.viz.type : 'table'],
    ...(isRecord(genUi.fieldHints) ? { fieldHints: genUi.fieldHints } : {}),
    layoutIntent: typeof genUi.layoutIntent === 'string' ? genUi.layoutIntent : 'auto',
    rationale: typeof genUi.rationale === 'string' ? genUi.rationale : 'Promoted display metadata from legacy GenUI options.',
    trustState: genUi.trustState === 'certified' || genUi.trustState === 'draft_ready' ? genUi.trustState : 'review_required',
    reviewStatus: genUi.reviewStatus === 'certified' || genUi.reviewStatus === 'draft_ready' ? genUi.reviewStatus : 'review_required',
  };
  return { ...item, display };
}

function stripLocalState(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripLocalState(item, removed));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (LOCAL_ONLY_KEYS.has(key) || key.startsWith('_local') || key.startsWith('local')) {
      removed.add(key);
      continue;
    }
    if (key === 'options' && isRecord(nested)) {
      const nextOptions = { ...nested };
      if ('dqlGenUi' in nextOptions) {
        delete nextOptions.dqlGenUi;
        removed.add('legacy dqlGenUi options');
      }
      out[key] = stripLocalState(nextOptions, removed);
      continue;
    }
    out[key] = stripLocalState(nested, removed);
  }
  return out;
}

const LOCAL_ONLY_KEYS = new Set([
  'aiPins',
  'execution',
  'executionCount',
  'executionState',
  'lastRunAt',
  'layoutOverrides',
  'modifiedAt',
  'outputs',
  'pins',
  'result',
  'results',
  'run',
  'runResult',
  'savedView',
  'savedViews',
  'selection',
  'snapshot',
  'transient',
  'uiState',
]);

function resolveProjectPath(projectRoot: string, target: string): string {
  const abs = resolve(target);
  if (abs === projectRoot || abs.startsWith(`${projectRoot}/`)) return abs;
  if (isAbsolute(target)) throw new Error(`Path is outside this ZLens project: ${target}`);
  return join(projectRoot, target);
}

function resolveAppJsonPath(projectRoot: string, appId: string): string {
  for (const path of findAppDocuments(projectRoot)) {
    const loaded = loadAppDocument(path);
    if (loaded.document?.id === appId || basename(path.slice(0, -'/dql.app.json'.length)) === appId) return path;
  }
  throw new Error(`App not found: ${appId}`);
}

function resolveDashboardPath(projectRoot: string, appId: string, dashboardId: string): string {
  const appPath = resolveAppJsonPath(projectRoot, appId);
  const appDir = appPath.slice(0, -'/dql.app.json'.length);
  for (const path of findDashboardsForApp(appDir)) {
    const loaded = loadDashboardDocument(path);
    if (loaded.document?.id === dashboardId || basename(path, '.dqld') === dashboardId) return path;
  }
  throw new Error(`Dashboard not found: ${appId}/${dashboardId}`);
}

function normalizeLifecycle(value: unknown): 'review' | 'certified' | 'deprecated' {
  return value === 'certified' || value === 'deprecated' ? value : 'review';
}

function promoted(kind: PromotionKind, projectRoot: string, absPath: string, removed: Set<string>) {
  return {
    ok: true as const,
    kind,
    path: relative(projectRoot, absPath).replaceAll('\\', '/'),
    removedLocalState: Array.from(removed).sort(),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, stableReplacer(), 2) + '\n';
}

function stableReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  return function replacer(_key, value) {
    if (!isRecord(value)) return value;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return sorted;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
