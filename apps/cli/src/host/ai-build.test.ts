import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';
import { routeAction } from './route-actions.js';

/**
 * Building with AI follows the same authoring rules as any other edit. With a host: building a block is
 * authoring (`dataset.author`), so a host's role ladder and read-only Production apply; a draft is written
 * only where one person works; an edit stays on a block file inside the project; a certified block is never
 * rewritten in place. Building a notebook cell (`/api/ai/build/cell`) returns SQL and writes nothing: asking.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', displayName: 'Priya Shah', source: 'host' };
const CERTIFIED = `block "Open claims" {\n  domain = "claims"\n  type = "custom"\n  status = "certified"\n  owner = "maria@harbor.example"\n  query = """SELECT 1 AS n"""\n}\n`;
const DRAFT = CERTIFIED.replace('status = "certified"', 'status = "draft"').replace('Open claims', 'Open claims draft');

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(join(tmpdir(), 'dql-ai-build-outside.dql'), { force: true });
});

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === '.dql') continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else out.set(path, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  walk(root, '');
  return out;
}

async function start(hooks?: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-ai-build-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'build' }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'blocks', 'open-claims.dql'), CERTIFIED);
  writeFileSync(join(projectRoot, 'blocks', 'open-claims-draft.dql'), DRAFT);
  writeFileSync(join(tmpdir(), 'dql-ai-build-outside.dql'), DRAFT);
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: () => priya, ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  return { call, projectRoot };
}

describe('building with AI follows the same authoring rules as other edits', () => {
  it('classes building a block as authoring, building a cell as asking, and an unlisted route under the ask families as a change', () => {
    expect(routeAction('POST', '/api/ai/build').action).toBe('dataset.author');
    expect(routeAction('POST', '/api/ai/build/cell').action).toBe('ask');
    expect(routeAction('POST', '/api/agent-runs').action).toBe('ask');
    expect(routeAction('POST', '/api/agent-runs/r1/cancel').action).toBe('ask');
    expect(routeAction('POST', '/api/agent-runs/r1/app-autopilot-changes/c1/apply').action).toBe('app.author');
    expect(routeAction('POST', '/api/agent/memory/default-files').action).toBe('project.write');
    expect(routeAction('POST', '/api/agent/threads/t1/promote').action).toBe('ask');
    expect(routeAction('POST', '/api/notebook/research/r1/seed').action).toBe('research');
    for (const path of ['/api/ai/anything-new', '/api/agent/new-writer', '/api/agent-runs/r1/new-writer', '/api/ask/new', '/api/llm/new', '/api/host/new']) {
      expect(routeAction('POST', path).action, path).toBe('project.write');
    }
    expect(routeAction('POST', '/api/host/answer-status').action).toBe('project.read');
  });

  it('with a host, writes no draft where several people work, never rewrites a certified block, and keeps an edit inside the project', async () => {
    const { call, projectRoot } = await start({});
    const before = snapshot(projectRoot);
    const create = await call('/api/ai/build', { prompt: 'count claims by region', target: 'block' });
    expect(create.status, create.text).toBe(409);
    expect(create.text).toContain('BUILD_IN_DRAFT_SPACE');
    const certified = await call('/api/ai/build', { prompt: 'count every claim', target: 'block', mode: 'edit', blockPath: 'blocks/open-claims.dql' });
    expect(certified.status, certified.text).toBe(409);
    expect(certified.text).toContain('CERTIFIED_BLOCK');
    for (const blockPath of ['../dql-ai-build-outside.dql', join(tmpdir(), 'dql-ai-build-outside.dql'), 'dql.config.json', '.dql/local/private/x.dql']) {
      const outside = await call('/api/ai/build', { prompt: 'x', target: 'block', mode: 'edit', blockPath });
      expect(outside.status, blockPath).toBe(404);
    }
    const cellAsBlock = await call('/api/ai/build/cell', { prompt: 'x', target: 'block' });
    expect(cellAsBlock.status).toBe(400);
    expect(snapshot(projectRoot)).toEqual(before);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(false);
  });

  it('with a host, a draft is written where one person works, and the project keeps no owner it was not given', async () => {
    const { call, projectRoot } = await start({ onePerson: true });
    const config = readFileSync(join(projectRoot, 'dql.config.json'), 'utf8');
    const create = await call('/api/ai/build', { prompt: 'count claims by region', target: 'block', owner: 'someone-else@harbor.example' });
    expect(create.status, create.text).toBe(200);
    expect(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')).toBe(config);
    const drafts = readdirSync(join(projectRoot, 'blocks', '_drafts'));
    expect(drafts.length).toBe(1);
    const draft = readFileSync(join(projectRoot, 'blocks', '_drafts', drafts[0]), 'utf8');
    expect(draft).toContain('status = "draft"');
    expect(draft).not.toContain('someone-else@harbor.example');
    // Still: a certified block is not rewritten in place, even in one person's space.
    expect((await call('/api/ai/build', { prompt: 'x', target: 'block', mode: 'edit', blockPath: 'blocks/open-claims.dql' })).status).toBe(409);
    expect(readFileSync(join(projectRoot, 'blocks', 'open-claims.dql'), 'utf8')).toBe(CERTIFIED);
  });

  it('without a host, both routes build as before', async () => {
    const { call, projectRoot } = await start();
    const cell = await call('/api/ai/build/cell', { prompt: 'count claims', target: 'cell' });
    expect(cell.status, cell.text).toBe(200);
    const block = await call('/api/ai/build', { prompt: 'count claims by region', target: 'block' });
    expect(block.status, block.text).toBe(200);
    expect(existsSync(join(projectRoot, 'blocks', '_drafts'))).toBe(true);
  });
});
