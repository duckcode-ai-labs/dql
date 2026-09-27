import { randomBytes } from 'node:crypto';
import type { DqlPrincipal } from './request-context.js';

/**
 * SCHEDULES RUN AS THEIR OWNER (RFC 0010, slice HH-8). An outside scheduler
 * (EventBridge Scheduler, Cloud Scheduler, cron) calls
 * `POST /api/apps/:app/schedules/:schedule/run` as the schedule's owner. The
 * page then runs through the same full-page run route readers use, so every
 * check applies. To carry the owner into that inner request the server
 * issues a pass: random, valid only from this machine, only for that App's
 * page runs, only for two minutes, and revoked when the schedule finishes.
 */
const PREFIX = 'dqlrun.';
const TTL_MS = 120_000;

interface RunPass {
  principal: DqlPrincipal | null;
  appId: string;
  expiresAt: number;
  /** The schedule this pass runs, so the run can be told apart from a reader's (HH-16). */
  scheduleId?: string;
}

const passes = new Map<string, RunPass>();

export function isRunPass(token: string): boolean {
  return token.startsWith(PREFIX);
}

export function issueRunPass(principal: DqlPrincipal | null, appId: string, now = Date.now(), scheduleId?: string): string {
  for (const [token, pass] of passes) if (pass.expiresAt <= now) passes.delete(token);
  const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  passes.set(token, { principal, appId, expiresAt: now + TTL_MS, ...(scheduleId ? { scheduleId } : {}) });
  return token;
}

export function revokeRunPass(token: string): void {
  passes.delete(token);
}

/** The person a pass carries, when it is live and this request is one of its App's page runs. */
export function redeemRunPass(token: string, method: string | undefined, path: string, now = Date.now()): { principal: DqlPrincipal | null; scheduleId?: string } | null {
  const pass = passes.get(token);
  if (!pass) return null;
  if (pass.expiresAt <= now) {
    passes.delete(token);
    return null;
  }
  const pageRun = new RegExp(`^/api/apps/${encodeURIComponent(pass.appId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dashboards/[^/]+/run$`);
  if ((method ?? '').toUpperCase() !== 'POST' || !pageRun.test(path)) return null;
  return { principal: pass.principal, ...(pass.scheduleId ? { scheduleId: pass.scheduleId } : {}) };
}
