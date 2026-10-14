/**
 * `zlens app diff [base] [head]` — review what a change does to every App page
 * (RFC 0008 step 10).
 *
 * Compares App files between two git revisions, or a revision and the
 * working tree (the default is HEAD against the working tree). For each page
 * it names the tiles added, removed and changed and says which changes can
 * move numbers (query, source, filters, driver), draws the layout before and
 * after, lists schedule and alert changes, and re-checks every changed page
 * with the same parser publish uses. Nothing runs against a warehouse, so it
 * works in CI; number changes are flagged for a reviewer to check on a run.
 *
 *   zlens app diff                       # HEAD vs working tree
 *   zlens app diff origin/main HEAD      # a pull request in CI
 *   zlens app diff main --html report.html --markdown comment.md --check
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  diffAppDeliveries,
  diffDashboardPages,
  parseAppDocument,
  parseDashboardDocument,
  renderLayoutDiffSvg,
  type AppDocument,
  type DashboardDocument,
  type PageDiff,
} from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';

export interface AppDiffReport {
  base: string;
  head: string;
  apps: Array<{
    appId: string;
    title: string;
    status: 'added' | 'removed' | 'changed';
    deliveries: string[];
    pages: Array<PageDiff & { file: string; problems: string[] }>;
    problems: string[];
  }>;
  /** Tiles whose numbers can change, across all pages. */
  numberChanges: number;
  problems: number;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const isAppFile = (path: string) => path.endsWith('/dql.app.json') || path === 'dql.app.json' || path.endsWith('.dqld');

/** App files at a revision (path relative to the project → text), or in the working tree when `ref` is null. */
export function readAppFiles(repoRoot: string, projectRoot: string, ref: string | null): Map<string, string> {
  const projectRel = relative(repoRoot, projectRoot).split('\\').join('/');
  const files = new Map<string, string>();
  const listed = ref === null
    ? git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--', projectRel || '.'])
    : git(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', projectRel || '.']);
  for (const repoPath of listed.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (!isAppFile(repoPath)) continue;
    const projectPath = projectRel ? repoPath.slice(projectRel.length + 1) : repoPath;
    // Private drafts and local state never belong to a review.
    if (projectPath.startsWith('.dql/') || projectPath.includes('/drafts/')) continue;
    if (ref === null) {
      const absolute = join(repoRoot, repoPath);
      if (existsSync(absolute)) files.set(projectPath, readFileSync(absolute, 'utf-8'));
    } else {
      files.set(projectPath, git(repoRoot, ['show', `${ref}:${repoPath}`]));
    }
  }
  return files;
}

/** Group a file map by App folder: the folder holding dql.app.json owns the .dqld pages under it. */
function appFolders(files: Map<string, string>): Map<string, { app?: string; pages: Map<string, string> }> {
  const folders = new Map<string, { app?: string; pages: Map<string, string> }>();
  const appDirs = [...files.keys()].filter((path) => path.endsWith('dql.app.json')).map((path) => dirname(path));
  for (const dir of appDirs) folders.set(dir, { app: files.get(dir === '.' ? 'dql.app.json' : `${dir}/dql.app.json`), pages: new Map() });
  for (const [path, text] of files) {
    if (!path.endsWith('.dqld')) continue;
    const owner = appDirs.filter((dir) => path.startsWith(`${dir}/`)).sort((left, right) => right.length - left.length)[0] ?? dirname(path);
    if (!folders.has(owner)) folders.set(owner, { pages: new Map() });
    folders.get(owner)!.pages.set(path, text);
  }
  return folders;
}

function parsePage(text: string | undefined, path: string): { document: DashboardDocument | null; problems: string[] } {
  if (text === undefined) return { document: null, problems: [] };
  const parsed = parseDashboardDocument(text, path);
  return { document: parsed.document, problems: parsed.errors.map((error) => error.message) };
}

function parseApp(text: string | undefined, path: string): { document: AppDocument | null; problems: string[] } {
  if (text === undefined) return { document: null, problems: [] };
  const parsed = parseAppDocument(text, path);
  return { document: parsed.document, problems: parsed.errors.map((error) => error.message) };
}

export function buildAppDiffReport(before: Map<string, string>, after: Map<string, string>, labels: { base: string; head: string }): AppDiffReport {
  const beforeFolders = appFolders(before);
  const afterFolders = appFolders(after);
  const apps: AppDiffReport['apps'] = [];
  for (const dir of [...new Set([...beforeFolders.keys(), ...afterFolders.keys()])].sort()) {
    const was = beforeFolders.get(dir);
    const now = afterFolders.get(dir);
    const appBefore = parseApp(was?.app, `${dir}/dql.app.json`);
    const appAfter = parseApp(now?.app, `${dir}/dql.app.json`);
    const pages: AppDiffReport['apps'][number]['pages'] = [];
    for (const file of [...new Set([...(was?.pages.keys() ?? []), ...(now?.pages.keys() ?? [])])].sort()) {
      const beforeText = was?.pages.get(file);
      const afterText = now?.pages.get(file);
      if (beforeText === afterText) continue;
      const pageBefore = parsePage(beforeText, file);
      const pageAfter = parsePage(afterText, file);
      // A page that no longer loads is a problem on that page, not a removal.
      if (afterText !== undefined && !pageAfter.document) {
        pages.push({ ...emptyDiff(file), title: pageBefore.document?.metadata.title ?? file, file, problems: pageAfter.problems.length ? pageAfter.problems : ['The page could not be read.'] });
        continue;
      }
      if (!pageBefore.document && !pageAfter.document) continue;
      const diff = diffDashboardPages(pageBefore.document, pageAfter.document);
      if (diff.status === 'unchanged' && pageAfter.problems.length === 0) continue;
      pages.push({ ...diff, file, problems: pageAfter.problems });
    }
    const deliveries = diffAppDeliveries(appBefore.document, appAfter.document);
    // An alert on a tile this change removes would stop being checked.
    const removedTiles = new Map(pages.flatMap((page) => page.tiles.filter((tile) => tile.kind === 'removed').map((tile) => [`${page.pageId}/${tile.tileId}`, tile.title] as const)));
    const orphanedAlerts = (appAfter.document?.schedules ?? []).flatMap((schedule) => (schedule.monitors ?? []).flatMap((monitor) => {
      const tileId = monitor.binding.split('.')[0]!;
      const title = removedTiles.get(`${schedule.dashboard}/${tileId}`);
      return title ? [`Alert "${monitor.label ?? monitor.id}" watches "${title}", which this change removes; it would stop being checked.`] : [];
    }));
    const appTextChanged = was?.app !== now?.app;
    const appProblems = [...appAfter.problems, ...orphanedAlerts];
    if (!pages.length && !deliveries.length && !appProblems.length && !(appTextChanged && (!was?.app || !now?.app))) continue;
    const appDoc = appAfter.document ?? appBefore.document;
    apps.push({
      appId: appDoc?.id ?? dir.split('/').pop() ?? dir,
      title: appDoc?.name ?? dir,
      status: !was?.app ? 'added' : !now?.app ? 'removed' : 'changed',
      deliveries,
      pages,
      problems: appProblems,
    });
  }
  const numberChanges = apps.reduce((sum, app) => sum + app.pages.reduce((count, page) => count + page.tiles.filter((tile) => tile.changesNumbers).length, 0), 0);
  const problems = apps.reduce((sum, app) => sum + app.problems.length + app.pages.reduce((count, page) => count + page.problems.length, 0), 0);
  return { base: labels.base, head: labels.head, apps, numberChanges, problems };
}

function emptyDiff(file: string): PageDiff {
  return { pageId: file, title: file, status: 'changed', tiles: [], page: [], cols: 12, beforeTiles: [], afterTiles: [] };
}

const tileLine = (tile: PageDiff['tiles'][number]) => {
  const mark = tile.kind === 'added' ? '+' : tile.kind === 'removed' ? '-' : '~';
  const detail = tile.kind === 'changed' ? `: ${tile.aspects.join(', ')}` : ` (${tile.kind})`;
  return `${mark} ${tile.title}${detail}${tile.changesNumbers ? '  <- numbers can change' : ''}`;
};

export function renderAppDiffText(report: AppDiffReport): string {
  const lines = [`App changes: ${report.base} -> ${report.head}`, ''];
  if (!report.apps.length) return `${lines[0]}\n\nNo App changes.`;
  for (const app of report.apps) {
    lines.push(`${app.title} (${app.appId})${app.status !== 'changed' ? ` — App ${app.status}` : ''}`);
    for (const page of app.pages) {
      lines.push(`  ${page.title} — page ${page.status}  [${page.file}]`);
      for (const tile of page.tiles) lines.push(`    ${tileLine(tile)}`);
      if (page.page.length) lines.push(`    page: ${page.page.join(', ')}`);
      for (const problem of page.problems) lines.push(`    PROBLEM: ${problem}`);
    }
    for (const delivery of app.deliveries) lines.push(`  ${delivery}`);
    for (const problem of app.problems) lines.push(`  PROBLEM: ${problem}`);
    lines.push('');
  }
  const pages = report.apps.reduce((sum, app) => sum + app.pages.length, 0);
  lines.push(`${pages} ${pages === 1 ? 'page' : 'pages'} changed · ${report.numberChanges} ${report.numberChanges === 1 ? 'tile' : 'tiles'} can show different numbers${report.numberChanges ? ' — check them on a run' : ''}${report.problems ? ` · ${report.problems} ${report.problems === 1 ? 'problem' : 'problems'}` : ''}.`);
  return lines.join('\n');
}

export function renderAppDiffMarkdown(report: AppDiffReport): string {
  const lines = [`### ZLens App changes: \`${report.base}\` → \`${report.head}\``, ''];
  if (!report.apps.length) return `${lines[0]}\n\nNo App changes.`;
  const pages = report.apps.reduce((sum, app) => sum + app.pages.length, 0);
  lines.push(`**${pages} ${pages === 1 ? 'page' : 'pages'} changed · ${report.numberChanges} ${report.numberChanges === 1 ? 'tile' : 'tiles'} can show different numbers**${report.problems ? ` · ❌ ${report.problems} ${report.problems === 1 ? 'problem' : 'problems'}` : ''}`, '');
  for (const app of report.apps) {
    lines.push(`#### ${app.title}${app.status !== 'changed' ? ` (App ${app.status})` : ''}`);
    for (const page of app.pages) {
      lines.push('', `**${page.title}** — page ${page.status}`, '');
      if (page.tiles.length) {
        lines.push('| Tile | Change | Numbers |', '| --- | --- | --- |');
        for (const tile of page.tiles) lines.push(`| ${tile.title.replace(/\|/g, '\\|')} | ${tile.kind === 'changed' ? tile.aspects.join(', ') : tile.kind} | ${tile.changesNumbers ? 'can change' : ''} |`);
      }
      if (page.page.length) lines.push('', `Page: ${page.page.join(', ')}`);
      for (const problem of page.problems) lines.push('', `❌ ${problem}`);
    }
    if (app.deliveries.length || app.problems.length) lines.push('');
    for (const delivery of app.deliveries) lines.push(`- ${delivery}`);
    for (const problem of app.problems) lines.push(`- ❌ ${problem}`);
    lines.push('');
  }
  lines.push('_Tiles marked "can change" are new, or have a new query, source, filter or driver. Nothing was run; check them on a page run before merging._');
  return lines.join('\n');
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderAppDiffHtml(report: AppDiffReport): string {
  const pages = report.apps.reduce((sum, app) => sum + app.pages.length, 0);
  const body = report.apps.map((app) => [
    `<section class="app"><h2>${esc(app.title)} <span class="id">${esc(app.appId)}</span>${app.status !== 'changed' ? ` <span class="pill ${app.status}">App ${app.status}</span>` : ''}</h2>`,
    app.pages.map((page) => [
      `<article class="page"><h3>${esc(page.title)} <span class="pill ${page.status}">${esc(page.status)}</span> <code>${esc(page.file)}</code></h3>`,
      page.beforeTiles.length || page.afterTiles.length ? `<figure>${renderLayoutDiffSvg(page)}<figcaption><span class="key added"></span>added <span class="key changed"></span>changed <span class="key numbers"></span>numbers can change <span class="key removed"></span>removed</figcaption></figure>` : '',
      page.tiles.length ? `<table><thead><tr><th>Tile</th><th>Change</th><th>Numbers</th></tr></thead><tbody>${page.tiles.map((tile) => `<tr class="${tile.kind}"><td>${esc(tile.title)}</td><td>${esc(tile.kind === 'changed' ? tile.aspects.join(', ') : tile.kind)}</td><td>${tile.changesNumbers ? '<strong>can change</strong>' : ''}</td></tr>`).join('')}</tbody></table>` : '',
      page.page.length ? `<p class="aspects">Page: ${esc(page.page.join(', '))}</p>` : '',
      page.problems.map((problem) => `<p class="problem">${esc(problem)}</p>`).join(''),
      '</article>',
    ].join('')).join(''),
    app.deliveries.length ? `<ul class="deliveries">${app.deliveries.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '',
    app.problems.map((problem) => `<p class="problem">${esc(problem)}</p>`).join(''),
    '</section>',
  ].join('')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App changes · ${esc(report.base)} → ${esc(report.head)}</title><style>
:root{--ink:#1a1a1a;--muted:#4a4a52;--line:#e9e6e0;--page:#fbfaf7;--surface:#fff;--teal:#0b7a75;--amber:#b26b1f;--red:#c14545}
*{box-sizing:border-box}body{margin:0;padding:28px clamp(16px,4vw,48px);background:var(--page);color:var(--ink);font:400 14px/1.55 Inter,-apple-system,'Segoe UI',Arial,sans-serif;font-variant-numeric:tabular-nums}
main{max-width:980px;margin:0 auto;display:grid;gap:20px}header h1{margin:0;font-size:22px;font-weight:600}header p{margin:4px 0 0;color:var(--muted)}
.summary{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.summary span{padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12px}.summary .warn{border-color:var(--amber);color:var(--amber)}.summary .bad{border-color:var(--red);color:var(--red)}
.app{display:grid;gap:12px}.app h2{margin:0;font-size:17px;font-weight:600}.id{color:var(--muted);font:12px ui-monospace,Menlo,monospace}
.page{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);display:grid;gap:10px}.page h3{margin:0;font-size:15px;font-weight:600;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.page code{color:var(--muted);font:12px ui-monospace,Menlo,monospace}
.pill{padding:1px 8px;border-radius:999px;font-size:11px;font-weight:500;border:1px solid var(--line)}.pill.added{color:var(--teal);border-color:var(--teal)}.pill.removed{color:var(--red);border-color:var(--red)}.pill.changed{color:var(--amber);border-color:var(--amber)}
figure{margin:0;overflow-x:auto}figure svg{max-width:100%;height:auto}figcaption{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;color:var(--muted);font-size:12px}.key{display:inline-block;width:12px;height:12px;margin-right:4px;border-radius:3px;vertical-align:-2px;border:1.5px solid}.key.added{background:#e6f2f1;border-color:var(--teal)}.key.changed{background:#fdf6ee;border-color:var(--amber)}.key.numbers{background:#fbeedd;border-color:var(--amber)}.key.removed{background:#fbeeee;border-color:var(--red);border-style:dashed}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:500}tr.removed td:first-child{text-decoration:line-through;color:var(--muted)}td strong{color:var(--amber);font-weight:600}
.aspects{margin:0;color:var(--muted)}.problem{margin:0;padding:8px 10px;border-left:3px solid var(--red);background:#fbeeee;color:var(--ink)}.deliveries{margin:0;padding-left:18px}
footer{color:var(--muted);font-size:12px}
</style></head><body><main><header><h1>App changes</h1><p><code>${esc(report.base)}</code> → <code>${esc(report.head)}</code></p><div class="summary"><span>${pages} ${pages === 1 ? 'page' : 'pages'} changed</span><span class="${report.numberChanges ? 'warn' : ''}">${report.numberChanges} ${report.numberChanges === 1 ? 'tile' : 'tiles'} can show different numbers</span>${report.problems ? `<span class="bad">${report.problems} ${report.problems === 1 ? 'problem' : 'problems'}</span>` : ''}</div></header>${body || '<p>No App changes.</p>'}<footer>Tiles that can show different numbers are new, or have a new query, source, filter or driver. This report runs nothing; check those tiles on a page run before merging. Made by <code>zlens app diff</code>.</footer></main></body></html>\n`;
}

export async function runAppDiff(rest: string[], flags: CLIFlags): Promise<void> {
  const positional = rest.filter((arg) => !arg.startsWith('-'));
  const projectRoot = findProjectRoot(process.cwd());
  let repoRoot: string;
  try {
    repoRoot = git(projectRoot, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error('zlens app diff needs a git repository. Run it inside the project\'s repository.');
  }
  const base = positional[0] ?? 'HEAD';
  const head = positional[1] ?? null;
  for (const ref of [base, head].filter((value): value is string => Boolean(value))) {
    try {
      git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch {
      throw new Error(`"${ref}" is not a commit, branch or tag in this repository.`);
    }
  }
  const report = buildAppDiffReport(
    readAppFiles(repoRoot, projectRoot, base),
    readAppFiles(repoRoot, projectRoot, head),
    { base, head: head ?? 'working tree' },
  );
  if (flags.htmlReport) writeFileSync(resolve(flags.htmlReport), renderAppDiffHtml(report), 'utf-8');
  if (flags.markdownReport) writeFileSync(resolve(flags.markdownReport), `${renderAppDiffMarkdown(report)}\n`, 'utf-8');
  if (flags.format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log(renderAppDiffText(report));
    if (flags.htmlReport) console.log(`\nReport: ${resolve(flags.htmlReport)}`);
    if (flags.markdownReport) console.log(`PR comment: ${resolve(flags.markdownReport)}`);
  }
  // --check gates CI on pages that would not load or publish.
  if (flags.check && report.problems > 0) process.exitCode = 1;
}
