import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-14 on AI pins: an AI-written pin (an answer pinned to an App page, with its stored rows) holds
 * needs-review figures. A person the host keeps them from reads their own pin as its question, SQL and result shape
 * only: when it is made, listed, refreshed, opened with the App and run on the page. With figures shown the same
 * reads carry the figure (the control).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@insurer.example', source: 'host' };
const FIGURE = 'CANARY-PIN-FIGURE-2290';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(rule: 'show' | 'withhold_review') {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-figures-pins-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'pins' }));
  mkdirSync(join(projectRoot, 'apps', 'claims', 'dashboards'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
    version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
    owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1, id: 'overview', metadata: { title: 'Overview' }, layout: { kind: 'grid', cols: 12, rowHeight: 40, items: [] },
  }));
  const executor = { executeQuery: async () => ({ columns: [{ name: 'region' }, { name: 'open_claims' }], rows: [{ region: 'West', open_claims: FIGURE }], rowCount: 1 }) } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, connection: { driver: 'duckdb', filepath: ':memory:' }, preferredPort: 0,
    hostHooks: { resolvePrincipal: () => priya, answerFigures: () => rule, onePerson: true },
    captureServer: (created) => { servers.push(created); },
  });
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
}

describe('AI pins for a person whose needs-review figures the host withholds (HH-14)', () => {
  it.each(['show', 'withhold_review'] as const)('made, listed, refreshed, in the App and on the page (%s)', async (rule) => {
    const call = await serve(rule);
    const pinned = await call('POST', '/api/apps/claims/ai-pins', {
      dashboardId: 'overview', title: 'Open claims', question: 'Open claims by region', answer: `West has ${FIGURE} open claims`,
      sql: 'SELECT region, COUNT(*) AS open_claims FROM claims GROUP BY region', result: { columns: ['region', 'open_claims'], rows: [{ region: 'West', open_claims: FIGURE }] },
    });
    expect(pinned.status, pinned.text.slice(0, 300)).toBe(201);
    const pinId = pinned.body.pin.id as string;
    const reads = [
      ['made', pinned.text],
      ['listed', (await call('GET', '/api/apps/claims/ai-pins')).text],
      ['refreshed', (await call('POST', `/api/apps/claims/ai-pins/${pinId}/refresh`, {})).text],
      ['in the App', (await call('GET', '/api/apps/claims')).text],
      ['on the page', (await call('POST', '/api/apps/claims/dashboards/overview/run', {})).text],
    ] as const;
    for (const [where, text] of reads) {
      if (rule === 'show') expect(text, where).toContain(FIGURE);
      else expect(text, where).not.toContain('CANARY-PIN-FIGURE');
    }
    if (rule === 'withhold_review') {
      const listed = (await call('GET', '/api/apps/claims/ai-pins')).body.pins[0];
      expect(listed).toMatchObject({ figuresWithheld: true, question: 'Open claims by region', result: { columns: ['region', 'open_claims'], rows: [] } });
    }
  });
});
