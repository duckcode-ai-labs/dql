import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { HOSTED_FILE_REFUSED, startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * RFC 0010: with a host, the file routes serve project content only, never
 * the runtime's own folders (caches, run traces, per-person Home state,
 * stored secrets), git's files, the connection settings, data or a database
 * file; a symlink is judged by where it points. A notebook's last run is
 * kept per person. Without a host the one user opens what they like, as before.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const SECRET = 'CANARY-FILE-ROUTE-SECRET-7f3a';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hooks?: Partial<DqlHostHooks>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-file-routes-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'files', note: SECRET }));
  mkdirSync(join(projectRoot, 'notebooks'), { recursive: true });
  writeFileSync(join(projectRoot, 'notebooks', 'claims.dqlnb'), JSON.stringify({ version: 1, title: 'Claims', cells: [] }));
  mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'home'), { recursive: true });
  writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'connection-secrets.json'), JSON.stringify({ default: { password: SECRET } }));
  writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'home', 'p-dan.json'), JSON.stringify({ figures: SECRET }));
  mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'notebooks'), { recursive: true });
  writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'notebooks', 'mine.dqlnb'), JSON.stringify({ version: 1, title: SECRET, cells: [] }));
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  writeFileSync(join(projectRoot, '.git', 'config'), `[remote] url = ${SECRET}`);
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  writeFileSync(join(projectRoot, 'data', 'claims.csv'), `id,ssn\n1,${SECRET}\n`);
  writeFileSync(join(projectRoot, 'warehouse.duckdb'), SECRET);
  writeFileSync(join(projectRoot, 'notebooks', 'claims.run.json'), JSON.stringify({ version: 1, cells: [{ rows: [{ ssn: SECRET }] }] }));
  symlinkSync(join(projectRoot, '.dql', 'local', 'private', 'connection-secrets.json'), join(projectRoot, 'notebooks', 'link.json'));
  const people: Record<string, DqlPrincipal> = { priya, dan };
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  return { call, projectRoot };
}

const REFUSED = ['notebooks/claims.run.json', '.dql/local/private/connection-secrets.json', '.dql/local/private/home/p-dan.json', '.dql/local/private/notebooks/mine.dqlnb', '.git/config', 'dql.config.json', 'data/claims.csv', 'warehouse.duckdb', 'notebooks/link.json', 'notebooks/../.git/config', './.dql/local/private/connection-secrets.json'];

describe('with a host, file routes serve project content only', () => {
  it('refuses the runtime\'s folders, git, settings, data, databases and symlinks out of bounds, by either route', async () => {
    const { call } = await start({});
    for (const route of ['/api/notebook-content', '/api/notebook/file']) {
      for (const path of REFUSED) {
        const answer = await call('priya', 'GET', `${route}?path=${encodeURIComponent(path)}`);
        expect(answer.status, `${route} ${path}`).toBe(403);
        expect(answer.text, `${route} ${path}`).not.toContain(SECRET);
      }
      const notebook = await call('priya', 'GET', `${route}?path=${encodeURIComponent('notebooks/claims.dqlnb')}`);
      expect(notebook.status).toBe(200);
      expect(notebook.text).toContain('Claims');
    }
  });

  it('refuses writes into git, the runtime\'s folders and the settings', async () => {
    const { call, projectRoot } = await start({});
    for (const path of ['.git/hooks/pre-commit.json', '.dql/local/private/x.json', 'dql.config.json']) {
      expect((await call('priya', 'PUT', '/api/notebook-content', { path, content: '{}' })).status, path).toBe(403);
    }
    expect(existsSync(join(projectRoot, '.git', 'hooks', 'pre-commit.json'))).toBe(false);
  });

  it('lists no private drafts or hidden files, names no server path, and shows only the connection\'s kind', async () => {
    const { call } = await start({});
    const listed = await call('priya', 'GET', '/api/notebooks');
    expect(listed.text).not.toContain('mine.dqlnb');
    const boot = await call('priya', 'GET', '/api/notebook/bootstrap');
    expect(boot.status).toBe(200);
    const body = JSON.parse(boot.text) as { projectRoot?: string; files: string[] };
    expect(body.projectRoot).toBeUndefined();
    expect(body.files.some((file) => file.startsWith('.') || file === 'dql.config.json')).toBe(false);
    expect(body.files).toContain('notebooks/claims.dqlnb');
  });

  it('keeps a notebook\'s last run per person', async () => {
    const { call } = await start({});
    expect((await call('dan', 'PUT', '/api/run-snapshot', { path: 'notebooks/claims.dqlnb', snapshot: { cells: [{ result: SECRET }] } })).status).toBe(200);
    expect((await call('dan', 'GET', '/api/run-snapshot?path=notebooks%2Fclaims.dqlnb')).text).toContain(SECRET);
    const priyas = await call('priya', 'GET', '/api/run-snapshot?path=notebooks%2Fclaims.dqlnb');
    expect(priyas.text).not.toContain(SECRET);
    expect(JSON.parse(priyas.text)).toEqual({ found: false, snapshot: null });
  });

  it('runs a block named by file only when the file is a project block, whether or not it exists', async () => {
    const { call } = await start({});
    const artifact = (sourcePath: string) => ({ artifact: { kind: 'sql_block', source: 'SELECT 1', sourcePath } });
    const named = [...REFUSED, 'notebooks/claims.dqlnb', '.dql/local/private/missing.dql', '.git/never.dql', 'data/nothing.dql', 'blocks/../.dql/local/private/x.dql', '/etc/hosts'];
    for (const path of named) {
      const answer = await call('priya', 'POST', '/api/dql/artifacts/execute', artifact(path));
      expect(answer.status, path).toBe(403);
      expect(JSON.parse(answer.text), path).toEqual({ error: HOSTED_FILE_REFUSED, code: 'PERMISSION_DENIED' });
    }
    // A project block file passes the file rule (what happens next is the block's run, not a file refusal).
    const block = await call('priya', 'POST', '/api/dql/artifacts/execute', { artifact: { kind: 'sql_block', source: 'block "x" { type = "custom" query = """SELECT 1""" }', sourcePath: 'blocks/x.dql' } });
    expect(block.text).not.toContain(HOSTED_FILE_REFUSED);
  });

  it('reads no file a request names outside project content, on any route that reads one', async () => {
    const { call, projectRoot } = await start({});
    // A folder of SQL inside the project, one beside it in a dot folder, and one outside the project.
    mkdirSync(join(projectRoot, 'sql'), { recursive: true });
    writeFileSync(join(projectRoot, 'sql', 'claims.sql'), 'SELECT 1 AS open_claims');
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'secret.sql'), `SELECT '${SECRET}'`);
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'models.yml'), `models: [{ name: '${SECRET}' }]`);
    writeFileSync(join(projectRoot, 'profiles.yml'), `harbor: { outputs: { prod: { password: '${SECRET}' } } }`);
    const outside = mkdtempSync(join(tmpdir(), 'dql-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'other.sql'), `SELECT '${SECRET}'`);
    symlinkSync(join(projectRoot, '.dql', 'local', 'private', 'secret.sql'), join(projectRoot, 'sql', 'linked.sql'));
    const refused = async (method: string, route: string, body?: unknown) => {
      const answer = await call('priya', method, route, body);
      expect(answer.status, `${route} ${JSON.stringify(body)}`).toBe(403);
      expect(answer.text).not.toContain(SECRET);
    };
    for (const path of ['.dql/local/private', '.dql/local/private/secret.sql', outside, join(outside, 'other.sql'), '../', '~/.ssh', 'data']) {
      await refused('POST', '/api/block-studio/imports', { path, inputMode: 'path' });
      await refused('POST', '/api/block-studio/ai-imports', { path, inputMode: 'path' });
      await refused('POST', '/api/modeling/dbt-first/imports', { source: { mode: 'path', path } });
      await refused('PUT', '/api/skills/settings', { path });
      await refused('POST', '/api/semantic-layer/import-preview', { provider: 'dbt', projectPath: path });
    }
    await refused('POST', '/api/connections/dbt-profiles/preview', { path: '~/.dbt' });
    await refused('POST', '/api/connections/dbt-profiles/preview', { path: outside });
    await refused('POST', '/api/datasets/import', { sourcePath: join(outside, 'other.sql'), filename: 'x.csv' });
    // An import that names no path reads nothing: the route's own answer, not a file refusal.
    for (const route of ['/api/block-studio/imports', '/api/block-studio/import/preview', '/api/block-studio/ai-imports']) {
      const unnamed = await call('priya', 'POST', route, {});
      expect(unnamed.text, route).not.toContain(HOSTED_FILE_REFUSED);
      expect(unnamed.status, route).not.toBe(403);
    }
    // A folder of the project imports its own SQL only: not the file a symlink in it points at in a dot folder.
    const imported = await call('priya', 'POST', '/api/block-studio/imports', { path: 'sql', inputMode: 'path' });
    expect(imported.status, imported.text.slice(0, 200)).toBe(200);
    expect(imported.text).toContain('open_claims');
    expect(imported.text).not.toContain(SECRET);
    // Scanning the project's own YAML leaves out dot folders and dbt profiles.
    const scanned = await call('priya', 'POST', '/api/modeling/dbt-first/imports', { source: { mode: 'current_project' } });
    expect(scanned.text).not.toContain(SECRET);
    // Ids a request names stay ids: never a path to another file.
    for (const id of ['..%2F..%2F..%2Fdql.config', '..', '.hidden']) {
      const hint = await call('priya', 'GET', `/api/agent/hints/${id}`);
      expect(hint.text).not.toContain(SECRET);
    }
  });

  it('shows a diff of project content only, matching the path it names literally', async () => {
    const { call, projectRoot } = await start({});
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.test' } }).toString();
    git('init', '-q');
    git('add', 'dql.config.json', 'notebooks/claims.dqlnb');
    git('commit', '-q', '-m', 'start');
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'files', note: `${SECRET}-changed` }));
    writeFileSync(join(projectRoot, 'notebooks', 'claims.dqlnb'), JSON.stringify({ version: 1, title: 'Claims, revised', cells: [] }));
    for (const path of ['dql.config.json', '.git/config', '.dql/local/private/connection-secrets.json', '../x.dql']) {
      const answer = await call('priya', 'GET', `/api/git/diff?path=${encodeURIComponent(path)}`);
      expect(answer.status, path).toBe(403);
      expect(answer.text, path).not.toContain(SECRET);
    }
    // A pattern or git's pathspec magic is a file name like any other: it matches nothing here.
    for (const path of ['*.json', ':(top)dql.config.json', ':!notebooks', '[d]ql.config.json']) {
      const answer = await call('priya', 'GET', `/api/git/diff?path=${encodeURIComponent(path)}`);
      expect(answer.text, path).not.toContain(SECRET);
      if (answer.status === 200) expect(JSON.parse(answer.text).diff, path).toBe('');
    }
    const whole = await call('priya', 'GET', '/api/git/diff');
    expect(whole.status).toBe(200);
    expect(whole.text).toContain('Claims, revised');
    expect(whole.text).not.toContain(SECRET);
    const one = await call('priya', 'GET', `/api/git/diff?path=${encodeURIComponent('notebooks/claims.dqlnb')}`);
    expect(one.text).toContain('Claims, revised');
  });

  it('opens a block in Block Studio only when it is project content, a symlink judged by where it points', async () => {
    const { call, projectRoot } = await start({});
    mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'claims.dql'), 'block "claims" {\n  type = "custom"\n  query = """SELECT 1 AS open_claims"""\n}\n');
    symlinkSync(join(projectRoot, '.dql', 'local', 'private', 'connection-secrets.json'), join(projectRoot, 'blocks', 'linked.dql'));
    mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'blocks', 'theirs.dql'), `block "theirs" { query = """SELECT '${SECRET}'""" }`);
    for (const path of ['blocks/linked.dql', '.dql/local/private/blocks/theirs.dql', 'blocks/../dql.config.json', 'blocks/missing-secret.dql/..']) {
      const answer = await call('priya', 'GET', `/api/block-studio/open?path=${encodeURIComponent(path)}`);
      expect(answer.status, path).toBe(403);
      expect(answer.text, path).not.toContain(SECRET);
    }
    const opened = await call('priya', 'GET', `/api/block-studio/open?path=${encodeURIComponent('blocks/claims.dql')}`);
    expect(opened.status, opened.text.slice(0, 200)).toBe(200);
    expect(opened.text).toContain('open_claims');
    // A block's history is a project file's history too.
    for (const path of ['dql.config.json', '.dql/local/private/blocks/theirs.dql', 'blocks/linked.dql']) {
      expect((await call('priya', 'GET', `/api/blocks/history?path=${encodeURIComponent(path)}`)).status, path).toBe(403);
    }
    expect((await call('priya', 'GET', `/api/blocks/history?path=${encodeURIComponent('blocks/claims.dql')}`)).status).toBe(200);
  });

  it('opens private drafts where one person uses the server', async () => {
    const { call } = await start({ onePerson: true });
    expect((await call('priya', 'GET', `/api/notebook-content?path=${encodeURIComponent('.dql/local/private/notebooks/mine.dqlnb')}`)).status).toBe(200);
    expect((await call('priya', 'GET', `/api/notebook-content?path=${encodeURIComponent('.dql/local/private/connection-secrets.json')}`)).status).toBe(403);
  });
});

describe('without a host, the one user opens their own files as before', () => {
  it('imports SQL from a folder they name, and shows the whole diff', async () => {
    const { call, projectRoot } = await start();
    const outside = mkdtempSync(join(tmpdir(), 'dql-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'other.sql'), 'SELECT 2 AS mine');
    const imported = await call('', 'POST', '/api/block-studio/imports', { path: outside, inputMode: 'path' });
    expect(imported.status, imported.text.slice(0, 200)).toBe(200);
    expect(imported.text).toContain('mine');
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    expect((await call('', 'GET', `/api/git/diff?path=${encodeURIComponent('dql.config.json')}`)).status).toBe(200);
  });

  it('reads what is in the project', async () => {
    const { call, projectRoot } = await start();
    mkdirSync(join(projectRoot, '.dql', 'local', 'private', 'blocks'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'private', 'blocks', 'mine.dql'), 'block "mine" {\n  type = "custom"\n  query = """SELECT 1 AS my_draft"""\n}\n');
    const privateBlock = await call('', 'GET', `/api/block-studio/open?path=${encodeURIComponent('.dql/local/private/blocks/mine.dql')}`);
    expect(privateBlock.status, privateBlock.text.slice(0, 200)).toBe(200);
    expect(privateBlock.text).toContain('my_draft');
    expect((await call('', 'GET', `/api/notebook-content?path=${encodeURIComponent('.dql/local/private/notebooks/mine.dqlnb')}`)).status).toBe(200);
    expect((await call('', 'GET', `/api/notebook/file?path=${encodeURIComponent('dql.config.json')}`)).status).toBe(200);
    const boot = JSON.parse((await call('', 'GET', '/api/notebook/bootstrap')).text) as { projectRoot?: string };
    expect(typeof boot.projectRoot).toBe('string');
  });
});
