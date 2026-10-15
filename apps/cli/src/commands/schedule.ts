import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { QueryExecutor } from '@zlens/connectors';
import { buildManifest } from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection } from '../local-runtime.js';
import { discoverScheduledBlocks } from '../schedule/discovery.js';
import { runAppDashboard, runBlock } from '../schedule/runner.js';
import { createRuntimePageRunner, type AppPageRunner } from '../schedule/app-page-run.js';
import { findRunningNotebook, notebookPageRunner, serverTokenFor } from '../schedule/notebook-runtime.js';
import { listRunRecords } from '../schedule/runs.js';
import { startScheduleService } from '../schedule/service.js';

const PIDFILE_RELATIVE = '.dql/schedule.pid';

function pidfilePath(projectRoot: string): string {
  return join(projectRoot, PIDFILE_RELATIVE);
}

function writePidfile(projectRoot: string): void {
  const p = pidfilePath(projectRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(process.pid), 'utf-8');
}

function removePidfile(projectRoot: string): void {
  const p = pidfilePath(projectRoot);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

function readPidfile(projectRoot: string): number | null {
  const p = pidfilePath(projectRoot);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runSchedule(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case 'list':
      return runScheduleList(flags);
    case 'run':
      return runScheduleRun(rest, flags);
    case 'status':
      return runScheduleStatus(flags);
    case 'start':
      return runScheduleStart(flags);
    case 'stop':
      return runScheduleStop(flags);
    default:
      throw new Error('Usage: zlens schedule <list|run|start|stop|status> [args]');
  }
}

async function runScheduleStop(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const pid = readPidfile(projectRoot);

  if (pid === null) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ stopped: false, reason: 'no pidfile' }, null, 2));
    } else {
      console.log('[schedule] no running scheduler found (missing .dql/schedule.pid).');
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    removePidfile(projectRoot);
    if (flags.format === 'json') {
      console.log(JSON.stringify({ stopped: false, reason: 'stale pidfile', pid }, null, 2));
    } else {
      console.log(`[schedule] pidfile was stale (pid ${pid} not running); cleaned up.`);
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to signal scheduler (pid ${pid}): ${msg}`);
  }

  if (flags.format === 'json') {
    console.log(JSON.stringify({ stopped: true, pid }, null, 2));
  } else {
    console.log(`[schedule] sent SIGTERM to pid ${pid}`);
  }
}

async function runScheduleList(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const blocks = discoverScheduledBlocks(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ blocks }, null, 2));
    return;
  }

  if (blocks.length === 0) {
    console.log('No scheduled blocks found. Add @schedule("daily", "9:00 AM") to a .dql file.');
    return;
  }

  console.log(`Scheduled blocks (${blocks.length}):`);
  for (const b of blocks) {
    const alerts = b.alerts.length > 0 ? ` alerts=${b.alerts.length}` : '';
    const notifs = b.notifications.length > 0 ? ` notify=${b.notifications.map((n) => n.type).join(',')}` : '';
    console.log(`  ${b.name.padEnd(40)} cron="${b.schedule.cron}"${alerts}${notifs}`);
  }
}

/**
 * A block run needs the project's connection. Without one, say so plainly (the
 * runtime answers the same state as 409 CONNECTION_NOT_CONFIGURED) instead of
 * falling back to an in-memory DuckDB and reporting a missing driver (N2).
 */
export const NO_CONNECTION_FOR_SCHEDULE_RUN =
  'No database connection is configured yet (CONNECTION_NOT_CONFIGURED). Run `zlens notebook`, open Connections, ' +
  'add a warehouse or local DuckDB/file connection, then retry.';

async function runScheduleRun(rest: string[], flags: CLIFlags): Promise<void> {
  const target = rest[0];
  if (!target) throw new Error('Usage: zlens schedule run <path-to-block.dql> | zlens schedule run <appId> [scheduleId]');

  const projectRoot = findProjectRoot(process.cwd());
  const absPath = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(absPath)) {
    const app = buildManifest({ projectRoot }).apps?.[target];
    if (app) return runAppScheduleOnce(projectRoot, app, rest[1], flags);
    throw new Error(`File not found: ${target} (and no App has that id)`);
  }

  const projectConfig = loadProjectConfig(projectRoot);
  if (!projectConfig.defaultConnection) throw new Error(NO_CONNECTION_FOR_SCHEDULE_RUN);
  const connection = normalizeProjectConnection(projectConfig.defaultConnection, projectRoot);
  const executor = new QueryExecutor();

  const record = await runBlock(absPath, {
    executor,
    connection,
    projectRoot,
    trigger: 'manual',
  });

  if (flags.format === 'json') {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  const breached = record.alerts.filter((a) => a.breached).length;
  const tag = record.error ? `error: ${record.error}` : breached > 0 ? `${breached} alert(s) breached` : 'ok';
  console.log(`  ${record.block} → ${tag}`);
  console.log(`  queries: ${record.queries.length} (${record.queries.filter((q) => !q.error).length} ok)`);
  for (const q of record.queries) {
    const s = q.error ? `err: ${q.error}` : `${q.rowCount} rows in ${q.durationMs}ms`;
    console.log(`    ${q.chartId}: ${s}`);
  }
  if (record.alerts.length > 0) {
    console.log(`  alerts:`);
    for (const a of record.alerts) {
      const status = a.error ? `err: ${a.error}` : a.breached ? 'BREACHED' : 'ok';
      const obs = a.observedValue !== undefined ? ` (observed ${a.observedValue})` : '';
      console.log(`    ${status}${obs}: ${a.alert.conditionSQL}`);
    }
  }
  if (record.notifications.length > 0) {
    console.log(`  notifications:`);
    for (const n of record.notifications) {
      const status = n.delivered ? 'sent' : `failed: ${n.error}`;
      console.log(`    ${n.type} → ${n.recipients.join(', ') || '(default)'} [${status}]`);
    }
  }
}

async function runScheduleStatus(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const records = listRunRecords(projectRoot, 10);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ records }, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log('No run history in .dql/runs/. Trigger a run with: zlens schedule run <path>');
    return;
  }

  console.log(`Last ${records.length} runs:`);
  for (const r of records) {
    const breached = r.alerts.filter((a) => a.breached).length;
    const tag = r.error ? 'error' : breached > 0 ? `breached:${breached}` : 'ok';
    console.log(`  ${r.startedAt}  ${r.block.padEnd(40)} ${r.trigger.padEnd(6)} ${tag}`);
  }
}

async function runScheduleStart(flags: CLIFlags): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());

  const existingPid = readPidfile(projectRoot);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new Error(
      `[schedule] already running (pid ${existingPid}). Use 'zlens schedule stop' first.`,
    );
  }
  if (existingPid !== null) {
    removePidfile(projectRoot);
  }

  const service = await startScheduleService();
  writePidfile(projectRoot);
  const notebook = await findRunningNotebook(projectRoot);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      started: true,
      pid: process.pid,
      blocks: service.blocks,
      apps: service.apps,
      ...(notebook ? { notebook: { pid: notebook.descriptor.pid, url: notebook.url, appSchedules: notebook.descriptor.appSchedules } } : {}),
    }, null, 2));
  } else if (service.blocks.length === 0 && service.apps.length === 0) {
    console.log('No schedules found. Add @schedule(...) to a .dql file or a schedule to an App, then restart.');
    await service.stop();
    removePidfile(projectRoot);
    return;
  } else {
    console.log(`[schedule] running ${service.blocks.length} block(s) and ${service.apps.length} App schedule(s) (pid ${process.pid}). Ctrl+C or 'zlens schedule stop' to end.`);
    for (const b of service.blocks) {
      console.log(`  - ${b.name}  cron="${b.schedule.cron}"`);
    }
    for (const app of service.apps) {
      console.log(`  - app ${app.appId}/${app.scheduleId} (${app.dashboardId})  cron="${app.cron}"`);
    }
    if (notebook?.descriptor.appSchedules) {
      console.log(`  App schedules are run by zlens notebook (pid ${notebook.descriptor.pid}) while it is open; this service runs them after it stops.`);
    } else if (notebook) {
      console.log(`  App pages run through zlens notebook (pid ${notebook.descriptor.pid}) while it is open.`);
    }
  }

  // Graceful shutdown.
  const shutdown = async () => {
    await service.stop();
    removePidfile(projectRoot);
    console.log('\n[schedule] stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the event loop open.
  await new Promise<void>(() => {});
}

/**
 * `zlens schedule run <appId> [scheduleId]` — run one App schedule now, exactly
 * as cron would: a full page run, monitors checked, and the digest delivered
 * to the schedule's targets (RFC 0008 step 10).
 */
async function runAppScheduleOnce(
  projectRoot: string,
  app: NonNullable<ReturnType<typeof buildManifest>['apps']>[string],
  scheduleId: string | undefined,
  flags: CLIFlags,
): Promise<void> {
  const schedules = app.schedules ?? [];
  const schedule = scheduleId ? schedules.find((entry) => entry.id === scheduleId) : schedules.length === 1 ? schedules[0] : undefined;
  if (!schedule) {
    const ids = schedules.map((entry) => entry.id).join(', ') || 'none';
    throw new Error(scheduleId
      ? `App ${app.id} has no schedule "${scheduleId}". Schedules: ${ids}.`
      : `App ${app.id} has ${schedules.length} schedules (${ids}); name one: zlens schedule run ${app.id} <scheduleId>`);
  }
  const projectConfig = loadProjectConfig(projectRoot);
  const connection = normalizeProjectConnection(projectConfig.defaultConnection ?? { driver: 'duckdb' }, projectRoot);
  // The page runs through an App runtime already serving this project when
  // there is one — `--runtime-url`, or a running `zlens notebook` found through
  // `.dql/local/notebook.json` — which DuckDB needs: only one process may
  // open the database file. Otherwise the run starts its own loopback runtime.
  const route = await resolveAppPageRoute(projectRoot, flags.runtimeUrl);
  if (route.via && flags.format !== 'json') console.log(`  Running through ${route.via}`);
  const record = await runAppDashboard(app.id, schedule.dashboard, {
    executor: new QueryExecutor(),
    connection,
    projectRoot,
    trigger: 'manual',
    scheduleId: schedule.id,
    ...(route.pageRunner ? { pageRunner: route.pageRunner } : {}),
  });
  if (flags.format === 'json') {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const failed = record.queries.filter((query) => query.error).length;
  const firing = (record.monitors ?? []).filter((monitor) => monitor.status === 'breached');
  if (failed && !route.pageRunner && record.queries.some((query) => /could not set lock on file/i.test(query.error ?? ''))) {
    console.log('  DuckDB is open in another process that did not announce itself (for example `zlens schedule start`, or');
    console.log('  a notebook from an older ZLens). Stop it, or run through a runtime serving this project:');
    console.log(`    zlens schedule run ${app.id} ${schedule.id} --runtime-url http://127.0.0.1:<port>`);
  }
  console.log(`  ${record.block} → ${record.error ? `error: ${record.error}` : failed ? `${failed} tile(s) did not run` : 'ok'}`);
  console.log(`  tiles: ${record.queries.length} (${record.queries.length - failed} ok)`);
  if (record.monitors?.length) {
    console.log(`  monitors: ${firing.length} firing of ${record.monitors.length}`);
    for (const monitor of record.monitors) console.log(`    ${monitor.status === 'breached' ? 'FIRING' : monitor.status}: ${monitor.message}`);
  }
  if (record.digestPath) console.log(`  digest: ${record.digestPath}`);
  else console.log('  digest: not sent (this schedule speaks only when an alert fires)');
  for (const notification of record.notifications) {
    console.log(`    ${notification.type} → ${notification.recipients.join(', ') || '(default)'} [${notification.delivered ? 'sent' : `failed: ${notification.error}`}]`);
  }
}

const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Where a one-off App schedule run sends its page: `--runtime-url` when
 * given, else the `zlens notebook` running on this project, else nowhere
 * (`runAppDashboard` then starts a loopback runtime of its own). A runtime
 * beyond loopback gets `ZLENS_SERVER_TOKEN` as its bearer token.
 */
export async function resolveAppPageRoute(
  projectRoot: string,
  runtimeUrl: string | undefined,
  options: { env?: NodeJS.ProcessEnv; find?: typeof findRunningNotebook } = {},
): Promise<{ pageRunner?: AppPageRunner; via?: string }> {
  if (runtimeUrl) {
    let loopback = false;
    try {
      loopback = LOOPBACK_URL_HOSTS.has(new URL(runtimeUrl).hostname);
    } catch {
      throw new Error(`--runtime-url is not a URL: ${runtimeUrl}`);
    }
    return { pageRunner: createRuntimePageRunner(runtimeUrl, fetch, serverTokenFor(loopback, options.env)), via: runtimeUrl };
  }
  const notebook = await (options.find ?? findRunningNotebook)(projectRoot);
  if (!notebook) return {};
  return {
    pageRunner: notebookPageRunner(notebook, { env: options.env }),
    via: `zlens notebook (pid ${notebook.descriptor.pid}) at ${notebook.url}`,
  };
}
