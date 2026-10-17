import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DQLContext } from '../../context.js';
import { listApps, listNotebooks } from '../apps-notebooks.js';

function project(): DQLContext {
  const root = mkdtempSync(join(tmpdir(), 'zlens-mcp-apps-'));
  mkdirSync(join(root, 'apps/growth/dashboards'), { recursive: true });
  writeFileSync(join(root, 'apps/growth/dashboards/overview.dqld'), JSON.stringify({
    layout: { items: [
      { i: 'rev', title: 'Monthly revenue', block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
      { i: 'draft', title: 'Store revenue', block: { blockId: 'store_revenue' }, viz: { type: 'bar' } },
    ] },
  }));
  mkdirSync(join(root, 'notebooks'), { recursive: true });
  writeFileSync(join(root, 'notebooks/welcome.dqlnb'), JSON.stringify({
    title: 'Welcome',
    metadata: { description: 'Start here.' },
    cells: [
      { id: 'intro', type: 'markdown', name: 'Intro', content: '# Hello' },
      { id: 'q', type: 'sql', name: 'Revenue', content: 'select 1' },
    ],
  }));
  return {
    projectRoot: root,
    manifest: {
      blocks: {
        monthly_revenue: { name: 'monthly_revenue', status: 'certified', filePath: 'blocks/monthly_revenue.dql' },
        store_revenue: { name: 'store_revenue', status: 'draft', filePath: 'blocks/_drafts/store_revenue.dql' },
      },
      apps: {
        growth: {
          id: 'growth', name: 'Growth Review', domain: 'commerce', lifecycle: 'review', visibility: 'shared', owners: ['a@b.c'], tags: [],
          filePath: 'apps/growth', dashboards: ['growth/overview'], notebooks: [],
          schedules: [{ id: 'weekly', cron: '0 9 * * 1', dashboard: 'overview', enabled: true, deliver: [{ kind: 'slack', channel: '#x' }] }],
        },
      },
      dashboards: {
        'growth/overview': { id: 'overview', appId: 'growth', qualifiedId: 'growth/overview', title: 'Overview', filePath: 'apps/growth/dashboards/overview.dqld', blockIds: ['monthly_revenue', 'store_revenue'], tags: [] },
      },
      notebooks: {
        'notebooks/welcome.dqlnb': { title: 'Welcome', filePath: 'notebooks/welcome.dqlnb', cells: [{ id: 'q', type: 'sql', source: 'select 1', tableDependencies: ['dev.orders'], refDependencies: [] }] },
      },
    },
  } as unknown as DQLContext;
}

describe('list_apps', () => {
  it('lists each App with its tiles, the block behind each tile and the trust that block gives it', () => {
    const out = listApps(project(), {});
    expect(out.total).toBe(1);
    const tiles = out.apps[0]!.dashboards[0] as { tiles: Array<{ title: string; block: string; blockStatus: string; trustLabel: string }>; certifiedTiles: number };
    expect(tiles.tiles).toEqual([
      expect.objectContaining({ title: 'Monthly revenue', block: 'monthly_revenue', blockStatus: 'certified', trustLabel: 'Certified' }),
      expect.objectContaining({ title: 'Store revenue', block: 'store_revenue', blockStatus: 'draft', trustLabel: 'Needs review' }),
    ]);
    expect(tiles.certifiedTiles).toBe(1);
    expect(out.apps[0]!.schedules).toEqual([expect.objectContaining({ id: 'weekly', cron: '0 9 * * 1', deliver: ['slack'] })]);
  });

  it('says when nothing matches', () => {
    expect(listApps(project(), { query: 'nothing' })).toMatchObject({ total: 0, note: 'No App matches "nothing".' });
  });
});

describe('list_notebooks', () => {
  it('returns every cell, markdown included, read from the notebook file', () => {
    const out = listNotebooks(project(), {});
    expect('notebooks' in out && out.notebooks[0]).toMatchObject({
      path: 'notebooks/welcome.dqlnb',
      description: 'Start here.',
      cellCount: 2,
      cells: [expect.objectContaining({ type: 'markdown', title: 'Intro', text: '# Hello' }), expect.objectContaining({ type: 'sql', text: 'select 1' })],
      tables: ['dev.orders'],
    });
  });

  it('names the known notebooks when a path does not exist', () => {
    expect(listNotebooks(project(), { path: 'notebooks/missing.dqlnb' })).toEqual({
      ok: false,
      error: 'No notebook at "notebooks/missing.dqlnb". Known notebooks: notebooks/welcome.dqlnb.',
    });
  });
});
