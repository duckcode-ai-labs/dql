import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { findAppDocuments, loadAppDocument } from '@duckcodeailabs/dql-core';
import { findProjectRoot, loadProjectConfig, normalizeProjectConnection } from '../local-runtime.js';
import { discoverScheduledBlocks } from './discovery.js';
import { runAppDashboard, runBlock } from './runner.js';
import { createRuntimePageRunner, type AppPageRunner } from './app-page-run.js';
import { findRunningNotebook, notebookPageRunner, type RunningNotebook } from './notebook-runtime.js';
import type { RunRecord, ScheduledAppDashboard, ScheduledBlock } from './types.js';

type CronModule = Pick<typeof import('node-cron'), 'schedule' | 'validate'>;
type Log = Pick<Console, 'log' | 'error'>;

/** How often a long-running scheduler re-reads App schedules (a reader can add one from the Alerts menu). */
export const APP_SCHEDULE_REFRESH_MS = 30_000;

export interface ServiceOptions {
  projectRoot?: string;
  connection?: ConnectionConfig;
  /** Test seams. */
  cron?: CronModule;
  findNotebook?: (projectRoot: string) => Promise<RunningNotebook | null>;
  startRuntime?: (projectRoot: string) => Promise<{ url: string; close: () => Promise<void> }>;
  appRefreshMs?: number;
  log?: Log;
}

export interface StartedService {
  blocks: ScheduledBlock[];
  readonly apps: ScheduledAppDashboard[];
  stop: () => Promise<void>;
}

/** The enabled App schedules in the project, read straight from each `dql.app.json`. */
export function listAppSchedules(projectRoot: string): ScheduledAppDashboard[] {
  return findAppDocuments(projectRoot).flatMap((path) => {
    const { document } = loadAppDocument(path);
    return (document?.schedules ?? [])
      .filter((schedule) => schedule.enabled === undefined || Boolean(schedule.enabled))
      .map((schedule) => ({
        appId: document!.id,
        dashboardId: schedule.dashboard,
        scheduleId: schedule.id,
        cron: schedule.cron,
      }));
  });
}

export interface AppScheduler {
  readonly apps: ScheduledAppDashboard[];
  /** Re-read the project's App schedules and register what changed. */
  refresh: () => void;
  stop: () => void;
}

/**
 * Registers a cron task per App schedule and keeps them in step with the
 * project: a schedule added, changed or removed in `dql.app.json` is picked up
 * on the next refresh, without a restart. Used by `dql schedule start` and by
 * `dql notebook`, which runs its project's App schedules itself.
 */
export function startAppScheduler(options: {
  projectRoot: string;
  cron: CronModule;
  run: (schedule: ScheduledAppDashboard) => Promise<unknown>;
  refreshMs?: number;
  log?: Log;
}): AppScheduler {
  const log = options.log ?? console;
  const tasks = new Map<string, () => void>();
  const reportedInvalid = new Set<string>();
  let apps: ScheduledAppDashboard[] = [];
  const keyOf = (schedule: ScheduledAppDashboard) =>
    JSON.stringify([schedule.appId, schedule.scheduleId, schedule.dashboardId, schedule.cron]);

  const refresh = () => {
    let next: ScheduledAppDashboard[];
    try {
      next = listAppSchedules(options.projectRoot);
    } catch (err) {
      log.error(`[schedule] could not read App schedules: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const wanted = new Map(next.map((schedule) => [keyOf(schedule), schedule]));
    for (const [key, stop] of tasks) {
      if (wanted.has(key)) continue;
      stop();
      tasks.delete(key);
    }
    for (const [key, schedule] of wanted) {
      if (tasks.has(key)) continue;
      if (!options.cron.validate(schedule.cron)) {
        if (!reportedInvalid.has(key)) {
          reportedInvalid.add(key);
          log.error(`[schedule] invalid cron "${schedule.cron}" on ${schedule.appId}/${schedule.scheduleId}, skipping`);
        }
        continue;
      }
      const task = options.cron.schedule(schedule.cron, () => {
        void options.run(schedule).catch((err: unknown) => {
          log.error(`[schedule] app run failed for ${schedule.appId}/${schedule.scheduleId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      tasks.set(key, () => task.stop());
    }
    apps = next;
  };

  refresh();
  const refreshMs = options.refreshMs ?? APP_SCHEDULE_REFRESH_MS;
  const timer = refreshMs > 0 ? setInterval(refresh, refreshMs) : undefined;
  timer?.unref();

  return {
    get apps() {
      return apps;
    },
    refresh,
    stop() {
      if (timer) clearInterval(timer);
      for (const stop of tasks.values()) stop();
      tasks.clear();
    },
  };
}

/** Runs one App schedule as cron does and logs a one-line outcome. */
export async function runScheduledApp(
  schedule: ScheduledAppDashboard,
  options: { projectRoot: string; executor: QueryExecutor; connection: ConnectionConfig; pageRunner: AppPageRunner; log?: Log; baselineOwner?: string },
): Promise<RunRecord> {
  const log = options.log ?? console;
  const record = await runAppDashboard(schedule.appId, schedule.dashboardId, {
    executor: options.executor,
    connection: options.connection,
    projectRoot: options.projectRoot,
    trigger: 'cron',
    scheduleId: schedule.scheduleId,
    pageRunner: options.pageRunner,
    ...(options.baselineOwner ? { baselineOwner: options.baselineOwner } : {}),
  });
  const failed = record.queries.filter((q) => q.error).length;
  const tag = record.error ? `error: ${record.error}` : failed > 0 ? `tile-errors:${failed}` : 'ok';
  log.log(`[schedule] ${record.startedAt} ${schedule.appId}/${schedule.dashboardId} → ${tag}`);
  return record;
}

/**
 * A loopback App runtime this process starts for scheduled pages. With
 * `closeWhenIdle` (DuckDB, where only one process may open the database
 * file) it is closed after every run, so a `dql notebook` started later can
 * open the database; otherwise it is kept for the life of the service.
 */
function ownRuntimePageRunner(
  projectRoot: string,
  closeWhenIdle: boolean,
  startRuntime: NonNullable<ServiceOptions['startRuntime']>,
): { run: AppPageRunner; close: () => Promise<void> } {
  let runtime: ReturnType<typeof startRuntime> | undefined;
  let closing: Promise<void> | undefined;
  let active = 0;
  const close = async () => {
    const current = runtime;
    runtime = undefined;
    if (current) await current.then((handle) => handle.close(), () => undefined);
  };
  return {
    close,
    async run(appId, dashboardId) {
      active += 1;
      try {
        if (closing) await closing;
        runtime ??= startRuntime(projectRoot).catch((error: unknown) => {
          // A failed start is retried by the next scheduled run.
          runtime = undefined;
          throw error;
        });
        const handle = await runtime;
        return await createRuntimePageRunner(handle.url)(appId, dashboardId);
      } finally {
        active -= 1;
        if (closeWhenIdle && active === 0 && runtime) {
          closing = close().finally(() => {
            closing = undefined;
          });
          await closing;
        }
      }
    },
  };
}

const defaultStartRuntime: NonNullable<ServiceOptions['startRuntime']> = (projectRoot) =>
  import('../commands/notebook.js').then(({ startProjectRuntime }) =>
    startProjectRuntime(projectRoot, { preferredPort: 0, host: '127.0.0.1' }));

export async function startScheduleService(options: ServiceOptions = {}): Promise<StartedService> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const connection =
    options.connection ??
    normalizeProjectConnection(
      projectConfig.defaultConnection ?? { driver: 'duckdb' },
      projectRoot,
    );
  const log = options.log ?? console;
  const findNotebook = options.findNotebook ?? ((root: string) => findRunningNotebook(root));

  const executor = new QueryExecutor();
  const blocks = discoverScheduledBlocks(projectRoot);

  // Dynamic import so node-cron stays off the hot path for one-shot commands.
  const nodeCron = options.cron ?? ((await import('node-cron' as string)) as typeof import('node-cron'));

  const tasks: Array<{ stop: () => void }> = [];
  for (const block of blocks) {
    if (!nodeCron.validate(block.schedule.cron)) {
      log.error(`[schedule] invalid cron "${block.schedule.cron}" on ${block.name}, skipping`);
      continue;
    }
    const task = nodeCron.schedule(block.schedule.cron, () => {
      void (async () => {
        try {
          const record = await runBlock(block.path, {
            executor,
            connection,
            projectRoot,
            trigger: 'cron',
          });
          const breached = record.alerts.filter((a) => a.breached).length;
          const tag = record.error ? 'error' : breached > 0 ? `breached:${breached}` : 'ok';
          log.log(`[schedule] ${record.startedAt} ${block.name} → ${tag}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[schedule] run failed for ${block.name}: ${msg}`);
        }
      })();
    });
    tasks.push({ stop: () => task.stop() });
  }

  // App pages run through the App runtime. A `dql notebook` serving this
  // project is used when one is running — it already holds the database, and
  // DuckDB allows one process per file — and when it runs App schedules
  // itself, this service leaves them to it. Otherwise pages run through a
  // loopback runtime of this process's own.
  const own = ownRuntimePageRunner(projectRoot, connection.driver === 'duckdb', options.startRuntime ?? defaultStartRuntime);
  const appScheduler = startAppScheduler({
    projectRoot,
    cron: nodeCron,
    refreshMs: options.appRefreshMs,
    log,
    run: async (schedule) => {
      const notebook = await findNotebook(projectRoot);
      if (notebook?.descriptor.appSchedules) {
        log.log(`[schedule] ${schedule.appId}/${schedule.scheduleId} is run by dql notebook (pid ${notebook.descriptor.pid}); skipped here`);
        return;
      }
      await runScheduledApp(schedule, {
        projectRoot,
        executor,
        connection,
        pageRunner: notebook ? notebookPageRunner(notebook) : own.run,
        log,
      });
    },
  });

  return {
    blocks,
    get apps() {
      return appScheduler.apps;
    },
    async stop() {
      for (const t of tasks) t.stop();
      appScheduler.stop();
      await own.close();
    },
  };
}
