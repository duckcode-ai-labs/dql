import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startProjectRuntime } from '../commands/notebook.js';
import { resolveAppPageRoute } from '../commands/schedule.js';
import {
  findRunningNotebook,
  localRuntimeUrl,
  notebookDescriptorPath,
  notebookPageRunner,
  readNotebookDescriptor,
  writeNotebookDescriptor,
  type NotebookDescriptor,
  type RunningNotebook,
} from './notebook-runtime.js';
import { listAppSchedules, startAppScheduler, startScheduleService } from './service.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/app-datasets-pilot', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithSchedules(schedules: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-notebook-schedules-'));
  roots.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  setSchedules(root, schedules);
  return root;
}

function setSchedules(root: string, schedules: unknown[]): void {
  const appPath = join(root, 'apps/commerce-pilot/dql.app.json');
  const app = JSON.parse(readFileSync(appPath, 'utf8'));
  app.schedules = schedules;
  writeFileSync(appPath, JSON.stringify(app, null, 2));
}

const descriptor = (overrides: Partial<NotebookDescriptor> = {}): NotebookDescriptor => ({
  version: 1,
  pid: 4242,
  host: '127.0.0.1',
  port: 3474,
  url: 'http://127.0.0.1:3474',
  instanceId: 'instance-a',
  startedAt: '2026-09-24T08:00:00.000Z',
  appSchedules: true,
  ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A cron module that records registrations and fires them on demand. */
function fakeCron() {
  const tasks: Array<{ cron: string; fire: () => void; stopped: boolean }> = [];
  return {
    tasks,
    live: () => tasks.filter((task) => !task.stopped),
    module: {
      validate: (expression: string) => expression !== 'not a cron',
      schedule: (expression: string, fire: () => void) => {
        const task = { cron: expression, fire, stopped: false };
        tasks.push(task);
        return { stop: () => { task.stopped = true; } };
      },
    } as unknown as Pick<typeof import('node-cron'), 'schedule' | 'validate'>,
  };
}

const pageTiles = { tiles: [{ tileId: 'order-lines-dataset-kpi', status: 'ok', tileType: 'dataset', result: { columns: [{ name: 'revenue' }], rows: [{ revenue: 145 }], rowCount: 1 } }] };
const quiet = { log: () => undefined, error: () => undefined };

describe('zlens notebook runs App schedules and zlens schedule runs through it', () => {
  it('announces a notebook in .dql/local and removes only its own descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-descriptor-'));
    roots.push(root);
    const removeFirst = writeNotebookDescriptor(root, descriptor());
    expect(notebookDescriptorPath(root)).toBe(join(root, '.dql/local/notebook.json'));
    expect(readNotebookDescriptor(root)).toEqual(descriptor());
    expect(readdirSync(join(root, '.dql/local'))).toEqual(['notebook.json']);

    // A newer notebook on the same project replaced it: the older one's exit leaves it alone.
    const removeSecond = writeNotebookDescriptor(root, descriptor({ pid: 4343, instanceId: 'instance-b' }));
    removeFirst();
    expect(readNotebookDescriptor(root)?.instanceId).toBe('instance-b');
    removeSecond();
    expect(existsSync(notebookDescriptorPath(root))).toBe(false);

    writeFileSync(notebookDescriptorPath(root), '{"version":1,"pid":"x"}');
    expect(readNotebookDescriptor(root)).toBeNull();
  });

  it('trusts a descriptor only while its process lives and its server answers with the same instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-find-'));
    roots.push(root);
    writeNotebookDescriptor(root, descriptor());
    const health = vi.fn(async () => json({ status: 'ok', instanceId: 'instance-a' }));

    const found = await findRunningNotebook(root, { isAlive: () => true, fetchImpl: health as unknown as typeof fetch });
    expect(found).toMatchObject({ url: 'http://127.0.0.1:3474', loopback: true, descriptor: { pid: 4242 } });
    expect(health).toHaveBeenCalledWith('http://127.0.0.1:3474/api/health', expect.anything());

    // Pid reused, or another server now on the port.
    const other = vi.fn(async () => json({ status: 'ok', instanceId: 'someone-else' }));
    expect(await findRunningNotebook(root, { isAlive: () => true, fetchImpl: other as unknown as typeof fetch })).toBeNull();
    const refused = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await findRunningNotebook(root, { isAlive: () => true, fetchImpl: refused as unknown as typeof fetch })).toBeNull();
    expect(existsSync(notebookDescriptorPath(root))).toBe(true);

    // The process is gone: the stale descriptor is cleaned up without a probe.
    const unused = vi.fn();
    expect(await findRunningNotebook(root, { isAlive: () => false, fetchImpl: unused as unknown as typeof fetch })).toBeNull();
    expect(unused).not.toHaveBeenCalled();
    expect(existsSync(notebookDescriptorPath(root))).toBe(false);
  });

  it('sends the server token to a notebook bound beyond loopback, and refuses to call it without one', async () => {
    const shared: RunningNotebook = { descriptor: descriptor({ host: '0.0.0.0', url: localRuntimeUrl('0.0.0.0', 3474) }), url: 'http://127.0.0.1:3474', loopback: false };
    expect(() => notebookPageRunner(shared, { env: {} })).toThrow(/ZLENS_SERVER_TOKEN/);

    const fetchImpl = vi.fn(async () => json(pageTiles));
    await notebookPageRunner(shared, { env: { ZLENS_SERVER_TOKEN: 's3cret' }, fetchImpl: fetchImpl as unknown as typeof fetch })('commerce-pilot', 'overview');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3474/api/apps/commerce-pilot/dashboards/overview/run');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');

    // Loopback needs no token and is never sent one.
    const local: RunningNotebook = { descriptor: descriptor(), url: 'http://127.0.0.1:3474', loopback: true };
    const localFetch = vi.fn(async () => json(pageTiles));
    await notebookPageRunner(local, { env: { ZLENS_SERVER_TOKEN: 's3cret' }, fetchImpl: localFetch as unknown as typeof fetch })('commerce-pilot', 'overview');
    expect(((localFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBeUndefined();

    expect(localRuntimeUrl('::', 9)).toBe('http://[::1]:9');
    expect(localRuntimeUrl('192.168.1.20', 9)).toBe('http://192.168.1.20:9');
  });

  it('zlens schedule run picks --runtime-url first, then a running notebook, else its own runtime', async () => {
    const fetchImpl = vi.fn(async () => json(pageTiles));
    vi.stubGlobal('fetch', fetchImpl);
    const remote = await resolveAppPageRoute('/nowhere', 'http://10.0.0.5:3474', { env: { ZLENS_SERVER_TOKEN: 't' } });
    expect(remote.via).toBe('http://10.0.0.5:3474');
    await remote.pageRunner!('a', 'b');
    expect(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer t');
    await expect(resolveAppPageRoute('/nowhere', 'not a url')).rejects.toThrow(/--runtime-url/);

    const notebook: RunningNotebook = { descriptor: descriptor({ pid: 777 }), url: 'http://127.0.0.1:3474', loopback: true };
    const viaNotebook = await resolveAppPageRoute('/project', undefined, { find: async () => notebook });
    expect(viaNotebook.via).toBe('zlens notebook (pid 777) at http://127.0.0.1:3474');
    expect(viaNotebook.pageRunner).toBeTypeOf('function');

    expect(await resolveAppPageRoute('/project', undefined, { find: async () => null })).toEqual({});
  });

  it('keeps cron tasks in step with the Apps: added, changed and removed schedules without a restart', () => {
    const root = projectWithSchedules([
      { id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [] },
      { id: 'paused', cron: '0 9 * * *', dashboard: 'overview', deliver: [], enabled: false },
      { id: 'broken', cron: 'not a cron', dashboard: 'overview', deliver: [] },
    ]);
    expect(listAppSchedules(root).map((schedule) => schedule.scheduleId)).toEqual(['daily', 'broken']);
    const cron = fakeCron();
    const errors: string[] = [];
    const scheduler = startAppScheduler({ projectRoot: root, cron: cron.module, run: async () => undefined, refreshMs: 0, log: { log: () => undefined, error: (message: string) => errors.push(message) } });
    expect(cron.live().map((task) => task.cron)).toEqual(['0 8 * * *']);
    expect(errors).toEqual(['[schedule] invalid cron "not a cron" on commerce-pilot/broken, skipping']);

    // A reader adds an alerts-only schedule and the daily one moves to 07:00.
    setSchedules(root, [
      { id: 'daily', cron: '0 7 * * *', dashboard: 'overview', deliver: [] },
      { id: 'broken', cron: 'not a cron', dashboard: 'overview', deliver: [] },
      { id: 'alerts', cron: '0 * * * *', dashboard: 'overview', deliver: [], digest: false },
    ]);
    scheduler.refresh();
    expect(cron.live().map((task) => task.cron).sort()).toEqual(['0 * * * *', '0 7 * * *']);
    expect(errors).toHaveLength(1);
    expect(scheduler.apps.map((schedule) => schedule.scheduleId)).toEqual(['daily', 'broken', 'alerts']);

    setSchedules(root, []);
    scheduler.refresh();
    expect(cron.live()).toEqual([]);
    scheduler.stop();
  });

  it('zlens schedule start leaves App schedules to a notebook that runs them, and never opens a runtime of its own', async () => {
    const root = projectWithSchedules([{ id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [] }]);
    const cron = fakeCron();
    const startRuntime = vi.fn();
    const logs: string[] = [];
    const service = await startScheduleService({
      projectRoot: root,
      cron: cron.module,
      appRefreshMs: 0,
      findNotebook: async () => ({ descriptor: descriptor({ pid: 99 }), url: 'http://127.0.0.1:3474', loopback: true }),
      startRuntime,
      log: { log: (message: string) => logs.push(message), error: (message: string) => logs.push(message) },
    });
    cron.live()[0]!.fire();
    await vi.waitFor(() => expect(logs).toContain('[schedule] commerce-pilot/daily is run by zlens notebook (pid 99); skipped here'));
    expect(startRuntime).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.dql/runs'))).toBe(false);
    await service.stop();
  });

  it('zlens schedule start runs pages through a notebook that has schedules off', async () => {
    const root = projectWithSchedules([{ id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [] }]);
    const cron = fakeCron();
    const startRuntime = vi.fn();
    const pageRun = vi.fn(async () => json(pageTiles));
    vi.stubGlobal('fetch', pageRun);
    const logs: string[] = [];
    const service = await startScheduleService({
      projectRoot: root,
      cron: cron.module,
      appRefreshMs: 0,
      findNotebook: async () => ({ descriptor: descriptor({ appSchedules: false, port: 3999, url: 'http://127.0.0.1:3999' }), url: 'http://127.0.0.1:3999', loopback: true }),
      startRuntime,
      log: { log: (message: string) => logs.push(message), error: (message: string) => logs.push(message) },
    });
    cron.live()[0]!.fire();
    await vi.waitFor(() => expect(logs.some((line) => /commerce-pilot\/overview → ok$/.test(line))).toBe(true));
    expect(pageRun).toHaveBeenCalledWith('http://127.0.0.1:3999/api/apps/commerce-pilot/dashboards/overview/run', expect.anything());
    expect(startRuntime).not.toHaveBeenCalled();
    await service.stop();
  });

  it('without a notebook, zlens schedule start uses its own runtime and frees DuckDB between runs', async () => {
    const root = projectWithSchedules([
      { id: 'daily', cron: '0 8 * * *', dashboard: 'overview', deliver: [] },
      { id: 'hourly', cron: '0 * * * *', dashboard: 'overview', deliver: [] },
    ]);
    const cron = fakeCron();
    const close = vi.fn(async () => undefined);
    // A runtime takes a moment to start, so both runs of one minute overlap.
    const startRuntime = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { url: 'http://127.0.0.1:4555', close };
    });
    vi.stubGlobal('fetch', vi.fn(async () => json(pageTiles)));
    const service = await startScheduleService({
      projectRoot: root,
      connection: { driver: 'duckdb', filepath: join(root, 'app-datasets-pilot.duckdb') },
      cron: cron.module,
      appRefreshMs: 0,
      findNotebook: async () => null,
      startRuntime,
      log: quiet,
    });
    // Two schedules fire in the same minute: one runtime serves both, then closes.
    for (const task of cron.live()) task.fire();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(startRuntime).toHaveBeenCalledTimes(1);
    cron.live()[0]!.fire();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(startRuntime).toHaveBeenCalledTimes(2);
    await service.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('a real notebook runtime is found through its descriptor and echoes its instance id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-notebook-live-'));
    roots.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'notebook-live-test' }));
    const runtime = await startProjectRuntime(root, { preferredPort: 0, host: '127.0.0.1' });
    try {
      const health = await (await fetch(`${runtime.url}/api/health`)).json() as { instanceId?: string };
      expect(health.instanceId).toBe(runtime.instanceId);
      writeNotebookDescriptor(root, descriptor({ pid: process.pid, port: runtime.port, url: runtime.url, instanceId: runtime.instanceId }));
      const found = await findRunningNotebook(root);
      expect(found?.url).toBe(runtime.url);
      const route = await resolveAppPageRoute(root, undefined);
      expect(route.via).toBe(`zlens notebook (pid ${process.pid}) at ${runtime.url}`);
      // The route reaches the notebook's own page-run endpoint.
      await expect(route.pageRunner!('missing-app', 'overview')).rejects.toThrow(/missing-app|not found/i);
    } finally {
      await runtime.close();
    }
  });
});
