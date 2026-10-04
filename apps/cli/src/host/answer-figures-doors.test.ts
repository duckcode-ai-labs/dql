import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { LocalAppStorage, LocalNotebookResearchStorage, defaultLocalAppsDbPath } from '@duckcodeailabs/dql-project';
import { homePersonKey } from '../home/home-state.js';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-14 on every asking door, through the one decision Ask uses: a person the host keeps needs-review
 * figures from gets no AI-written value from the notebook chat cell, a notebook research run or an App analysis
 * memo. With figures shown, the same records carry their values (the control).
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const FIGURE = 'ADJ-16-CANARY';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(rule: 'show' | 'withhold_review') {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-figures-doors-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'doors' }));
  mkdirSync(join(projectRoot, 'apps', 'claims', 'dashboards'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'claims', 'dql.app.json'), JSON.stringify({
    version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft',
    owners: ['t@example.com'], homepage: { type: 'dashboard', id: 'overview' },
  }));
  // Priya's own memo and research run from before, each with a preview row.
  const apps = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot), { owner: 'u-priya' });
  const memo = apps.createAppInvestigation({ appId: 'claims', question: 'Why did open claims per adjuster change?' });
  apps.updateAppInvestigation(memo.id, { status: 'ready', summary: `${FIGURE} leads`, resultPreviews: [{ title: 'Open claims', result: { columns: ['adjuster', 'open_claims'], rows: [{ adjuster: FIGURE, open_claims: 15 }], rowCount: 1 } }] });
  apps.close();
  const research = new LocalNotebookResearchStorage(join(projectRoot, '.dql', 'local', 'private', 'research', `${homePersonKey(priya)}.sqlite`));
  const run = research.createRun({ notebookPath: 'notebooks/a.dqlnb', title: 'Adjusters', question: 'Which adjusters have the most open claims?' });
  research.updateRun(run.id, { recommendation: `${FIGURE} first`, resultPreview: { columns: ['adjuster'], rows: [{ adjuster: FIGURE }], rowCount: 1 } } as never);
  research.close();
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
    hostHooks: { resolvePrincipal: () => priya, answerFigures: () => rule },
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  return { call, memoId: memo.id, runId: run.id };
}

describe('HH-14 on the other asking doors', () => {
  it('control: with figures shown, the memo and the research run carry their values', async () => {
    const { call, memoId, runId } = await serve('show');
    expect((await call('GET', `/api/apps/claims/investigations/${memoId}`)).text).toContain(FIGURE);
    expect((await call('GET', `/api/notebook/research/${runId}`)).text).toContain(FIGURE);
    expect((await call('POST', '/api/llm/run', { messages: [{ role: 'user', content: 'hi' }] })).text).not.toContain('FIGURES_WITHHELD');
  });

  it('the chat cell is not available, and memos and research runs show their shape, never a value', async () => {
    const { call, memoId, runId } = await serve('withhold_review');
    const chat = await call('POST', '/api/llm/run', { messages: [{ role: 'user', content: 'Which adjusters have the most open claims?' }] });
    expect(chat.status).toBe(403);
    expect(JSON.parse(chat.text)).toMatchObject({ code: 'FIGURES_WITHHELD' });
    for (const path of [`/api/apps/claims/investigations/${memoId}`, '/api/apps/claims/investigations', '/api/apps/claims', `/api/notebook/research/${runId}`, '/api/notebook/research']) {
      const answer = await call('GET', path);
      expect(answer.status, path).toBe(200);
      expect(answer.text, path).not.toContain(FIGURE);
    }
    const memo = JSON.parse((await call('GET', `/api/apps/claims/investigations/${memoId}`)).text).investigation;
    expect(memo).toMatchObject({ figuresWithheld: true, resultPreviews: [{ result: { columns: ['adjuster', 'open_claims'], rowCount: 1, rows: [] } }] });
    // A run they start computes no preview for them.
    const started = await call('POST', '/api/notebook/research', { notebookPath: 'notebooks/b.dqlnb', question: 'Adjusters by open claims', generatedSql: 'SELECT 1', run: true });
    expect(started.status).toBe(201);
    expect(JSON.parse(started.text).run).toMatchObject({ figuresWithheld: true });
    expect((await call('POST', `/api/notebook/research/${runId}/run`, {})).text).not.toContain(FIGURE);
  });
});
