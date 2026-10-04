import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { minimalChildEnv, startLocalServer } from '../local-runtime.js';
import { listMetricFlowDimensions } from '../metricflow.js';
import { routeAction } from './route-actions.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * With a host, a program DQL runs on project content (dbt parse during
 * onboarding) gets a minimal environment, never the server's secrets; setting
 * the project up is an administrator's action, and its paths stay inside the
 * project.
 */
const CANARY = 'CANARY-CHILD-ENV-7f3a';
const servers: Server[] = [];
const roots: string[] = [];
const savedPath = process.env.PATH;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PATH = savedPath;
  delete process.env.DQL_TEST_SECRET_FOR_CHILD;
  delete process.env.DQL_METRICFLOW_BIN;
  delete process.env.DBT_TEST_WAREHOUSE_ACCOUNT;
});

describe('children run on project content with a minimal environment', () => {
  it('minimalChildEnv keeps where programs are and drops everything else', () => {
    process.env.DQL_TEST_SECRET_FOR_CHILD = CANARY;
    const env = minimalChildEnv({ EXTRA: 'x' });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.EXTRA).toBe('x');
    expect(JSON.stringify(env)).not.toContain(CANARY);
  });

  it('with a host, MetricFlow reads the project with dbt\'s own settings only, never the server\'s secrets', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-child-env-mf-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'child_env_mf' }));
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'dbt_project.yml'), 'name: x\n');
    writeFileSync(join(projectRoot, 'target', 'semantic_manifest.json'), '{}');
    // A stand-in `mf` that answers --version and writes the environment it was given.
    const seen = join(projectRoot, 'seen-mf-env.json');
    const mf = join(projectRoot, 'mf-stand-in');
    writeFileSync(mf, `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('mf, version 0.207.0'); process.exit(0); }\nrequire('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\nprocess.exit(1);\n`);
    chmodSync(mf, 0o755);
    process.env.DQL_METRICFLOW_BIN = mf;
    process.env.DQL_TEST_SECRET_FOR_CHILD = CANARY;
    process.env.DBT_TEST_WAREHOUSE_ACCOUNT = 'harbor';
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      hostHooks: { resolvePrincipal: () => ({ id: 'u-a', kind: 'person', source: 'host' }) },
      captureServer: (created) => { servers.push(created); },
    });
    expect(port).toBeGreaterThan(0);
    await listMetricFlowDimensions({ projectRoot, metrics: ['claims_paid'] });
    const env = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain(CANARY);
    expect(env.DBT_TEST_WAREHOUSE_ACCOUNT).toBe('harbor');
  });

  it('setting the project up and installing drivers are the administrator\'s', () => {
    expect(routeAction('POST', '/api/onboarding/dbt/apply').action).toBe('settings.manage');
    expect(routeAction('POST', '/api/connectors/install').action).toBe('settings.manage');
    expect(routeAction('GET', '/api/onboarding/status').action).toBe('project.read');
  });

  it('a hosted dbt parse does not see the server\'s secrets, and stays inside the project', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-child-env-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'child_env' }));
    mkdirSync(join(projectRoot, 'dbt'), { recursive: true });
    writeFileSync(join(projectRoot, 'dbt', 'dbt_project.yml'), 'name: x\n');
    // A stand-in `dbt` that writes the environment it was given.
    const bin = join(projectRoot, '.bin');
    mkdirSync(bin);
    const seen = join(projectRoot, 'seen-env.json');
    writeFileSync(join(bin, 'dbt'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\nprocess.exit(1);\n`);
    chmodSync(join(bin, 'dbt'), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    process.env.DQL_TEST_SECRET_FOR_CHILD = CANARY;
    const admin: DqlPrincipal = { id: 'u-admin', kind: 'person', source: 'host' };
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
      hostHooks: { resolvePrincipal: () => admin, authorize: () => ({ allow: true }) },
      captureServer: (created) => { servers.push(created); },
    });
    const apply = (projectDir: string) => fetch(`http://127.0.0.1:${port}/api/onboarding/dbt/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, buildArtifacts: true }) });
    await apply('dbt');
    expect(existsSync(seen)).toBe(true);
    expect(readFileSync(seen, 'utf8')).not.toContain(CANARY);
    rmSync(seen);
    const outside = await apply('../');
    expect(outside.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(seen)).toBe(false);
  });
});
