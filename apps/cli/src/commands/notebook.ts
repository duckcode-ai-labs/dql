import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryExecutor, type ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import type { DqlHostHooks } from '../host/request-context.js';
import type { CLIFlags } from '../args.js';
import type { AskAgentRuntimeMode, ProjectConfig } from '../local-runtime.js';
import {
  findProjectRoot,
  loadProjectConfig,
  normalizeProjectConnection,
  resolveAskAgentRuntimeMode,
  startLocalServer,
  syncRuntimeSchema,
} from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';
import { createRuntimePageRunner } from '../schedule/app-page-run.js';
import { findRunningNotebook, localRuntimeUrl, writeNotebookDescriptor } from '../schedule/notebook-runtime.js';

const COMMAND_DIR = dirname(fileURLToPath(import.meta.url));
// Bundled assets are always at dist/assets/ relative to the CLI dist root
const REACT_APP_DIR = resolve(COMMAND_DIR, '../assets/dql-notebook');
const LEGACY_APP_DIR = resolve(COMMAND_DIR, '../assets/notebook-browser');
const NOTEBOOK_APP_DIR = existsSync(join(REACT_APP_DIR, 'index.html')) ? REACT_APP_DIR : LEGACY_APP_DIR;

export function resolveNotebookConnection(config: ProjectConfig, projectRoot: string) {
  return config.defaultConnection
    ? normalizeProjectConnection(config.defaultConnection, projectRoot)
    : null;
}

export interface ProjectRuntimeHandle {
  port: number;
  url: string;
  /** Private per-runtime capability used only by the short-lived CLI Ask client. */
  askTraceCapability: string;
  /** Random per start; `/api/health` echoes it (see `schedule/notebook-runtime.ts`). */
  instanceId: string;
  /**
   * RFC 0010: refresh the schema snapshot (table and column names) from the
   * runtime's own connection, e.g. for a host that applies column policies.
   */
  syncSchema: () => Promise<{ relations: number; columns: number }>;
  /**
   * Stop the HTTP listener and disconnect the warehouse, so the process can
   * exit and a DuckDB file is free for the next process (no-op if closed).
   */
  close: () => Promise<void>;
}

/**
 * Start the local notebook/runtime HTTP server for a project and return a handle.
 * Shared by `dql notebook` (long-running) and `dql agent ask` (which starts an
 * ephemeral runtime on a free port — `preferredPort: 0` — and closes it after).
 */
export async function startProjectRuntime(
  projectRoot: string,
  opts: {
    preferredPort?: number;
    host?: string;
    askAgentRuntimeMode?: AskAgentRuntimeMode;
    /** RFC 0010: run as a hosted runtime (see `@duckcodeailabs/dql-cli/host`). */
    hostHooks?: DqlHostHooks;
    /** Exact browser origins for a runtime behind a host's front door. */
    allowedOrigins?: string[];
    /** Replaces `defaultConnection` from dql.config.json, e.g. a host-managed connection. */
    connection?: ConnectionConfig | null;
  } = {},
): Promise<ProjectRuntimeHandle> {
  const config = loadProjectConfig(projectRoot);
  const executor = new QueryExecutor();
  const connection = opts.connection !== undefined ? opts.connection : resolveNotebookConnection(config, projectRoot);
  const host = opts.host ?? process.env.DQL_HOST ?? '127.0.0.1';
  const askTraceCapability = randomUUID();
  const instanceId = randomUUID();
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: NOTEBOOK_APP_DIR,
    projectRoot,
    executor,
    connection,
    preferredPort: opts.preferredPort ?? 0,
    host,
    askAgentRuntimeMode: opts.askAgentRuntimeMode,
    ...(opts.hostHooks ? { hostHooks: opts.hostHooks } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    trustedCliTraceToken: askTraceCapability,
    instanceId,
    captureServer: (created) => { server = created; },
  });
  const printHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  let closed: Promise<void> | undefined;
  return {
    port,
    url: `http://${printHost}:${port}`,
    askTraceCapability,
    instanceId,
    syncSchema: async () => {
      if (!connection) throw new Error('This project has no connection, so there is no schema to read.');
      return syncRuntimeSchema(projectRoot, executor, connection);
    },
    close: () => (closed ??= new Promise<void>((resolveClose) => {
      if (!server) return resolveClose();
      server.close(() => resolveClose());
      // Open event streams (operations, file watch) would hold close() forever while a browser has DQL open.
      server.closeAllConnections?.();
    }).then(() => executor.disconnect().catch(() => undefined))),
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The token as a URL fragment: the browser keeps it and never sends it to the server. */
export const withAccessToken = (url: string, token: string | undefined) =>
  (token ? `${url.replace(/\/$/, '')}/#dql_token=${encodeURIComponent(token)}` : url);

/**
 * The links another device opens to reach a server bound beyond loopback: one
 * per network address when bound on every interface, each carrying the access
 * token a shared server requires.
 */
export function networkAccessUrls(input: {
  host: string;
  port: number;
  token?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): string[] {
  if (LOOPBACK_HOSTS.has(input.host)) return [];
  const hosts = input.host === '0.0.0.0' || input.host === '::'
    ? Object.values(input.interfaces ?? networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => address.address)
    : [input.host];
  return [...new Set(hosts)].map((host) => withAccessToken(`http://${host}:${input.port}`, input.token));
}

export async function runNotebook(targetArg: string | null, flags: CLIFlags): Promise<void> {
  const baseDir = resolve(targetArg ?? '.');
  const projectRoot = findProjectRoot(baseDir);
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    throw new Error(
      `No DQL project was found at "${baseDir}". Run "dql notebook" from a project root, or pass a project path such as "dql notebook ./my-dql-project".`,
    );
  }
  const config = loadProjectConfig(projectRoot);
  const host = flags.host ?? process.env.DQL_HOST ?? '127.0.0.1';
  // Validate the flag here so a typo fails before a server starts, but pass it
  // through UNRESOLVED: resolving an absent flag to the default would outrank
  // the project's own `agent.askRuntimeMode` and make the config key dead.
  if (flags.askRuntimeMode !== undefined) resolveAskAgentRuntimeMode(flags.askRuntimeMode);
  const runtime = await startProjectRuntime(projectRoot, {
    preferredPort: flags.port ?? config.preview?.port ?? 3474,
    host,
    askAgentRuntimeMode: flags.askRuntimeMode as AskAgentRuntimeMode | undefined,
  });
  const { port, url } = runtime;
  const schedules = await startNotebookAppSchedules(projectRoot, runtime, host, flags.schedules !== false);

  // Auto-open only on loopback. In a container or on a remote host, opening
  // the host's browser is either useless or wrong.
  const shouldOpen = (flags.open ?? config.preview?.open ?? true) && host === '127.0.0.1';
  maybeOpenBrowser(url, shouldOpen);

  // A server bound beyond loopback answers only a browser holding its token,
  // this machine's included: print links that carry it.
  const token = LOOPBACK_HOSTS.has(host) ? undefined : process.env.DQL_SERVER_TOKEN;
  console.log(`\n  ✓ Notebook ready: ${withAccessToken(url, token)}`);
  const networkUrls = networkAccessUrls({ host, port, ...(token ? { token } : {}) });
  if (networkUrls.length > 0) {
    const allowed = new Set((process.env.DQL_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean));
    console.log(`    Bound on ${host}:${port}. From another device, open the full link (it carries the access token):`);
    for (const link of networkUrls) {
      const origin = new URL(link).origin;
      console.log(`      ${link}${allowed.has(origin) ? '' : `  (add ${origin} to DQL_ALLOWED_ORIGINS, or browsers there are refused)`}`);
    }
    console.log('    A new browser tab needs the full link again, or the token pasted when the page asks for it.');
  } else if (host !== '127.0.0.1') {
    console.log(`    Bound on ${host}:${port} — open the URL above from your host.`);
  }
  if (schedules.message) console.log(`    ${schedules.message}`);
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}

/**
 * The notebook announces itself in `.dql/local/notebook.json` and runs the
 * project's App schedules on its own runtime. `dql schedule run|start` read
 * the file and run through this server instead of opening the project's
 * database a second time, which DuckDB does not allow. Block (.dql)
 * schedules stay with `dql schedule start`.
 */
async function startNotebookAppSchedules(
  projectRoot: string,
  runtime: ProjectRuntimeHandle,
  host: string,
  enabled: boolean,
): Promise<{ message?: string }> {
  const other = await findRunningNotebook(projectRoot);
  if (other && other.descriptor.pid !== process.pid) {
    return { message: `Another dql notebook (pid ${other.descriptor.pid}) serves this project; it runs the App schedules.` };
  }
  const selfUrl = localRuntimeUrl(host, runtime.port);
  const loopback = LOOPBACK_HOSTS.has(host);
  const removeDescriptor = writeNotebookDescriptor(projectRoot, {
    version: 1,
    pid: process.pid,
    host,
    port: runtime.port,
    url: selfUrl,
    instanceId: runtime.instanceId,
    startedAt: new Date().toISOString(),
    appSchedules: enabled,
  });

  let scheduler: { stop: () => void; apps: unknown[] } | undefined;
  if (enabled) {
    const [{ startAppScheduler, runScheduledApp }, nodeCron] = await Promise.all([
      import('../schedule/service.js'),
      import('node-cron' as string) as Promise<typeof import('node-cron')>,
    ]);
    const config = loadProjectConfig(projectRoot);
    const connection = normalizeProjectConnection(config.defaultConnection ?? { driver: 'duckdb' }, projectRoot);
    // Pages run through this server's own page-run endpoint, exactly as a
    // reader's full run; beyond loopback that endpoint needs the token.
    const pageRunner = createRuntimePageRunner(selfUrl, fetch, loopback ? undefined : process.env.DQL_SERVER_TOKEN);
    const executor = new QueryExecutor();
    scheduler = startAppScheduler({
      projectRoot,
      cron: nodeCron,
      run: (schedule) => runScheduledApp(schedule, { projectRoot, executor, connection, pageRunner }),
    });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    scheduler?.stop();
    removeDescriptor();
  };
  // The descriptor must not outlive the notebook. Exit right away on a
  // signal: closing the server would wait on browsers' open event streams,
  // and the process exiting releases the database anyway.
  process.once('exit', stop);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(signal, () => {
      stop();
      process.exit(code);
    });
  }

  if (!enabled) return { message: 'App schedules are off in this notebook (--no-schedules); dql schedule runs them through it.' };
  const count = scheduler?.apps.length ?? 0;
  return count > 0
    ? { message: `Running ${count} App schedule${count === 1 ? '' : 's'} while this notebook is open.` }
    : {};
}
