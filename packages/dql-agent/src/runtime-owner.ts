/**
 * WHICH LOCAL RUNTIME OWNS UNFINISHED WORK.
 *
 * A project's run and operation stores are files every ZLens process on the
 * machine can open: the notebook server, a second `zlens notebook` on another
 * port, the ephemeral runtime `zlens agent ask` starts, `zlens mcp`. Each store
 * closes unfinished rows as "interrupted" when it opens, so a runtime that
 * crashed does not leave answers spinning forever. Without an owner, the
 * second process also closed the work the first one was still doing: the
 * notebook kept running the answer while the page read it back as
 * "the runtime restarted".
 *
 * Every store instance stamps the unfinished rows it writes with its owner
 * token (`host#pid#instance`). On open, a row is closed only when its owner is
 * provably gone: a process on this host that no longer exists, an instance of
 * this process that was closed, or a row nobody has touched for longer than
 * any run may take. Rows without an owner (written before owners existed) are
 * closed exactly as before.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** Unfinished work older than this is closed even when its owner looks alive (a reused pid). */
export const RUNTIME_OWNER_STALE_MS = 30 * 60_000;

const liveInstances = new Set<string>();

function currentHost(): string {
  try {
    return hostname() || 'localhost';
  } catch {
    return 'localhost';
  }
}

/** A new owner token for one store instance in this process; release it on close. */
export function claimRuntimeOwner(): string {
  const token = `${currentHost()}#${process.pid}#${randomUUID()}`;
  liveInstances.add(token);
  return token;
}

export function releaseRuntimeOwner(token: string): void {
  liveInstances.delete(token);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Is the runtime that wrote this unfinished row still running? `updatedAt` is
 * the row's last write; a row silent for longer than any run may take is
 * treated as abandoned whatever its owner looks like.
 */
export function runtimeOwnerAlive(owner: string | null | undefined, updatedAt?: string | null, now: number = Date.now()): boolean {
  if (!owner) return false;
  const [host, pidText] = owner.split('#');
  const pid = Number(pidText);
  if (!host || !Number.isInteger(pid) || pid <= 0) return false;
  if (updatedAt) {
    const touched = Date.parse(updatedAt);
    if (Number.isFinite(touched) && now - touched > RUNTIME_OWNER_STALE_MS) return false;
  }
  // Another machine sharing the folder cannot be checked from here: its rows
  // are left alone until they go stale.
  if (host !== currentHost()) return true;
  if (pid === process.pid) return liveInstances.has(owner);
  return processExists(pid);
}
