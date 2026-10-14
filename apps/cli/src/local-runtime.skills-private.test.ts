import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import { loadSkills } from '@zlens/agent';
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

function send(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type SkillView = { id: string; qualifiedId: string; visibility: string; sourcePath: string; body: string };

const PRIVATE_FILE = join('.dql', 'local', 'private', 'skills', 'churn-rules.skill.md');

async function createPrivateSkill(base: string, id = 'churn-rules'): Promise<SkillView> {
  const response = await send(`${base}/api/skills`, 'POST', {
    skill: { id, scope: 'project', body: 'Churn means no order in 90 days.', visibility: 'private' },
  });
  expect(response.status).toBe(200);
  return (await response.json() as { skill: SkillView }).skill;
}

describe('private skills stay out of git and out of answers until they are published', () => {
  it('writes a private skill outside source control and lists it as private', async () => {
    const project = tempProject('dql-private-skill-create-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      const skill = await createPrivateSkill(base);
      expect(skill.visibility).toBe('private');
      expect(skill.qualifiedId).toBe('private::skill::churn-rules');
      expect(existsSync(join(project, PRIVATE_FILE))).toBe(true);
      expect(existsSync(join(project, 'skills', 'churn-rules.skill.md'))).toBe(false);

      const listed = await fetch(`${base}/api/skills`).then((response) => response.json()) as { skills: SkillView[] };
      expect(listed.skills).toContainEqual(expect.objectContaining({
        qualifiedId: 'private::skill::churn-rules',
        visibility: 'private',
      }));

      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).not.toContain('churn-rules');
    });
  });

  it('never reaches the loader every answer path reads skills through', async () => {
    const project = tempProject('dql-private-skill-retrieval-');
    await withServer(project, async (base) => {
      await createPrivateSkill(base);
      // Ask, the catalog, the manifest and the indexes all read `loadSkills`.
      // A private skill that appeared here would shape answers teammates
      // cannot reproduce.
      expect(loadSkills(project).skills.map((skill) => skill.id)).not.toContain('churn-rules');
    });
  });

  it('editing a private skill keeps it private', async () => {
    const project = tempProject('dql-private-skill-edit-');
    await withServer(project, async (base) => {
      const skill = await createPrivateSkill(base);
      const updated = await send(`${base}/api/skills/${encodeURIComponent(skill.qualifiedId)}`, 'PUT', {
        skill: { id: 'churn-rules', scope: 'project', body: 'Churn means no order in 60 days.' },
      });
      expect(updated.status).toBe(200);
      const body = await updated.json() as { skill: SkillView };
      expect(body.skill.visibility).toBe('private');
      expect(readFileSync(join(project, PRIVATE_FILE), 'utf-8')).toContain('60 days');
      // The old route resolved through the shared loader and would have
      // written a shared copy here.
      expect(existsSync(join(project, 'skills', 'churn-rules.skill.md'))).toBe(false);
      expect(loadSkills(project).skills.map((entry) => entry.id)).not.toContain('churn-rules');
    });
  });

  it('publishing moves it into the shared folder, where it starts to apply', async () => {
    const project = tempProject('dql-private-skill-publish-');
    git(project, ['init']);
    await withServer(project, async (base) => {
      const skill = await createPrivateSkill(base);
      const published = await send(`${base}/api/skills/publish`, 'POST', { id: skill.qualifiedId });
      expect(published.status).toBe(200);
      const body = await published.json() as { ok: boolean; path: string; skill?: SkillView };
      expect(body.ok).toBe(true);
      expect(body.path).toBe('skills/churn-rules.skill.md');
      expect(body.skill?.visibility).toBe('shared');

      expect(existsSync(join(project, PRIVATE_FILE))).toBe(false);
      expect(existsSync(join(project, 'skills', 'churn-rules.skill.md'))).toBe(true);
      expect(loadSkills(project).skills.map((entry) => entry.id)).toContain('churn-rules');

      const status = git(project, ['status', '--porcelain=v1', '--untracked-files=all']);
      expect(status).toContain('skills/churn-rules.skill.md');
    });
  });

  it('refuses a private skill whose name a shared skill already uses', async () => {
    const project = tempProject('dql-private-skill-collision-');
    await withServer(project, async (base) => {
      const shared = await send(`${base}/api/skills`, 'POST', {
        skill: { id: 'churn-rules', scope: 'project', body: 'Team definition.' },
      });
      expect(shared.status).toBe(200);
      const clash = await send(`${base}/api/skills`, 'POST', {
        skill: { id: 'churn-rules', scope: 'project', body: 'Mine.', visibility: 'private' },
      });
      expect(clash.status).toBe(409);
      expect(existsSync(join(project, PRIVATE_FILE))).toBe(false);
      expect(readFileSync(join(project, 'skills', 'churn-rules.skill.md'), 'utf-8')).toContain('Team definition.');
    });
  });

  it('refuses to publish something that is not a private skill', async () => {
    const project = tempProject('dql-private-skill-badpublish-');
    await withServer(project, async (base) => {
      const published = await send(`${base}/api/skills/publish`, 'POST', { id: 'churn-rules' });
      expect(published.status).toBe(400);
    });
  });

  it('deleting a private skill leaves a recovery bundle', async () => {
    const project = tempProject('dql-private-skill-delete-');
    await withServer(project, async (base) => {
      const skill = await createPrivateSkill(base);
      const before = readFileSync(join(project, PRIVATE_FILE), 'utf-8');
      const deleted = await send(`${base}/api/skills/${encodeURIComponent(skill.qualifiedId)}`, 'DELETE');
      expect(deleted.status).toBe(200);
      const body = await deleted.json() as { ok: boolean; recovered: { trashPath: string; files: string[] } };
      expect(body.recovered.files).toEqual(['.dql/local/private/skills/churn-rules.skill.md']);
      expect(existsSync(join(project, PRIVATE_FILE))).toBe(false);
      expect(readFileSync(join(project, body.recovered.trashPath, 'files', PRIVATE_FILE), 'utf-8')).toBe(before);
    });
  });

  it('deleting a shared skill recovers it too', async () => {
    const project = tempProject('dql-private-skill-delete-shared-');
    await withServer(project, async (base) => {
      await send(`${base}/api/skills`, 'POST', {
        skill: { id: 'team-rules', scope: 'project', body: 'Team guidance.' },
      });
      const deleted = await send(`${base}/api/skills/team-rules`, 'DELETE');
      const body = await deleted.json() as { ok: boolean; recovered?: { files: string[] } };
      expect(body.ok).toBe(true);
      expect(body.recovered?.files).toEqual(['skills/team-rules.skill.md']);
      expect(existsSync(join(project, 'skills', 'team-rules.skill.md'))).toBe(false);
      expect(loadSkills(project).skills.map((entry) => entry.id)).not.toContain('team-rules');
    });
  });
});
