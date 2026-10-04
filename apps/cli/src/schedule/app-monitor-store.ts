/**
 * Adding and removing App page monitors (RFC 0008 step 10).
 *
 * Monitors live in the App's `dql.app.json`, under the schedule that runs
 * the page, so they are reviewed and shared through git like the rest of the
 * App. Only that file is rewritten, atomically, keeping every other field as
 * it was; the result must parse as a valid App before it is written.
 *
 * A page with no schedule gets an alerts-only schedule (`digest: false`,
 * every morning at 08:00) that speaks only when a monitor fires.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  findAppDocuments,
  loadAppDocument,
  parseAppDocument,
  readAppMonitors,
  type AppMonitor,
  type AppScheduleDelivery,
} from '@duckcodeailabs/dql-core';
import { readDigestState } from './app-digest.js';

export const DEFAULT_ALERT_CRON = '0 8 * * *';

export interface PageMonitorSchedule {
  id: string;
  cron: string;
  digest: boolean;
  enabled: boolean;
  deliver: AppScheduleDelivery[];
  monitors: AppMonitor[];
  /** When this schedule last ran, from its digest state. */
  lastRunAt?: string;
  /** Monitors firing on the last run, with when they started. */
  firingSince: Record<string, string>;
}

export class MonitorStoreError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function appFile(projectRoot: string, appId: string): string {
  for (const path of findAppDocuments(projectRoot)) {
    if (loadAppDocument(path).document?.id === appId) return path;
  }
  throw new MonitorStoreError(`App "${appId}" not found.`, 404);
}

/** Schedules that run this page, with their monitors and last run. */
export function listPageMonitors(projectRoot: string, appId: string, dashboardId: string, baselineOwner?: string): PageMonitorSchedule[] {
  const document = loadAppDocument(appFile(projectRoot, appId)).document;
  return (document?.schedules ?? [])
    .filter((schedule) => schedule.dashboard === dashboardId)
    .map((schedule) => {
      // With a host, the last run and firing monitors as the person asking ran it (their figures decided them).
      const state = readDigestState(projectRoot, appId, baselineOwner ? `${schedule.id}~${baselineOwner}` : schedule.id);
      return {
        id: schedule.id,
        cron: schedule.cron,
        digest: schedule.digest !== false,
        enabled: schedule.enabled !== false,
        deliver: schedule.deliver,
        monitors: schedule.monitors ?? [],
        ...(state?.runAt ? { lastRunAt: state.runAt } : {}),
        firingSince: state?.firingSince ?? {},
      };
    });
}

function rewriteSchedules(
  path: string,
  change: (schedules: Array<Record<string, unknown>>) => void,
): void {
  const text = readFileSync(path, 'utf-8');
  const raw = JSON.parse(text) as Record<string, unknown>;
  const schedules = Array.isArray(raw.schedules) ? raw.schedules as Array<Record<string, unknown>> : [];
  change(schedules);
  raw.schedules = schedules;
  const next = `${JSON.stringify(raw, null, 2)}\n`;
  const parsed = parseAppDocument(next, path);
  if (!parsed.document || parsed.errors.length) {
    throw new MonitorStoreError(parsed.errors.map((error) => error.message).join('; ') || 'The App would not be valid.', 400);
  }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, next, 'utf-8');
  renameSync(temp, path);
}

export interface AddMonitorInput {
  dashboardId: string;
  binding: string;
  when: unknown;
  label?: string;
  /** Add to this schedule; by default the page's first schedule, or a new alerts-only one. */
  scheduleId?: string;
  /** Where a new alerts-only schedule delivers; ignored for an existing schedule. */
  deliver?: AppScheduleDelivery[];
}

export function addPageMonitor(projectRoot: string, appId: string, input: AddMonitorInput): { scheduleId: string; monitor: AppMonitor; createdSchedule: boolean; path: string } {
  const path = appFile(projectRoot, appId);
  const errors: string[] = [];
  const id = `${input.binding.split('.')[0]!.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)}-${randomBytes(3).toString('hex')}`;
  const [monitor] = readAppMonitors([{ id, binding: input.binding, when: input.when, ...(input.label ? { label: input.label } : {}) }], 'monitor', (message) => errors.push(message));
  if (!monitor) throw new MonitorStoreError(errors.join('; ') || 'The monitor is not valid.', 400);
  let scheduleId = '';
  let createdSchedule = false;
  rewriteSchedules(path, (schedules) => {
    const forPage = schedules.filter((schedule) => schedule.dashboard === input.dashboardId);
    let target = input.scheduleId ? forPage.find((schedule) => schedule.id === input.scheduleId) : forPage[0];
    if (input.scheduleId && !target) throw new MonitorStoreError(`This page has no schedule "${input.scheduleId}".`, 404);
    if (!target) {
      const taken = new Set(schedules.map((schedule) => String(schedule.id)));
      let candidate = `alerts-${input.dashboardId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
      for (let n = 2; taken.has(candidate); n += 1) candidate = `alerts-${input.dashboardId}-${n}`;
      target = {
        id: candidate,
        cron: DEFAULT_ALERT_CRON,
        dashboard: input.dashboardId,
        deliver: input.deliver ?? [],
        digest: false,
        description: 'Alerts for this page. Speaks only when a monitor fires.',
      };
      schedules.push(target);
      createdSchedule = true;
    }
    const monitors = Array.isArray(target.monitors) ? target.monitors as unknown[] : [];
    if (monitors.some((existing) => {
      const record = existing as Partial<AppMonitor>;
      return record.binding === monitor.binding && JSON.stringify(record.when) === JSON.stringify(monitor.when);
    })) {
      throw new MonitorStoreError('That alert already exists on this page.', 409);
    }
    target.monitors = [...monitors, monitor];
    scheduleId = String(target.id);
  });
  return { scheduleId, monitor, createdSchedule, path };
}

export function removePageMonitor(projectRoot: string, appId: string, scheduleId: string, monitorId: string): { removed: boolean; path: string } {
  const path = appFile(projectRoot, appId);
  let removed = false;
  rewriteSchedules(path, (schedules) => {
    const schedule = schedules.find((entry) => entry.id === scheduleId);
    if (!schedule || !Array.isArray(schedule.monitors)) return;
    const current = schedule.monitors as Array<{ id?: unknown }>;
    const kept = current.filter((monitor) => monitor.id !== monitorId);
    removed = kept.length !== current.length;
    if (kept.length) schedule.monitors = kept;
    else delete schedule.monitors;
  });
  if (!removed) throw new MonitorStoreError(`No alert "${monitorId}" on schedule "${scheduleId}".`, 404);
  return { removed, path };
}

