#!/usr/bin/env node
// The single-user product (no host) before and after a change.
//
// Starts two `dql notebook` servers, one from each built CLI, on two identical copies of one scratch project, sends
// both the same scripted golden paths (notebook, Ask without a model, Apps / App Studio / Show Me / pivots, Block
// Studio certify / deprecate / replacedBy, git panel, connectors, export, request-chosen connections, files by path,
// fonts, MCP over stdio) and diffs status codes and key response fields after normalising run-specific values (ids,
// times, fingerprints, the project's own path). Writes a table and a JSON transcript; exits 1 when any step differs.
//
// usage: node standalone-diff.mjs --baseline <repo with built CLI> --candidate <repo with built CLI> --out <dir>
//          [--port-a 9281] [--port-b 9282] [--pg-port 9290] [--keep]
// env:   DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT (pinned duckdb driver), HOST_CHECK_PG_NODE_MODULES (a node_modules holding
//        `pg`, optional), HOST_CHECK_NETWORK_LOG=1 (optional: both servers and the MCP clients load the CLI's own
//        recorder, apps/cli/scripts/network-log.cjs, and each writes the lookups and connections it starts off this
//        machine to netlog-<label>.jsonl in the output folder)
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]] : pairs), []));
const baselineRepo = resolve(args.baseline);
const candidateRepo = resolve(args.candidate);
const out = resolve(args.out);
const portA = Number(args['port-a'] ?? 9281);
const portB = Number(args['port-b'] ?? 9282);
const pgPort = Number(args['pg-port'] ?? 9290);
const connectorRoot = process.env.DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT;
if (!connectorRoot) throw new Error('Set DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT');
mkdirSync(out, { recursive: true });

const scratch = mkdtempSync(join(tmpdir(), 'standalone-diff-'));
const log = (line) => { process.stdout.write(`${line}\n`); };
const children = [];
let pgData;

async function main() {
  // ── The scratch project: the App Datasets pilot (DuckDB, Apps, Datasets, semantic layer), plus a notebook, a draft
  // block, a CSV, a SQLite and (when available) a PostgreSQL connection, in a git repository.
  const template = join(scratch, 'template');
  cpSync(join(candidateRepo, 'apps/cli/test/fixtures/app-datasets-pilot'), template, { recursive: true });
  execFileSync(process.execPath, [join(candidateRepo, 'scripts/seed-eval-warehouse.mjs'), '--seed', join(template, 'seeds/seed.json'), '--connector-root', connectorRoot, '--out', join(template, 'app-datasets-pilot.duckdb')], { stdio: 'pipe' });
  mkdirSync(join(template, 'data'), { recursive: true });
  writeFileSync(join(template, 'data', 'regions.csv'), 'region,target\nCA,10\nUS,20\n');
  const requireFromCandidate = createRequire(join(candidateRepo, 'packages/dql-agent/package.json'));
  const Sqlite = requireFromCandidate('better-sqlite3');
  const lite = new Sqlite(join(template, 'data', 'lite.sqlite'));
  lite.exec("CREATE TABLE notes (id INTEGER, note TEXT); INSERT INTO notes VALUES (1, 'alpha'), (2, 'beta');");
  lite.close();
  const config = JSON.parse(readFileSync(join(template, 'dql.config.json'), 'utf8'));
  config.connections.lite = { driver: 'sqlite', filepath: 'data/lite.sqlite' };
  const pgModules = process.env.HOST_CHECK_PG_NODE_MODULES;
  let pgReady = false;
  if (pgModules && existsSync(join(pgModules, 'pg'))) {
    pgData = join(scratch, 'pg');
    execFileSync('initdb', ['-D', pgData, '--auth=trust', '-U', 'dqlcheck', '--no-instructions'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', pgData, '-o', `-p ${pgPort} -k ${scratch} -c listen_addresses=127.0.0.1`, '-l', join(scratch, 'pg.log'), '-w', 'start'], { stdio: 'pipe' });
    execFileSync('psql', ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'dqlcheck', '-d', 'postgres', '-c', "CREATE TABLE claims (id int, region text, amount numeric); INSERT INTO claims VALUES (1, 'West', 100), (2, 'East', 250.5);"], { stdio: 'pipe' });
    log(`postgres pid ${readFileSync(join(pgData, 'postmaster.pid'), 'utf8').split('\n')[0]} on ${pgPort}`);
    config.connections.pg = { driver: 'postgresql', host: '127.0.0.1', port: pgPort, database: 'postgres', username: 'dqlcheck' };
    pgReady = true;
  }
  writeFileSync(join(template, 'dql.config.json'), JSON.stringify(config, null, 2));
  mkdirSync(join(template, 'notebooks'), { recursive: true });
  writeFileSync(join(template, 'notebooks', 'golden.dqlnb'), JSON.stringify({ dqlnbVersion: 2, version: 1, title: 'Golden', metadata: { createdWith: 'dql' }, cells: [{ id: 'c1', type: 'sql', name: 'by_region', source: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' }] }, null, 1));
  writeFileSync(join(template, 'domains/commerce/blocks/golden_old.dql'), 'block "golden_old" {\n  domain = "commerce"\n  type = "custom"\n  description = "Order lines by region (old)"\n  owner = "analyst@example.test"\n  query = """SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region"""\n}\n');
  // The connector folder holds the drivers the project uses, so nothing is installed.
  const modules = join(template, '.dql', 'connectors', 'node_modules');
  mkdirSync(modules, { recursive: true });
  symlinkSync(join(connectorRoot, 'node_modules', 'duckdb'), join(modules, 'duckdb'), 'dir');
  symlinkSync(requireFromCandidate.resolve('better-sqlite3').replace(/\/lib\/index\.js$/, ''), join(modules, 'better-sqlite3'), 'dir');
  if (pgReady) symlinkSync(join(pgModules, 'pg'), join(modules, 'pg'), 'dir');
  writeFileSync(join(template, '.gitignore'), '.dql/\n*.duckdb\n*.duckdb.wal\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: template });
  execFileSync('git', ['-c', 'user.email=check@example.test', '-c', 'user.name=Check', 'add', '-A'], { cwd: template });
  execFileSync('git', ['-c', 'user.email=check@example.test', '-c', 'user.name=Check', 'commit', '-q', '-m', 'scratch'], { cwd: template });

  const dirA = join(scratch, 'a');
  const dirB = join(scratch, 'b');
  cpSync(template, dirA, { recursive: true, verbatimSymlinks: true });
  cpSync(template, dirB, { recursive: true, verbatimSymlinks: true });

  // ── Two servers, the same environment: no version check, npm offline against a loopback registry.
  const env = (netlog) => ({
    ...process.env,
    DQL_DISABLE_VERSION_CHECK: '1',
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9/',
    DBT_PROFILES_DIR: join(scratch, 'no-dbt-profiles'),
    ...(process.env.HOST_CHECK_NETWORK_LOG ? { NODE_OPTIONS: `--require ${join(candidateRepo, 'apps/cli/scripts/network-log.cjs')}`, DQL_NETWORK_LOG: netlog } : {}),
  });
  const start = (repo, dir, port, label) => {
    const child = spawn(process.execPath, [join(repo, 'apps/cli/dist/index.js'), 'notebook', dir, '--port', String(port), '--no-open', '--no-schedules'], { cwd: dir, env: env(join(out, `netlog-${label}.jsonl`)), stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    child.stdout.on('data', (chunk) => lines.push(String(chunk)));
    child.stderr.on('data', (chunk) => lines.push(String(chunk)));
    child.on('exit', () => writeFileSync(join(out, `server-${label}.log`), lines.join('')));
    children.push({ child, label, lines });
    return child;
  };
  start(baselineRepo, dirA, portA, 'baseline');
  start(candidateRepo, dirB, portB, 'candidate');
  for (const port of [portA, portB]) {
    for (let attempt = 0; ; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ }
      if (attempt > 120) throw new Error(`server on ${port} did not start`);
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  log(`servers up: baseline ${portA}, candidate ${portB}`);

  const normalise = (text, dir) => text
    .replaceAll(dir, '<PROJECT>')
    .replaceAll(dir.replace('/private', ''), '<PROJECT>')
    .replaceAll(scratch, '<SCRATCH>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/"(executionTime|durationMs|elapsedMs|ms|processStartedAt|startedAt|finishedAt|completedAt|createdAt|updatedAt|at|lastRunAt|generatedAt|refreshedAt|savedAt|ranAt|timestamp|pid|port)":\s*("[^"]*"|[\d.]+)/g, '"$1":"<v>"')
    .replace(/\b(run|thr|thread|op|imp|draft|inv|conv|pin|research|snap|story|trace|req|r)[_-][A-Za-z0-9_-]{6,}\b/g, '$1_<id>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');

  const steps = [];
  const record = (name, a, b, judge) => {
    const same = a.status === b.status && (judge ? judge(a, b) : a.norm === b.norm);
    steps.push({ name, same, a: { status: a.status, body: a.norm.slice(0, 600) }, b: { status: b.status, body: b.norm.slice(0, 600) } });
    log(`${same ? 'SAME' : 'DIFF'} | ${name} | ${a.status} vs ${b.status}`);
  };
  const send = async (port, dir, method, path, body, raw) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = raw ? `<${buffer.length} bytes ${response.headers.get('content-type')}>` : buffer.toString('utf8');
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, text, json, norm: normalise(text, dir), headers: response.headers, bytes: buffer.length };
  };
  const both = async (name, method, path, body, options = {}) => {
    const pathA = typeof path === 'function' ? path(dirA, 'a') : path;
    const pathB = typeof path === 'function' ? path(dirB, 'b') : path;
    const bodyA = typeof body === 'function' ? body(dirA, 'a') : body;
    const bodyB = typeof body === 'function' ? body(dirB, 'b') : body;
    const a = await send(portA, dirA, method, pathA, bodyA, options.raw);
    const b = await send(portB, dirB, method, pathB, bodyB, options.raw);
    record(name, a, b, options.judge);
    return { a, b };
  };
  const keys = (pick) => (a, b) => JSON.stringify(pick(a)) === JSON.stringify(pick(b));
  const shape = (value) => (Array.isArray(value) ? `[${value.length}]` : value && typeof value === 'object' ? Object.keys(value).sort().join(',') : typeof value);

  // ── Health, the app, fonts.
  await both('GET /api/health', 'GET', '/api/health', undefined, { judge: keys((x) => [x.json?.status, x.json?.askRuntimeMode]) });
  const index = await both('GET / (the app)', 'GET', '/', undefined, { judge: () => true });
  const googleA = /fonts\.googleapis|fonts\.gstatic/.test(index.a.text);
  const googleB = /fonts\.googleapis|fonts\.gstatic/.test(index.b.text);
  steps.push({ name: 'fonts: app page links a Google host', same: googleA === googleB, a: { status: index.a.status, body: `google=${googleA}` }, b: { status: index.b.status, body: `google=${googleB}` } });
  log(`${googleA === googleB ? 'SAME' : 'DIFF'} | fonts: Google link baseline=${googleA} candidate=${googleB}`);
  const cssB = [...index.b.text.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1]);
  let fontB = 'none';
  for (const css of cssB) {
    const sheet = await send(portB, dirB, 'GET', css.startsWith('/') ? css : `/${css}`);
    const font = /url\(([^)]+\.woff2)\)/.exec(sheet.text)?.[1];
    if (font) { const asset = await send(portB, dirB, 'GET', font.startsWith('/') ? font.replace(/["']/g, '') : `/${font.replace(/["']/g, '')}`, undefined, true); fontB = `${font} -> ${asset.status} ${asset.headers.get('content-type')}`; break; }
  }
  steps.push({ name: 'fonts: candidate serves its font from the local server', same: /-> 200 font\/woff2/.test(fontB), a: { status: 0, body: '' }, b: { status: 0, body: fontB } });
  log(`fonts candidate: ${fontB}`);
  await both('GET /api/host/ui', 'GET', '/api/host/ui');
  await both('GET /api/identity', 'GET', '/api/identity', undefined, { judge: keys((x) => shape(x.json)) });

  // ── Notebook: open, run, save.
  await both('GET /api/notebooks', 'GET', '/api/notebooks');
  await both('GET /api/notebook-content (notebook)', 'GET', '/api/notebook-content?path=notebooks/golden.dqlnb');
  await both('POST /api/notebook/execute (SQL cell)', 'POST', '/api/notebook/execute', { cell: { id: 'c1', type: 'sql', source: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' } }, { judge: keys((x) => x.json?.result?.rows) });
  await both('POST /api/query (default connection)', 'POST', '/api/query', { sql: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' }, { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  const saved = JSON.stringify({ dqlnbVersion: 2, version: 1, title: 'Golden saved', metadata: { createdWith: 'dql' }, cells: [{ id: 'c1', type: 'sql', name: 'by_region', source: 'SELECT 1 AS one' }] }, null, 1);
  await both('PUT /api/notebook-content (save)', 'PUT', '/api/notebook-content', { path: 'notebooks/golden.dqlnb', content: saved });
  await both('GET /api/notebook-content (after save)', 'GET', '/api/notebook-content?path=notebooks/golden.dqlnb');
  await both('PUT /api/run-snapshot (last run)', 'PUT', '/api/run-snapshot', { path: 'notebooks/golden.dqlnb', cells: [{ id: 'c1', result: { columns: ['one'], rows: [{ one: 1 }] } }] });
  await both('GET /api/run-snapshot', 'GET', '/api/run-snapshot?path=notebooks/golden.dqlnb');

  // ── Files by path (single-user: the person's own files).
  await both('GET /api/notebook/file (block, relative)', 'GET', '/api/notebook/file?path=domains/commerce/blocks/golden_old.dql');
  await both('GET /api/notebook-content (absolute path inside the project)', 'GET', (dir) => `/api/notebook-content?path=${encodeURIComponent(join(dir, 'notebooks/golden.dqlnb'))}`);
  await both('GET /api/notebook-content (dql.config.json)', 'GET', '/api/notebook-content?path=dql.config.json');
  await both('GET /api/notebook-content (.dql/ file)', 'GET', '/api/notebook-content?path=.gitignore');
  await both('GET /api/notebook-content (outside the project)', 'GET', `/api/notebook-content?path=${encodeURIComponent('/etc/hosts')}`, undefined, { judge: (a, b) => a.status === b.status });
  await both('GET /api/blocks/body', 'GET', '/api/blocks/body?path=domains/commerce/blocks/golden_old.dql');

  // ── Connections: the configured ones, request-chosen ones (single-user keeps choosing), test-connection.
  await both('GET /api/connections', 'GET', '/api/connections', undefined, { judge: keys((x) => Object.keys(x.json?.connections ?? {}).sort()) });
  await both('POST /api/query (named connection: sqlite)', 'POST', '/api/query', { sql: 'SELECT id, note FROM notes ORDER BY id', executionTarget: { target: 'connection', connectionName: 'lite' } }, { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  await both('POST /api/query (request-described connection object)', 'POST', '/api/query', (dir) => ({ sql: 'SELECT COUNT(*) AS n FROM main.order_lines', connection: { driver: 'duckdb', filepath: join(dir, 'app-datasets-pilot.duckdb') } }), { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  await both('POST /api/query (local DuckDB workspace)', 'POST', '/api/query', { sql: 'SELECT 7 AS n', executionTarget: { target: 'local' } }, { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  await both('POST /api/query (read_csv_auto on a project file)', 'POST', '/api/query', { sql: "SELECT region, target FROM read_csv_auto('data/regions.csv') ORDER BY region" }, { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  await both('POST /api/test-connection (duckdb)', 'POST', '/api/test-connection', (dir) => ({ connection: { driver: 'duckdb', filepath: join(dir, 'app-datasets-pilot.duckdb') } }));
  await both('POST /api/test-connection (sqlite)', 'POST', '/api/test-connection', (dir) => ({ connection: { driver: 'sqlite', filepath: join(dir, 'data/lite.sqlite') } }));
  if (pgReady) {
    await both('POST /api/test-connection (postgres)', 'POST', '/api/test-connection', { connection: config.connections.pg });
    await both('POST /api/query (named connection: postgres)', 'POST', '/api/query', { sql: 'SELECT region, amount FROM claims ORDER BY id', executionTarget: { target: 'connection', connectionName: 'pg' } }, { judge: keys((x) => [x.json?.rows, x.json?.code]) });
  }
  await both('GET /api/schema', 'GET', '/api/schema', undefined, { judge: keys((x) => (Array.isArray(x.json) ? x.json.map((table) => table.name).sort() : x.json)) });
  await both('GET /api/describe-table', 'GET', '/api/describe-table?relation=main.order_lines', undefined, { judge: keys((x) => (Array.isArray(x.json) ? x.json.map((column) => column.name) : x.json)) });

  // ── Export (the cap: up to 100,000 rows; refused above with EXPORT_TOO_LARGE).
  await both('POST /api/query/export csv', 'POST', '/api/query/export', { sql: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region', format: 'csv' });
  await both('POST /api/query/export json', 'POST', '/api/query/export', { sql: 'SELECT region FROM main.order_lines ORDER BY order_line_id LIMIT 3', format: 'json' });
  await both('POST /api/query/export xlsx', 'POST', '/api/query/export', { sql: 'SELECT region FROM main.order_lines LIMIT 3', format: 'xlsx' }, { raw: true, judge: (a, b) => a.headers.get('content-type') === b.headers.get('content-type') });
  await both('POST /api/query/export 100,000 rows', 'POST', '/api/query/export', { sql: 'SELECT range AS n FROM range(100000)', format: 'csv' }, { raw: true, judge: (a, b) => Math.abs(a.bytes - b.bytes) < 64 });
  await both('POST /api/query/export 150,000 rows', 'POST', '/api/query/export', { sql: 'SELECT range AS n FROM range(150000)', format: 'csv' }, { raw: true, judge: (a, b) => Math.abs(a.bytes - b.bytes) < 64 });

  // ── Apps, pages, Datasets, Show Me and pivots, App Studio drafts.
  await both('GET /api/apps', 'GET', '/api/apps', undefined, { judge: keys((x) => (x.json?.apps ?? []).map((app) => app.id)) });
  await both('GET /api/apps/commerce-pilot', 'GET', '/api/apps/commerce-pilot', undefined, { judge: keys((x) => [x.json?.app?.id ?? x.json?.id, shape(x.json)]) });
  const pageRun = await both('POST page run (overview)', 'POST', '/api/apps/commerce-pilot/dashboards/overview/run', {}, { judge: keys((x) => (x.json?.tiles ?? []).map((tile) => [tile.tileId, tile.status])) });
  const tiles = await both('GET /api/app-datasets/tables', 'GET', '/api/app-datasets/tables', undefined, { judge: keys((x) => (x.json?.tables ?? []).map((table) => table.name).sort()) });
  const tableId = (x) => (x.json?.tables ?? []).find((table) => table.name === 'order_lines')?.id;
  const created = await both('POST Dataset from table (certify)', 'POST', '/api/app-datasets/tables/create', (dir, which) => ({ tableId: tableId(which === 'a' ? tiles.a : tiles.b), name: 'Order lines', domain: 'commerce' }), { judge: keys((x) => [x.json?.status]) });
  const pivot = { dimensions: [{ field: 'region' }], measures: [{ measure: 'order_line_count' }] };
  await both('POST /api/app-datasets/run (pivot: region x count)', 'POST', '/api/app-datasets/run', (dir, which) => ({ sourceId: (which === 'a' ? created.a : created.b).json?.sourceId, query: pivot }), { judge: keys((x) => (x.json?.result?.rows ?? []).map((row) => [row.region, Number(row.order_line_count)]).sort()) });
  await both('POST /api/app-datasets/field-values', 'POST', '/api/app-datasets/field-values', (dir, which) => ({ sourceId: (which === 'a' ? created.a : created.b).json?.sourceId, field: 'region' }), { judge: keys((x) => [x.status, JSON.stringify(x.json?.values ?? x.json?.error ?? null)]) });
  await both('POST /api/app-builds (App Studio draft)', 'POST', '/api/app-builds', { goal: 'Order lines by region', name: 'Golden app', domain: 'commerce' }, { judge: keys((x) => [x.status, shape(x.json)]) });
  const tileId = (pageRun.b.json?.tiles ?? []).find((tile) => tile.status === 'ok')?.tileId;
  if (tileId) {
    await both('POST tile export csv', 'POST', '/api/apps/commerce-pilot/dashboards/overview/export', { tileId, format: 'csv' }, { judge: keys((x) => [x.status, x.text.split('\n')[0]]) });
    await both('POST page story', 'POST', '/api/apps/commerce-pilot/dashboards/overview/story', (dir, which) => ({ runId: (which === 'a' ? pageRun.a : pageRun.b).json?.runId }), { judge: keys((x) => [x.status, (x.json?.facts ?? []).map((fact) => [fact.id, fact.value])]) });
  }
  await both('GET /api/home', 'GET', '/api/home', undefined, { judge: keys((x) => (x.json?.apps ?? []).map((app) => app.id)) });
  await both('POST follow a page', 'POST', '/api/apps/commerce-pilot/follow', { pageId: 'overview', following: true }, { judge: keys((x) => [x.status, x.json?.following]) });
  await both('GET /api/persona', 'GET', '/api/persona');
  await both('POST /api/persona (view as)', 'POST', '/api/persona', { userId: 'analyst@example.test', appId: 'commerce-pilot' }, { judge: keys((x) => [x.status, x.json?.persona?.userId]) });
  await both('DELETE /api/persona', 'DELETE', '/api/persona');

  // ── Block Studio: save a draft, certify, deprecate with replacedBy; the library names the replacement.
  const blockSource = 'block "golden_new" {\n  domain = "commerce"\n  type = "custom"\n  description = "Order lines by region"\n  owner = "analyst@example.test"\n  query = """SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region"""\n}\n';
  const savedBlock = await both('POST /api/block-studio/save', 'POST', '/api/block-studio/save', { source: blockSource, metadata: { name: 'golden_new', domain: 'commerce', description: 'Order lines by region', owner: 'analyst@example.test' } }, { judge: keys((x) => [x.status, x.json?.path ?? x.json?.block?.path ?? null]) });
  const blockPath = savedBlock.b.json?.path ?? savedBlock.b.json?.block?.path ?? 'domains/commerce/blocks/golden_new.dql';
  await both('POST /api/block-studio/certify', 'POST', '/api/block-studio/certify', { path: blockPath, source: blockSource }, { judge: keys((x) => [x.status, x.json?.ok ?? null, x.json?.certified ?? x.json?.verdict?.certified ?? null]) });
  await both('POST /api/blocks/status deprecated', 'POST', '/api/blocks/status', { path: 'domains/commerce/blocks/golden_old.dql', newStatus: 'deprecated' });
  await both('PUT replacedBy onto the old block (notebook-content)', 'PUT', '/api/notebook-content', { path: 'domains/commerce/blocks/golden_old.dql', content: 'block "golden_old" {\n  domain = "commerce"\n  type = "custom"\n  status = "deprecated"\n  replacedBy = "golden_new"\n  deprecatedOn = "2026-10-01"\n  description = "Order lines by region (old)"\n  owner = "analyst@example.test"\n  query = """SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region"""\n}\n' });
  await both('GET /api/blocks/library (replacedBy)', 'GET', '/api/blocks/library', undefined, { judge: keys((x) => JSON.stringify(x.json ?? {}).match(/"replacedBy":"[^"]*"|"status":"(deprecated|certified)"/g)?.sort() ?? []) });

  // ── Ask with no model configured, threads, notes, research.
  await both('POST /api/agent-runs (no model)', 'POST', '/api/agent-runs', { question: 'How many order lines are there by region?' }, { judge: keys((x) => [x.status, x.json?.run?.status, x.json?.run?.trustState, x.json?.run?.route ?? null]) });
  await both('GET /api/agent-runs', 'GET', '/api/agent-runs', undefined, { judge: keys((x) => (x.json?.runs ?? []).length) });
  await both('POST /api/agent/threads', 'POST', '/api/agent/threads', { title: 'Golden thread', surface: 'ask' }, { judge: keys((x) => [x.status, x.json?.thread?.title]) });
  await both('GET /api/agent/threads', 'GET', '/api/agent/threads', undefined, { judge: keys((x) => (x.json?.threads ?? []).map((thread) => thread.title)) });
  await both('POST /api/agent/memory (a note)', 'POST', '/api/agent/memory', { scope: 'user', title: 'Regions', content: 'Regions are CA and US.' }, { judge: keys((x) => [x.status]) });
  await both('POST /api/notebook/research', 'POST', '/api/notebook/research', { notebookPath: 'notebooks/golden.dqlnb', question: 'Why do CA and US differ?' }, { judge: keys((x) => [x.status, x.json?.run?.question]) });
  await both('GET /api/notebook/research', 'GET', '/api/notebook/research', undefined, { judge: keys((x) => (x.json?.runs ?? []).length) });
  await both('POST /api/agent/learnings/correction', 'POST', '/api/agent/learnings/correction', { question: 'Order lines?', wrongSql: 'SELECT 1', correctedSql: 'SELECT COUNT(*) FROM main.order_lines', scope: { metric: 'order_line_count' }, author: 'someone@example.test' }, { judge: keys((x) => [x.status, x.json?.hint?.author ?? null]) });
  await both('GET /api/settings/providers', 'GET', '/api/settings/providers', undefined, { judge: keys((x) => (x.json?.providers ?? []).map((p) => [p.id, p.enabled])) });
  await both('GET /api/operations', 'GET', '/api/operations', undefined, { judge: keys((x) => shape(x.json)) });
  await both('POST /api/user-prefs/favorites', 'POST', '/api/user-prefs/favorites', { name: 'golden_new' });

  // ── Git panel.
  await both('GET /api/git/status', 'GET', '/api/git/status', undefined, { judge: keys((x) => [x.status, shape(x.json)]) });
  await both('GET /api/git/diff', 'GET', '/api/git/diff', undefined, { judge: keys((x) => [x.status, (x.text.match(/^diff --git .*$/gm) ?? []).sort()]) });
  await both('GET /api/git/diff (one file)', 'GET', '/api/git/diff?path=notebooks/golden.dqlnb', undefined, { judge: keys((x) => [x.status, (x.text.match(/^diff --git .*$/gm) ?? [])]) });
  await both('GET /api/git/log', 'GET', '/api/git/log', undefined, { judge: keys((x) => [x.status, (x.json?.commits ?? x.json ?? []).length]) });
  await both('POST /api/git/commit', 'POST', '/api/git/commit', { message: 'golden', paths: ['notebooks/golden.dqlnb'] }, { judge: keys((x) => [x.status]) });

  // ── MCP over stdio (each CLI's own server on its own project copy).
  const mcp = async (repo, dir) => {
    const child = spawn(process.execPath, [join(repo, 'apps/cli/dist/index.js'), 'mcp', dir], { cwd: dir, env: env(join(out, 'netlog-mcp.jsonl')), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const replies = new Map();
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); } catch { /* log line */ }
      }
    });
    const ask = async (id, method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let waited = 0; waited < 60_000 && !replies.has(id); waited += 100) await new Promise((done) => setTimeout(done, 100));
      return replies.get(id);
    };
    await ask(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'standalone-diff', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await ask(2, 'tools/list', {});
    const names = (listed?.result?.tools ?? []).map((tool) => tool.name).sort();
    const calls = {};
    for (const [id, name, input] of [[3, 'list_blocks', {}], [4, 'search_blocks', { query: 'order lines' }], [5, 'query_via_block', { blockName: 'golden_new' }], [6, 'list_apps', {}]]) {
      if (!names.includes(name)) continue;
      const reply = await ask(id, 'tools/call', { name, arguments: input });
      calls[name] = normalise(JSON.stringify(reply?.result ?? reply?.error ?? null), dir).slice(0, 400);
    }
    child.kill('SIGTERM');
    return { names, calls };
  };
  const mcpA = await mcp(baselineRepo, dirA);
  const mcpB = await mcp(candidateRepo, dirB);
  steps.push({ name: 'MCP tools/list', same: JSON.stringify(mcpA.names) === JSON.stringify(mcpB.names), a: { status: 0, body: mcpA.names.join(',') }, b: { status: 0, body: mcpB.names.join(',') } });
  log(`${JSON.stringify(mcpA.names) === JSON.stringify(mcpB.names) ? 'SAME' : 'DIFF'} | MCP tools/list (${mcpA.names.length} vs ${mcpB.names.length})`);
  for (const name of new Set([...Object.keys(mcpA.calls), ...Object.keys(mcpB.calls)])) {
    const same = mcpA.calls[name] === mcpB.calls[name];
    steps.push({ name: `MCP ${name}`, same, a: { status: 0, body: mcpA.calls[name] ?? '' }, b: { status: 0, body: mcpB.calls[name] ?? '' } });
    log(`${same ? 'SAME' : 'DIFF'} | MCP ${name}`);
  }

  writeFileSync(join(out, 'standalone-diff.json'), JSON.stringify(steps, null, 1));
  const table = ['| Step | Same | Baseline | Candidate |', '|---|---|---|---|', ...steps.map((step) => `| ${step.name} | ${step.same ? 'same' : '**DIFF**'} | ${step.a.status} | ${step.b.status} |`)].join('\n');
  writeFileSync(join(out, 'standalone-diff.md'), `${table}\n`);
  const differing = steps.filter((step) => !step.same);
  log(`\n${steps.length} steps, ${steps.length - differing.length} same, ${differing.length} differ`);
  for (const step of differing) log(`  DIFF ${step.name}\n    baseline:  ${step.a.status} ${step.a.body.slice(0, 300)}\n    candidate: ${step.b.status} ${step.b.body.slice(0, 300)}`);
  return differing.length;
}

let code = 0;
try {
  code = (await main()) ? 1 : 0;
} catch (error) {
  log(`ERROR ${error instanceof Error ? error.stack : String(error)}`);
  code = 2;
} finally {
  for (const { child } of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  await new Promise((done) => setTimeout(done, 1500));
  if (pgData) { try { execFileSync('pg_ctl', ['-D', pgData, '-m', 'fast', 'stop'], { stdio: 'pipe' }); } catch { /* stopped */ } }
  if (!args.keep) rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
}
process.exit(code);
