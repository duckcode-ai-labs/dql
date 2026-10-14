import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRuntimePageRunner, type AppPageRunner } from './app-page-run.js';
import { readEnv } from '@zlens/core';

/**
 * Where a running `zlens notebook` announces itself to other DQL processes on
 * the same project. Local runtime state: `.dql/local/` is never committed.
 */
export const NOTEBOOK_DESCRIPTOR_RELATIVE = '.dql/local/notebook.json';

/** What a running `zlens notebook` writes so `zlens schedule` can run through it. */
export interface NotebookDescriptor {
  version: 1;
  pid: number;
  /** The address the server is bound to (`127.0.0.1`, `0.0.0.0`, a LAN IP…). */
  host: string;
  port: number;
  /** The address another process on this machine uses to reach it. */
  url: string;
  /** Random per start; `/api/health` echoes it, so a reused pid or port is not mistaken for this server. */
  instanceId: string;
  startedAt: string;
  /** True when this notebook runs the project's App schedules itself. */
  appSchedules: boolean;
}

/** A notebook that is running now and answered as the one that wrote the descriptor. */
export interface RunningNotebook {
  descriptor: NotebookDescriptor;
  url: string;
  /** False when bound beyond loopback: every API call then needs `ZLENS_SERVER_TOKEN`. */
  loopback: boolean;
}

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function notebookDescriptorPath(projectRoot: string): string {
  return join(projectRoot, NOTEBOOK_DESCRIPTOR_RELATIVE);
}

/** The URL a local process uses to reach a server bound to `host`. */
export function localRuntimeUrl(host: string, port: number): string {
  if (host === '0.0.0.0') return `http://127.0.0.1:${port}`;
  if (host === '::' || host === '::1') return `http://[::1]:${port}`;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * Announce a running notebook. Returns the cleanup for exit, which removes the
 * file only while it is still this notebook's (a newer notebook on the same
 * project may have replaced it).
 */
export function writeNotebookDescriptor(projectRoot: string, descriptor: NotebookDescriptor): () => void {
  const path = notebookDescriptorPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
  return () => {
    const current = readNotebookDescriptor(projectRoot);
    if (current?.instanceId !== descriptor.instanceId) return;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

export function readNotebookDescriptor(projectRoot: string): NotebookDescriptor | null {
  const path = notebookDescriptorPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<NotebookDescriptor>;
    if (
      raw.version !== 1
      || !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0
      || !Number.isInteger(raw.port) || (raw.port ?? 0) <= 0
      || typeof raw.host !== 'string' || typeof raw.url !== 'string'
      || typeof raw.instanceId !== 'string' || !raw.instanceId
    ) return null;
    return {
      version: 1,
      pid: raw.pid!,
      host: raw.host,
      port: raw.port!,
      url: raw.url,
      instanceId: raw.instanceId,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      appSchedules: raw.appSchedules === true,
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface FindNotebookOptions {
  fetchImpl?: typeof fetch;
  isAlive?: (pid: number) => boolean;
  timeoutMs?: number;
}

/**
 * The `zlens notebook` serving this project right now, if any. The descriptor
 * alone is not trusted: its process must be alive and its server must answer
 * `/api/health` (which needs no token) with the same instance id. A
 * descriptor whose process is gone is removed.
 */
export async function findRunningNotebook(projectRoot: string, options: FindNotebookOptions = {}): Promise<RunningNotebook | null> {
  const descriptor = readNotebookDescriptor(projectRoot);
  if (!descriptor) return null;
  if (!(options.isAlive ?? processIsAlive)(descriptor.pid)) {
    try {
      unlinkSync(notebookDescriptorPath(projectRoot));
    } catch {
      /* best-effort */
    }
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = descriptor.url.replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${url}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!response.ok) return null;
    const health = await response.json().catch(() => ({})) as { instanceId?: unknown };
    if (health.instanceId !== descriptor.instanceId) return null;
  } catch {
    return null;
  }
  return { descriptor, url, loopback: LOOPBACK_BIND_HOSTS.has(descriptor.host) };
}

/**
 * The bearer token for API calls to a ZLens server: none on loopback, and
 * `ZLENS_SERVER_TOKEN` otherwise — the same token the server was started with.
 */
export function serverTokenFor(loopback: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (loopback) return undefined;
  const token = readEnv('ZLENS_SERVER_TOKEN', env)?.trim();
  return token || undefined;
}

/** Runs App pages through a running notebook instead of opening the database again. */
export function notebookPageRunner(
  notebook: RunningNotebook,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): AppPageRunner {
  const token = serverTokenFor(notebook.loopback, options.env);
  if (!notebook.loopback && !token) {
    throw new Error(
      `zlens notebook (pid ${notebook.descriptor.pid}) serves this project on ${notebook.descriptor.host}:${notebook.descriptor.port}, `
      + 'which answers API calls only with its token. Set ZLENS_SERVER_TOKEN to the same value here and run again.',
    );
  }
  return createRuntimePageRunner(notebook.url, options.fetchImpl ?? fetch, token);
}
