import type { ScheduleIR, NotificationIR, AlertIR, DigestDiagnostic } from '@duckcodeailabs/dql-compiler';
import type { MonitorEvaluation } from '@duckcodeailabs/dql-core';

export interface ScheduledBlock {
  /** Absolute path to the .dql file. */
  path: string;
  /** Name derived from the path, e.g. "finance/revenue_by_month". */
  name: string;
  schedule: ScheduleIR;
  notifications: NotificationIR[];
  alerts: AlertIR[];
}

export interface ScheduledAppDashboard {
  appId: string;
  dashboardId: string;
  scheduleId: string;
  cron: string;
}

export interface AlertEvaluation {
  alert: AlertIR;
  breached: boolean;
  observedValue?: number;
  reason?: string;
  error?: string;
}

export interface QueryRunResult {
  chartId: string;
  sql: string;
  rowCount: number;
  durationMs: number;
  error?: string;
  preview?: Array<Record<string, unknown>>;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  block: string;
  path: string;
  trigger: 'manual' | 'cron';
  queries: QueryRunResult[];
  alerts: AlertEvaluation[];
  /** App page monitors checked on this run (RFC 0008 step 10). */
  monitors?: Array<{ id: string; binding: string; status: MonitorEvaluation['status']; message: string; current?: string; previous?: string }>;
  /** The rendered digest this run wrote, relative to the project. */
  digestPath?: string;
  notifications: Array<{ type: string; recipients: string[]; delivered: boolean; error?: string }>;
  error?: string;
}

export interface NotifierPayload {
  block: string;
  path: string;
  startedAt: string;
  alerts: AlertEvaluation[];
  queries: QueryRunResult[];
  trigger: 'manual' | 'cron';
  /** Rendered digest HTML (present when the block is a digest). */
  html?: string;
  /** Digest markdown sibling — preferred as an email/slack preview body. */
  markdown?: string;
  /** Title/name shown in digest headers, defaults to `block` when absent. */
  digestTitle?: string;
  digestDiagnostics?: DigestDiagnostic[];
  /** App page monitors checked on this run; `breached` ones are alerts. */
  monitors?: MonitorEvaluation[];
  /** A subject line written for this run, e.g. naming the alert that fired. */
  subject?: string;
  /**
   * The App page this run delivers, with its same-origin link (`/?app=…&page=…`)
   * that opens it in DQL; a host prefixes its own address (RFC 0010).
   */
  appPage?: { appId: string; pageId: string; title: string; href: string };
}

/** The same-origin link that opens one App page in DQL. */
export function appPageHref(appId: string, pageId: string): string {
  return `/?${new URLSearchParams({ app: appId, page: pageId }).toString()}`;
}

export interface Notifier {
  type: 'email' | 'slack' | 'file' | 'webhook';
  send(recipients: string[], payload: NotifierPayload): Promise<{ delivered: boolean; error?: string }>;
}
