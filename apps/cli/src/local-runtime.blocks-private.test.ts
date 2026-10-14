import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'dql.config.json'), '{}\n');
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=DQL Test',
    '-c', 'user.email=dql-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function withServer<T>(projectRoot: string, run: (base: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose) => server ? server.close(() => resolveClose()) : resolveClose());
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const PRIVATE_BLOCK = '.dql/local/private/blocks';
const PRIVATE_COMPANION = '.dql/local/private/semantic-layer/blocks';

async function createPrivateBlock(base: string, name: string): Promise<{ path: string; companionPath: string }> {
  const response = await postJson(`${base}/api/blocks`, { name, visibility: 'private' });
  return await response.json() as { path: string; companionPath: string };
}

describe('private blocks stay out of git until they are published', () => {
  it('writes the block and its companion outside source control', async () => {
    const project = tempProject('dql-private-block-create-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      const created = await postJson(`${base}/api/blocks`, { name: 'scratch-metric', visibility: 'private' });
      expect(created.status).toBe(201);
      const body = await created.json() as { path: string; companionPath: string; visibility: string };
      expect(body.path).toBe(`${PRIVATE_BLOCK}/scratch-metric.dql`);
      expect(body.visibility).toBe('private');
      expect(existsSync(join(project, body.path))).toBe(true);

      // The companion must be private too, or the block hides while its YAML
      // announces it in tracked source.
      expect(body.companionPath).toBe(`${PRIVATE_COMPANION}/scratch-metric.yaml`);
      expect(existsSync(join(project, body.companionPath))).toBe(true);
      expect(existsSync(join(project, 'semantic-layer', 'blocks', 'uncategorized', 'scratch-metric.yaml'))).toBe(false);

      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).not.toContain('scratch-metric');
    });
  });

  it('still writes a shared block to tracked source', async () => {
    const project = tempProject('dql-private-block-shared-');
    await withServer(project, async (base) => {
      const created = await postJson(`${base}/api/blocks`, { name: 'team-metric' });
      const body = await created.json() as { path: string; visibility: string };
      expect(body.path).toBe('blocks/team-metric.dql');
      expect(body.visibility).toBe('shared');
    });
  });

  it('lists a private block in the library, marked private', async () => {
    const project = tempProject('dql-private-block-list-');
    await withServer(project, async (base) => {
      await createPrivateBlock(base, 'listed-metric');
      const library = await fetch(`${base}/api/blocks/library`).then((response) => response.json()) as {
        blocks: Array<{ name: string; path: string; visibility: string }>;
      };
      expect(library.blocks).toContainEqual(expect.objectContaining({
        path: `${PRIVATE_BLOCK}/listed-metric.dql`,
        visibility: 'private',
      }));
    });
  });

  it('publishing moves the block and its companion into tracked source', async () => {
    const project = tempProject('dql-private-block-publish-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      const draft = await createPrivateBlock(base, 'ready-metric');
      const blockContent = readFileSync(join(project, draft.path), 'utf-8');

      const published = await postJson(`${base}/api/blocks/publish`, { path: draft.path });
      expect(published.status).toBe(200);
      const body = await published.json() as { ok: boolean; path: string; companionPath: string };
      expect(body.ok).toBe(true);
      expect(body.path).toBe('blocks/ready-metric.dql');

      // Moved, not copied — and the companion followed it.
      expect(existsSync(join(project, draft.path))).toBe(false);
      expect(existsSync(join(project, draft.companionPath))).toBe(false);
      expect(readFileSync(join(project, 'blocks', 'ready-metric.dql'), 'utf-8')).toBe(blockContent);
      expect(existsSync(join(project, body.companionPath))).toBe(true);

      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).toContain('blocks/ready-metric.dql');
    });
  });

  it('refuses to publish over a shared block of the same name', async () => {
    const project = tempProject('dql-private-block-collision-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/blocks`, { name: 'overlap-metric' });
      const draft = await createPrivateBlock(base, 'overlap-metric');
      const sharedBefore = readFileSync(join(project, 'blocks', 'overlap-metric.dql'), 'utf-8');

      const published = await postJson(`${base}/api/blocks/publish`, { path: draft.path });
      expect(published.status).toBe(409);
      const body = await published.json() as { ok: boolean; error: string };
      expect(body.error).toContain('already exists');

      // Neither side was touched.
      expect(existsSync(join(project, draft.path))).toBe(true);
      expect(readFileSync(join(project, 'blocks', 'overlap-metric.dql'), 'utf-8')).toBe(sharedBefore);
    });
  });

  it('refuses to publish a path that is not a private block', async () => {
    const project = tempProject('dql-private-block-badpath-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/blocks`, { name: 'already-shared' });
      const published = await postJson(`${base}/api/blocks/publish`, { path: 'blocks/already-shared.dql' });
      expect(published.status).toBe(400);
      const body = await published.json() as { error: string };
      expect(body.error).toContain('private block');
    });
  });

  it('deleting a block recovers it and its companion together', async () => {
    const project = tempProject('dql-private-block-delete-');
    await withServer(project, async (base) => {
      const draft = await createPrivateBlock(base, 'throwaway-metric');
      const blockContent = readFileSync(join(project, draft.path), 'utf-8');

      const deleted = await fetch(
        `${base}/api/block-studio/block?path=${encodeURIComponent(draft.path)}`,
        { method: 'DELETE' },
      );
      expect(deleted.status).toBe(200);
      const body = await deleted.json() as {
        ok: boolean;
        recovered: { trashPath: string; files: string[] };
      };
      expect(body.ok).toBe(true);
      expect(body.recovered.files).toEqual([draft.path, draft.companionPath]);
      expect(existsSync(join(project, draft.path))).toBe(false);
      expect(existsSync(join(project, draft.companionPath))).toBe(false);

      // A block recovered without its companion is not something anyone could
      // put back by hand, so both are in the one bundle.
      const bundle = join(project, body.recovered.trashPath);
      expect(readFileSync(join(bundle, 'files', draft.path), 'utf-8')).toBe(blockContent);
      expect(existsSync(join(bundle, 'files', draft.companionPath))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(bundle, 'recovery.json'), 'utf-8')) as { files: string[] };
      expect(manifest.files).toEqual([draft.path, draft.companionPath]);
    });
  });
});
