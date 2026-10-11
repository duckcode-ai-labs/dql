import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import { startLocalServer } from './local-runtime.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function openFilesUnder(root: string): string[] {
  if (!existsSync('/proc/self/fd')) return [];
  const open: string[] = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      const target = readlinkSync(join('/proc/self/fd', fd));
      if (target.startsWith(root)) open.push(target);
    } catch { /* descriptor closed while listing */ }
  }
  return open;
}

describe('local runtime releases its run store on close', () => {
  it('closes the agent run SQLite handle with the server', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-run-store-close-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'run_store_close' }));
    const dbPath = join(projectRoot, '.dql', 'local', 'agent-runs.sqlite');
    let server: Server | undefined;

    await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      connection: { driver: 'file' },
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });

    // While the runtime is up the store holds the file in WAL mode.
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());

    // SQLite checkpoints and deletes the WAL only when the last connection closes.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(openFilesUnder(projectRoot).filter((file) => file.includes('agent-runs.sqlite'))).toEqual([]);
  });
});
