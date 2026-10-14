import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAppDiffReport, readAppFiles, renderAppDiffHtml, renderAppDiffMarkdown, renderAppDiffText } from './app-diff.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=dql@example.test', '-c', 'user.name=DQL test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository whose project lives in a subfolder, as in a monorepo. */
function repository(): { repo: string; project: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'dql-app-diff-')));
  roots.push(repo);
  const project = join(repo, 'analytics');
  cpSync(FIXTURE, project, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, project };
}

const pagePath = (project: string) => join(project, 'apps/commerce-pilot/dashboards/overview.dqld');
const edit = (path: string, change: (json: any) => void) => {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  change(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};

describe('zlens app diff (RFC 0008 step 10)', () => {
  it('reviews working-tree changes to pages and alerts against HEAD', () => {
    const { repo, project } = repository();
    edit(pagePath(project), (page) => {
      const [kpi, , , chart] = page.layout.items;
      kpi.title = 'Revenue (net)';
      chart.query.filters = [{ field: 'region', op: 'in', values: ['US'] }];
      chart.w = 12;
      page.layout.items.splice(1, 1);
    });
    edit(join(project, 'apps/commerce-pilot/dql.app.json'), (app) => {
      app.schedules = [{ id: 'alerts-overview', cron: '0 8 * * *', dashboard: 'overview', deliver: [], digest: false, monitors: [{ id: 'low', binding: 'order-lines-dataset-kpi.revenue', when: { kind: 'threshold', op: '<', value: 100 } }] }];
    });

    const report = buildAppDiffReport(readAppFiles(repo, project, 'HEAD'), readAppFiles(repo, project, null), { base: 'HEAD', head: 'working tree' });
    expect(report.apps).toHaveLength(1);
    const [app] = report.apps;
    expect(app).toMatchObject({ appId: 'commerce-pilot', status: 'changed' });
    expect(app!.deliveries).toEqual(['Schedule "alerts-overview" added for page overview (0 8 * * *) with 1 alert.']);
    const [page] = app!.pages;
    expect(page).toMatchObject({ pageId: 'overview', status: 'changed', file: 'apps/commerce-pilot/dashboards/overview.dqld', problems: [] });
    const byTitle = Object.fromEntries(page!.tiles.map((tile) => [tile.title, tile]));
    expect(byTitle['Revenue by region']).toMatchObject({ kind: 'changed', aspects: ['query', 'size'], changesNumbers: true });
    expect(byTitle['Revenue (net)']).toMatchObject({ kind: 'changed', aspects: ['title'], changesNumbers: false });
    expect(byTitle.Orders).toMatchObject({ kind: 'removed', changesNumbers: false });
    expect(report.numberChanges).toBe(1);

    const text = renderAppDiffText(report);
    expect(text).toContain('~ Revenue by region: query, size  <- numbers can change');
    expect(text).toContain('- Orders (removed)\n');
    expect(text).toContain('1 page changed · 1 tile can show different numbers — check them on a run.');
    const markdown = renderAppDiffMarkdown(report);
    expect(markdown).toContain('| Revenue by region | query, size | can change |');
    const html = renderAppDiffHtml(report);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<svg');
  });

  it('reports an alert that watches a tile the change removes', () => {
    const { repo, project } = repository();
    edit(join(project, 'apps/commerce-pilot/dql.app.json'), (app) => {
      app.schedules = [{ id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [], monitors: [{ id: 'low-orders', binding: 'order-lines-dataset-kpi-2.order_count', when: { kind: 'threshold', op: '<', value: 5 }, label: 'Few orders' }] }];
    });
    git(repo, 'commit', '-q', '-am', 'alert on orders');
    edit(pagePath(project), (page) => { page.layout.items = page.layout.items.filter((item: { i: string }) => item.i !== 'order-lines-dataset-kpi-2'); });
    const report = buildAppDiffReport(readAppFiles(repo, project, 'HEAD'), readAppFiles(repo, project, null), { base: 'HEAD', head: 'working tree' });
    expect(report.apps[0]!.problems).toEqual(['Alert "Few orders" watches "Orders", which this change removes; it would stop being checked.']);
    expect(report.problems).toBe(1);
  });

  it('compares two commits and reports a page that no longer loads as a problem', () => {
    const { repo, project } = repository();
    edit(pagePath(project), (page) => {
      page.narrative = { version: 1, presentation: 'story', blocks: [{ id: 'b1', kind: 'text', markdown: 'Revenue grew 12% this month.' }] };
    });
    git(repo, 'commit', '-q', '-am', 'story with a typed-in number');
    const report = buildAppDiffReport(readAppFiles(repo, project, 'HEAD~1'), readAppFiles(repo, project, 'HEAD'), { base: 'HEAD~1', head: 'HEAD' });
    const [page] = report.apps[0]!.pages;
    expect(page!.status).toBe('changed');
    expect(page!.title).toBe('Overview');
    expect(page!.problems.join(' ')).toMatch(/number/i);
    expect(report.problems).toBeGreaterThan(0);
  });

  it('says so when nothing changed, and ignores private drafts', () => {
    const { repo, project } = repository();
    // A page under drafts/ is private work in progress, not part of the review.
    mkdirSync(join(project, 'apps/commerce-pilot/drafts'), { recursive: true });
    writeFileSync(join(project, 'apps/commerce-pilot/drafts/next.dqld'), readFileSync(pagePath(project), 'utf8'));
    const report = buildAppDiffReport(readAppFiles(repo, project, 'HEAD'), readAppFiles(repo, project, null), { base: 'HEAD', head: 'working tree' });
    expect(report.apps).toEqual([]);
    expect(renderAppDiffText(report)).toBe('App changes: HEAD -> working tree\n\nNo App changes.');
  });
});
