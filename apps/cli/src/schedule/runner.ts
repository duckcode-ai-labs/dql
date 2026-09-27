import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { compile } from '@duckcodeailabs/dql-compiler';
import type { NotificationIR } from '@duckcodeailabs/dql-compiler';
import type { QueryExecutor, ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { buildManifest, buildStoryBindingCatalog, loadDashboardDocument, type StoryBindingTileInput } from '@duckcodeailabs/dql-core';
import { findProjectRoot, loadProjectConfig, prepareLocalExecution } from '../local-runtime.js';
import { runtimeVariables } from '../governance-runtime.js';
import { isDigestOutput, runDigestBuild } from '../digest.js';
import { evaluateAlerts } from './alerts.js';
import { deriveBlockName } from './discovery.js';
import { dispatchNotifications, type DeliveryTarget } from './notifiers/index.js';
import { createRuntimePageRunner, summarizeAppPageRun, type AppPageRunner } from './app-page-run.js';
import { writeDigestHtml, writeRunRecord } from './runs.js';
import { buildAppDigest, readDigestState, writeDigestState, type DigestLayoutItem } from './app-digest.js';
import { appPageHref, type NotifierPayload, type QueryRunResult, type RunRecord } from './types.js';

export interface RunOptions {
  executor: QueryExecutor;
  connection: ConnectionConfig;
  projectRoot?: string;
  trigger?: 'manual' | 'cron';
  previewRows?: number;
}

export async function runBlock(absPath: string, options: RunOptions): Promise<RunRecord> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const trigger = options.trigger ?? 'manual';
  const previewRows = options.previewRows ?? 3;

  const startedAt = new Date().toISOString();
  const block = deriveBlockName(projectRoot, absPath);

  let queries: QueryRunResult[] = [];
  let alertResults: Awaited<ReturnType<typeof evaluateAlerts>> = [];
  let notifications: Awaited<ReturnType<typeof dispatchNotifications>> = [];
  let error: string | undefined;

  try {
    const source = readFileSync(absPath, 'utf-8');
    const compiled = compile(source, { file: absPath });

    if (compiled.errors.length > 0) {
      error = compiled.errors.join('; ');
    }

    const dashboard = compiled.dashboards[0];
    if (!dashboard) {
      error = error ?? 'compile produced no dashboards';
    } else {
      // Execute each chart query.
      for (const q of dashboard.metadata.queries) {
        const t0 = Date.now();
        try {
          const prepared = prepareLocalExecution(q.sql, options.connection, projectRoot, projectConfig);
          const result = await options.executor.executeQuery(
            prepared.sql,
            q.sqlParams ?? [],
            runtimeVariables({}),
            prepared.connection,
          );
          queries.push({
            chartId: q.id,
            sql: q.sql,
            rowCount: result.rows.length,
            durationMs: Date.now() - t0,
            preview: result.rows.slice(0, previewRows) as Array<Record<string, unknown>>,
          });
        } catch (err) {
          queries.push({
            chartId: q.id,
            sql: q.sql,
            rowCount: 0,
            durationMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Evaluate alerts.
      alertResults = await evaluateAlerts(
        dashboard.metadata.alerts ?? [],
        options.executor,
        options.connection,
      );

      // Fire notifications only if at least one alert breached OR no alerts were
      // declared (so scheduled runs without alerts still produce an audit entry).
      const anyBreached = alertResults.some((a) => a.breached);
      const hasAlerts = alertResults.length > 0;
      const shouldNotify = anyBreached || !hasAlerts;

      if (shouldNotify && (dashboard.metadata.notifications?.length ?? 0) > 0) {
        const payload: NotifierPayload = {
          block,
          path: absPath,
          startedAt,
          alerts: alertResults,
          queries,
          trigger,
        };

        if (isDigestOutput(dashboard)) {
          try {
            const digest = await runDigestBuild(dashboard, projectRoot);
            payload.html = digest.html;
            payload.markdown = digest.markdown;
            payload.digestTitle = dashboard.metadata.title ?? block;
            payload.digestDiagnostics = digest.diagnostics;
          } catch (err) {
            payload.digestDiagnostics = [
              {
                level: 'warning',
                message: `digest build failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ];
          }
        }

        notifications = await dispatchNotifications(
          dashboard.metadata.notifications ?? [],
          payload,
          projectRoot,
        );
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    block,
    path: absPath,
    trigger,
    queries,
    alerts: alertResults,
    notifications,
    error,
  };

  writeRunRecord(projectRoot, record);
  return record;
}

export async function runAppDashboard(
  appId: string,
  dashboardId: string,
  options: RunOptions & { scheduleId?: string; pageRunner?: AppPageRunner },
): Promise<RunRecord> {
  const projectRoot = options.projectRoot ?? findProjectRoot(process.cwd());
  const trigger = options.trigger ?? 'manual';
  const previewRows = options.previewRows ?? 3;
  const startedAt = new Date().toISOString();
  const block = `app/${appId}/${dashboardId}${options.scheduleId ? `#${options.scheduleId}` : ''}`;

  let queries: QueryRunResult[] = [];
  let monitors: RunRecord['monitors'];
  let digestPath: string | undefined;
  let notifications: Awaited<ReturnType<typeof dispatchNotifications>> = [];
  let error: string | undefined;
  let ephemeral: { close: () => Promise<void> } | undefined;

  try {
    const manifest = buildManifest({ projectRoot });
    const app = manifest.apps?.[appId];
    const dashboard = manifest.dashboards?.[`${appId}/${dashboardId}`];
    if (!app) throw new Error(`App not found: ${appId}`);
    if (!dashboard) throw new Error(`Dashboard not found: ${appId}/${dashboardId}`);

    // Scheduled pages run through the App runtime, exactly as a reader sees
    // them: every tile kind, the page's default filters, and the same trust
    // checks. A long-running schedule service passes one shared runtime; a
    // one-off run starts a loopback runtime for this project and closes it.
    let pageRunner = options.pageRunner;
    if (!pageRunner) {
      const { startProjectRuntime } = await import('../commands/notebook.js');
      const runtime = await startProjectRuntime(projectRoot, { preferredPort: 0, host: '127.0.0.1' });
      ephemeral = runtime;
      pageRunner = createRuntimePageRunner(runtime.url);
    }
    const tiles = await pageRunner(appId, dashboardId);
    const summary = summarizeAppPageRun(dashboard.title, tiles, previewRows);
    queries = summary.queries;
    const schedule = (app.schedules ?? []).find((s) => s.id === options.scheduleId);

    // The rendered digest and monitors read the page's bound figures, the
    // same catalog stories and snapshots use (RFC 0008 step 10).
    const pagePath = isAbsolute(dashboard.filePath) ? dashboard.filePath : join(projectRoot, dashboard.filePath);
    const items = (loadDashboardDocument(pagePath).document?.layout.items ?? []) as unknown as DigestLayoutItem[];
    const catalog = buildStoryBindingCatalog(
      tiles.map((tile) => (tile.raw ?? { tileId: tile.tileId, status: tile.status })) as unknown as StoryBindingTileInput[],
      Object.fromEntries(items.map((item) => [item.i, item.title])),
    );
    const stateKey = options.scheduleId ?? `manual-${dashboardId}`;
    const previous = readDigestState(projectRoot, appId, stateKey);
    const digest = buildAppDigest({
      appTitle: app.name ?? appId,
      pageTitle: dashboard.title,
      items,
      tiles,
      catalog,
      monitors: schedule?.monitors ?? [],
      previous,
      runAt: startedAt,
    });
    monitors = digest.evaluations.map((evaluation) => ({
      id: evaluation.monitor.id,
      binding: evaluation.monitor.binding,
      status: evaluation.status,
      message: evaluation.message,
      ...(evaluation.current ? { current: evaluation.current } : {}),
      ...(evaluation.previous ? { previous: evaluation.previous } : {}),
    }));
    // A run with no bound figures (every tile failed) must not wipe the
    // baseline the next run compares against.
    if (Object.keys(catalog).length > 0) writeDigestState(projectRoot, appId, stateKey, digest.nextState);

    const notificationTargets: DeliveryTarget[] = [];
    for (const delivery of schedule?.deliver ?? []) {
      if (delivery.kind === 'slack') {
        notificationTargets.push({ type: 'slack', recipients: [delivery.channel] });
      } else if (delivery.kind === 'email') {
        notificationTargets.push({ type: 'email', recipients: delivery.to });
      } else if (delivery.kind === 'webhook') {
        notificationTargets.push({ type: 'webhook', recipients: [delivery.url] });
      }
    }

    // A schedule with `digest: false` speaks only when a monitor fires.
    const speak = schedule?.digest !== false || digest.firing.length > 0;
    if (speak) {
      // Kept beside the run records so a schedule with no targets still
      // leaves a digest someone can open.
      digestPath = writeDigestHtml(projectRoot, startedAt, block, digest.subject, digest.html);
      // With no targets this still appends to the audit log.
      notifications = await dispatchNotifications(
        notificationTargets,
        {
          block,
          path: dashboard.filePath,
          startedAt,
          alerts: [],
          queries,
          trigger,
          markdown: digest.markdown,
          html: digest.html,
          digestTitle: dashboard.title,
          monitors: digest.evaluations,
          subject: digest.subject,
          appPage: { appId, pageId: dashboardId, title: dashboard.title, href: appPageHref(appId, dashboardId) },
        },
        projectRoot,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await ephemeral?.close();
  }

  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    block,
    path: `apps/${appId}/dashboards/${dashboardId}.dqld`,
    trigger,
    queries,
    alerts: [],
    ...(monitors?.length ? { monitors } : {}),
    ...(digestPath ? { digestPath } : {}),
    notifications,
    error,
  };

  writeRunRecord(projectRoot, record);
  return record;
}
