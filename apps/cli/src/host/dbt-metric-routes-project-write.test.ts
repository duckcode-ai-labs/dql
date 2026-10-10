import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlAction, DqlHostHooks, DqlPrincipal } from './request-context.js';

const creator: DqlPrincipal = { id: 'u-creator', kind: 'person', email: 'creator@harbor.example', source: 'host' };

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hooks: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-metric-pw-'));
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
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
    hostHooks: { resolvePrincipal: () => creator, ...hooks },
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
  metric: { name: 'average_claimed_amount', label: 'Average claimed amount', aggregation: 'average', column: 'claimed_amount', synonyms: ['avg claim'] },
  dimensions: [{ name: 'product', column: 'product' }],
};

describe('dbt metric apply needs project.write as well as dataset.author', () => {
  it('refuses a host that allows dataset.author but refuses project.write (Production follows main), and writes nothing', async () => {
    const asked: DqlAction[] = [];
    const { projectRoot, post, snapshotId } = await start({
      authorize: (_principal, action) => { asked.push(action); return action === 'project.write' ? { allow: false, reason: 'Production follows main.' } : { allow: true }; },
    });
    const snapshot = await snapshotId();
    const preview = await post('/api/modeling/dbt-first/dbt-metric/preview', { change, expectedSnapshotId: snapshot });
    expect(preview.status).toBe(200);
    const refused = await post('/api/modeling/dbt-first/dbt-metric/apply', { change, expectedSnapshotId: snapshot, expectedFingerprint: preview.body.fingerprint });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'HOST_REFUSED', message: 'Production follows main.' });
    expect(asked).toEqual(expect.arrayContaining(['dataset.author', 'project.write']));
    expect(readFileSync(join(projectRoot, 'models', 'claims.yml'), 'utf8')).not.toContain('average_claimed_amount');
  });

  it('applies, with the synonyms in the same YAML, when the host allows both (a draft space)', async () => {
    const { projectRoot, post, snapshotId } = await start({ authorize: () => ({ allow: true }) });
    const snapshot = await snapshotId();
    const preview = await post('/api/modeling/dbt-first/dbt-metric/preview', { change, expectedSnapshotId: snapshot });
    expect(preview.body.patches[0].after).toContain('avg claim');
    const applied = await post('/api/modeling/dbt-first/dbt-metric/apply', { change, expectedSnapshotId: snapshot, expectedFingerprint: preview.body.fingerprint });
    expect(applied.status).toBe(200);
    const written = readFileSync(join(projectRoot, 'models', 'claims.yml'), 'utf8');
    expect(written).toContain('average_claimed_amount');
    expect(written).toContain('avg claim');
  });
});
