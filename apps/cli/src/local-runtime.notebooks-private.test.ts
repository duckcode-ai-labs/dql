import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const DRAFT_DIR = join('.dql', 'local', 'private', 'notebooks');

describe('private notebook drafts stay out of git until they are published', () => {
  it('creates a private draft outside source control and lists it as private', async () => {
    const project = tempProject('dql-private-notebook-create-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      const created = await postJson(`${base}/api/notebooks`, {
        name: 'Scratch Idea',
        template: 'blank',
        visibility: 'private',
      });
      expect(created.status).toBe(201);
      const body = await created.json() as { path: string; visibility: string };
      expect(body.path).toBe('.dql/local/private/notebooks/scratch_idea.dqlnb');
      expect(body.visibility).toBe('private');
      expect(existsSync(join(project, DRAFT_DIR, 'scratch_idea.dqlnb'))).toBe(true);
      expect(existsSync(join(project, 'notebooks', 'scratch_idea.dqlnb'))).toBe(false);

      const listed = await fetch(`${base}/api/notebooks`).then((response) => response.json()) as Array<{
        path: string;
        visibility?: string;
        type: string;
      }>;
      expect(listed).toContainEqual(expect.objectContaining({
        path: '.dql/local/private/notebooks/scratch_idea.dqlnb',
        visibility: 'private',
        type: 'notebook',
      }));

      // The point of the whole feature: git cannot see it.
      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).not.toContain('scratch_idea');
    });
  });

  it('still writes a shared notebook to the tracked folder', async () => {
    const project = tempProject('dql-private-notebook-shared-');
    await withServer(project, async (base) => {
      const created = await postJson(`${base}/api/notebooks`, { name: 'Team Report', template: 'blank' });
      const body = await created.json() as { path: string; visibility: string };
      expect(body.path).toBe('notebooks/team_report.dqlnb');
      expect(body.visibility).toBe('shared');
    });
  });

  it('publishing moves the draft into the tracked folder where git sees it', async () => {
    const project = tempProject('dql-private-notebook-publish-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      await postJson(`${base}/api/notebooks`, { name: 'Ready To Share', template: 'blank', visibility: 'private' });
      const draftPath = '.dql/local/private/notebooks/ready_to_share.dqlnb';
      const draftContent = readFileSync(join(project, DRAFT_DIR, 'ready_to_share.dqlnb'), 'utf-8');

      const published = await postJson(`${base}/api/notebooks/publish`, { path: draftPath });
      expect(published.status).toBe(200);
      const body = await published.json() as { ok: boolean; path: string; previousPath: string };
      expect(body).toMatchObject({
        ok: true,
        path: 'notebooks/ready_to_share.dqlnb',
        previousPath: draftPath,
      });

      // The same file, moved — not a copy left behind in both places.
      expect(existsSync(join(project, DRAFT_DIR, 'ready_to_share.dqlnb'))).toBe(false);
      expect(readFileSync(join(project, 'notebooks', 'ready_to_share.dqlnb'), 'utf-8')).toBe(draftContent);

      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).toContain('notebooks/ready_to_share.dqlnb');
    });
  });

  it('refuses to publish over a shared notebook of the same name', async () => {
    const project = tempProject('dql-private-notebook-collision-');
    mkdirSync(join(project, 'notebooks'), { recursive: true });
    writeFileSync(join(project, 'notebooks', 'overlap.dqlnb'), '{"metadata":{}}\n');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/notebooks`, { name: 'Overlap', template: 'blank', visibility: 'private' });
      const published = await postJson(`${base}/api/notebooks/publish`, {
        path: '.dql/local/private/notebooks/overlap.dqlnb',
      });
      expect(published.status).toBe(409);
      const body = await published.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('already exists');
      // Neither file was touched.
      expect(existsSync(join(project, DRAFT_DIR, 'overlap.dqlnb'))).toBe(true);
      expect(readFileSync(join(project, 'notebooks', 'overlap.dqlnb'), 'utf-8')).toBe('{"metadata":{}}\n');
    });
  });

  it('refuses to publish a path that is not a private draft', async () => {
    const project = tempProject('dql-private-notebook-badpath-');
    mkdirSync(join(project, 'notebooks'), { recursive: true });
    writeFileSync(join(project, 'notebooks', 'already_shared.dqlnb'), '{"metadata":{}}\n');
    await withServer(project, async (base) => {
      const published = await postJson(`${base}/api/notebooks/publish`, {
        path: 'notebooks/already_shared.dqlnb',
      });
      expect(published.status).toBe(400);
      const body = await published.json() as { ok: boolean; error: string };
      expect(body.error).toContain('private notebook draft');
    });
  });

  it('deleting a draft leaves a recovery bundle instead of erasing it', async () => {
    const project = tempProject('dql-private-notebook-delete-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/notebooks`, { name: 'Throwaway', template: 'blank', visibility: 'private' });
      const draftPath = '.dql/local/private/notebooks/throwaway.dqlnb';
      const draftContent = readFileSync(join(project, DRAFT_DIR, 'throwaway.dqlnb'), 'utf-8');

      const deleted = await fetch(`${base}/api/notebooks?path=${encodeURIComponent(draftPath)}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      const body = await deleted.json() as {
        ok: boolean;
        recovered: { recoveryId: string; trashPath: string; files: string[] };
      };
      expect(body.ok).toBe(true);
      expect(body.recovered.files).toEqual([draftPath]);
      expect(existsSync(join(project, DRAFT_DIR, 'throwaway.dqlnb'))).toBe(false);

      // Recoverable: the bytes are still there, and a manifest says what moved.
      const bundle = join(project, body.recovered.trashPath);
      expect(readFileSync(join(bundle, 'files', draftPath), 'utf-8')).toBe(draftContent);
      const manifest = JSON.parse(readFileSync(join(bundle, 'recovery.json'), 'utf-8')) as { files: string[] };
      expect(manifest.files).toEqual([draftPath]);
    });
  });

  it('recovers a shared notebook too, because an uncommitted one is nowhere else', async () => {
    const project = tempProject('dql-private-notebook-delete-shared-');
    await withServer(project, async (base) => {
      await postJson(`${base}/api/notebooks`, { name: 'Shared Delete', template: 'blank' });
      const deleted = await fetch(
        `${base}/api/notebooks?path=${encodeURIComponent('notebooks/shared_delete.dqlnb')}`,
        { method: 'DELETE' },
      );
      const body = await deleted.json() as { ok: boolean; recovered: { trashPath: string; files: string[] } };
      expect(body.ok).toBe(true);
      expect(body.recovered.files).toEqual(['notebooks/shared_delete.dqlnb']);
      expect(existsSync(join(project, body.recovered.trashPath, 'recovery.json'))).toBe(true);
    });
  });
});
