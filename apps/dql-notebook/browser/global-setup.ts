import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prepare and start the product the journeys test:
 *   1. build the CLI (it bundles the notebook app) unless E2E_SKIP_BUILD=1;
 *   2. copy the jaffle-supply-chain fixture to a temp dir and seed a DuckDB file;
 *   3. add one notebook and one App (the fixture has none);
 *   4. start `node apps/cli/dist/index.js notebook` on a free port, with
 *      cassette replay, and wait for /api/health.
 * The server URL is passed to the journeys in DQL_E2E_BASE_URL. The returned
 * function stops the server and deletes the temp dir.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const fixtureDir = join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain');
const cliEntry = join(repoRoot, 'apps/cli/dist/index.js');
const DUCKDB_VERSION = '1.1.3';

function run(command: string, args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync(command, args, { cwd: options.cwd ?? repoRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'none'}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolvePort(port) : reject(new Error('no free port'))));
    });
  });
}

function seedProject(projectDir: string): void {
  cpSync(fixtureDir, projectDir, { recursive: true });

  // DuckDB is an optional connector dependency. Install it where the runtime
  // looks first (<project>/.dql/connectors), the same way the Connections page does.
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  mkdirSync(connectorRoot, { recursive: true });
  writeFileSync(join(connectorRoot, 'package.json'), '{"private":true}\n');
  run('npm', ['--prefix', connectorRoot, 'install', '--no-save', '--no-package-lock', '--workspaces=false', `duckdb@${DUCKDB_VERSION}`]);

  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--schema', 'dev']);
  if (!existsSync(warehouse) || statSync(warehouse).size < 1000) {
    throw new Error(`Seeded warehouse missing or empty: ${warehouse}`);
  }

  const configPath = join(projectDir, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.connections = { ...(config.connections ?? {}), default: { driver: 'duckdb', filepath: warehouse } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // Journey content the fixture lacks. The notebook's cells print values that
  // do not appear in their own source, so a journey can tell "ran" from "shown".
  mkdirSync(join(projectDir, 'notebooks'), { recursive: true });
  writeFileSync(join(projectDir, 'notebooks', 'smoke.dqlnb'), `${JSON.stringify({
    dqlnbVersion: 1,
    version: 1,
    title: 'Smoke notebook',
    metadata: { title: 'Smoke notebook', description: 'Browser smoke journey.' },
    cells: [
      { id: 'intro', type: 'markdown', title: 'Intro', source: '# Smoke notebook' },
      {
        id: 'seeded_check',
        type: 'sql',
        title: 'Seeded check',
        source: "select 'smoke-' || cast(count(*) > 0 as varchar) as marker from dev.dim_customers",
      },
    ],
  }, null, 2)}\n`);

  const appDir = join(projectDir, 'apps', 'smoke-orders');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), `${JSON.stringify({
    version: 1,
    id: 'smoke-orders',
    name: 'Smoke Orders',
    description: 'App used by the browser smoke journeys.',
    visibility: 'shared',
    domain: 'orders',
    lifecycle: 'review',
    owners: ['analytics@example.com'],
    tags: ['smoke'],
  }, null, 2)}\n`);
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), `${JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: {
      title: 'Orders overview',
      description: 'One certified block.',
      domain: 'orders',
      visibility: 'shared',
      lifecycle: 'review',
      tags: ['smoke'],
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [{ i: 'top-customers', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'top_customers' }, viz: { type: 'table' }, title: 'Top customers' }],
    },
  }, null, 2)}\n`);
}

async function waitForHealth(baseUrl: string, server: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no server log)';
  throw new Error(`dql notebook did not become healthy at ${baseUrl}/api/health:\n${log}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_SKIP_BUILD !== '1') {
    run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@duckcodeailabs/dql-cli...']);
  }
  if (!existsSync(cliEntry)) throw new Error(`Built CLI not found at ${cliEntry}; build it first.`);

  const workDir = mkdtempSync(join(tmpdir(), 'dql-browser-e2e-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = join(workDir, 'server.log');
  const logFd = openSync(logPath, 'w');
  const server = spawn('node', [cliEntry, 'notebook', projectDir, '--port', String(port), '--no-open'], {
    cwd: workDir,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // Replay recorded model responses; a miss is an error and never reaches a live model.
      DQL_EVAL_CASSETTE_DIR: join(projectDir, 'test-cassettes', 'answerability'),
      DQL_EVAL_CASSETTE_MODE: 'replay',
      // Native semantic engine only, so a developer's own `mf` cannot change the run.
      DQL_METRICFLOW_BIN: join(workDir, 'no-metricflow', 'mf'),
    },
  });

  closeSync(logFd); // the child keeps its own copy of the descriptor

  const stop = async (): Promise<void> => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { server.kill('SIGKILL'); done(); }, 5_000);
        server.once('exit', () => { clearTimeout(timer); done(); });
      });
    }
    if (process.env.E2E_DIAG && existsSync(logPath)) {
      console.log('----- DIAG server.log (tail) -----');
      console.log(readFileSync(logPath, 'utf8').split('\n').slice(-150).join('\n'));
    }
    rmSync(workDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(baseUrl, server, logPath);
    // A fresh project opens the full-screen Guided Setup review once per CLI
    // version. Acknowledge it the way finishing that review does, so the
    // journeys land in the product rather than behind the setup dialog.
    const ack = await fetch(`${baseUrl}/api/onboarding/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!ack.ok) throw new Error(`Acknowledging Guided Setup failed: HTTP ${ack.status} ${await ack.text()}`);
  } catch (error) {
    await stop();
    throw error;
  }
  process.env.DQL_E2E_BASE_URL = baseUrl;
  return stop;
}
