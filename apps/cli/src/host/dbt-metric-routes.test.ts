import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import { routeAction } from './route-actions.js';
import type { DqlAction, DqlHostHooks, DqlPrincipal } from './request-context.js';

const creator: DqlPrincipal = { id: 'u-creator', kind: 'person', email: 'creator@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hooks?: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-routes-'));
  roots.push(projectRoot);
  mkdirSync(join(projectRoot, 'target'), { recursive: true });
  mkdirSync(join(projectRoot, 'models'), { recursive: true });
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'harbor', manifestVersion: 3, modeling: { mode: 'dbt-first' },
    semanticLayer: { provider: 'dbt' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }));
  writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: harbor\nversion: 1\n');
  writeFileSync(join(projectRoot, 'models', 'claims.sql'), 'select 1 as claim_id');
  writeFileSync(join(projectRoot, 'models', 'claims.yml'), [
    'version: 2',
    'semantic_models:',
    '  - name: claims',
    "    model: ref('claims')",
    '    defaults: { agg_time_dimension: reported_date }',
    '    entities: [{ name: claim, type: primary, expr: claim_id }]',
    '    dimensions:',
    '      - { name: reported_date, type: time, type_params: { time_granularity: day } }',
    '    measures:',
    '      - { name: claimed_amount, agg: sum }',
    'metrics:',
    '  - { name: claimed_amount, type: simple, type_params: { measure: claimed_amount } }',
    '',
  ].join('\n'));
  writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
    metadata: { project_name: 'harbor' },
    nodes: { 'model.harbor.claims': { unique_id: 'model.harbor.claims', resource_type: 'model', name: 'claims', original_file_path: 'models/claims.sql', columns: { claim_id: {}, product: {}, claimed_amount: {}, reported_date: {} }, depends_on: { nodes: [] }, tags: [] } },
    sources: {}, exposures: {}, semantic_models: {}, groups: {}, metrics: {}, child_map: {}, parent_map: {},
  }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: () => creator, ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const snapshotId = async () => (await (await fetch(`${base}/api/modeling/dbt-first`)).json() as { snapshotId: string }).snapshotId;
  return { projectRoot, post, snapshotId };
}

const change = {
  mode: 'add',
  semanticModel: 'claims',
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', aggregation: 'average', column: 'claimed_amount' },
  dimensions: [{ name: 'product', column: 'product' }],
};

describe('dbt metric routes', () => {
  it('previews a diff, applies it with the reviewed fingerprint, and reports whether the manifest was refreshed', async () => {
    const { projectRoot, post, snapshotId } = await start();
    const snapshot = await snapshotId();
    const preview = await post('/api/modeling/dbt-first/dbt-metric/preview', { change, expectedSnapshotId: snapshot });
    expect(preview.status).toBe(200);
    expect(preview.body.patches[0]).toMatchObject({ path: 'models/claims.yml', changed: true });
    expect(preview.body.patches[0].after).toContain('average_claimed_amount');
    expect(readFileSync(join(projectRoot, 'models', 'claims.yml'), 'utf8')).not.toContain('average_claimed_amount');

    const stale = await post('/api/modeling/dbt-first/dbt-metric/apply', { change, expectedSnapshotId: snapshot, expectedFingerprint: 'not-the-reviewed-one' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'SOURCE_CHANGED' });

    const applied = await post('/api/modeling/dbt-first/dbt-metric/apply', { change, expectedSnapshotId: snapshot, expectedFingerprint: preview.body.fingerprint });
    expect(applied.status).toBe(200);
    expect(readFileSync(join(projectRoot, 'models', 'claims.yml'), 'utf8')).toContain('average_claimed_amount');
    // Whether `dbt` is installed where the test runs is not this test's business; the answer must be honest either way.
    expect(applied.body.manifestRefresh).toEqual(expect.objectContaining({ refreshed: expect.any(Boolean) }));
    if (!applied.body.manifestRefresh.refreshed) expect(applied.body.manifestRefresh.reason).toMatch(/dbt parse/);
  });

  it('answers a structured 400 for a column that is not on the dbt model, and a 409 for a stale snapshot', async () => {
    const { post, snapshotId } = await start();
    const snapshot = await snapshotId();
    const bad = await post('/api/modeling/dbt-first/dbt-metric/preview', { change: { ...change, metric: { ...change.metric, column: 'claimed_amt' } }, expectedSnapshotId: snapshot });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'DBT_METRIC_INVALID', message: expect.stringMatching(/Unknown column "claimed_amt"/), nextActions: expect.any(Array) });
    const stale = await post('/api/modeling/dbt-first/dbt-metric/preview', { change, expectedSnapshotId: 'stale' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'SOURCE_CHANGED' });
    const none = await post('/api/modeling/dbt-first/dbt-metric/preview', { expectedSnapshotId: snapshot });
    expect(none.status).toBe(400);
  });

  it('keeps refusing a DQL-local metric: the metric is added in dbt, not beside it', async () => {
    const { projectRoot, post } = await start();
    const local = await post('/api/semantic-layer/metric', { name: 'average_claimed_amount', sql: 'avg(claimed_amount)', type: 'avg', table: 'claims' });
    expect(local.status).toBe(409);
    expect(local.body).toMatchObject({ code: 'DQL_MODELING_DBT_OWNED' });
    expect(() => readFileSync(join(projectRoot, 'semantic-layer', 'metrics', 'average_claimed_amount.yaml'))).toThrow();
  });
});

describe('under a host', () => {
  it('classes both routes as dataset.author, so the host that refuses authoring (Production follows main) refuses them', async () => {
    for (const step of ['preview', 'apply']) expect(routeAction('POST', `/api/modeling/dbt-first/dbt-metric/${step}`).action).toBe('dataset.author');
    const asked: DqlAction[] = [];
    const { projectRoot, post, snapshotId } = await start({
      authorize: (_principal, action) => { asked.push(action); return action === 'dataset.author' ? { allow: false, reason: 'Production is read-only; draft a change instead.' } : { allow: true }; },
    });
    const refused = await post('/api/modeling/dbt-first/dbt-metric/apply', { change, expectedSnapshotId: await snapshotId(), expectedFingerprint: 'x' });
    expect(refused.status).toBe(403);
    expect(asked).toContain('dataset.author');
    expect(readFileSync(join(projectRoot, 'models', 'claims.yml'), 'utf8')).not.toContain('average_claimed_amount');
  });
});
