// Thin isomorphic-git wrapper used by `zlens diff <path>` to resolve the
// HEAD blob for a file inside a git repo.

import { statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import git from 'isomorphic-git';
import * as fs from 'node:fs';

export interface RepoContext {
  /** Absolute path to the repository root (where `.git` lives). */
  dir: string;
  /** Relative path of the requested file from the repo root, POSIX-separated. */
  relpath: string;
}

/**
 * Locate the git repository containing `absPath`. Walks upward looking
 * for a `.git` directory. Returns `null` when no repository is found.
 */
export function findRepoContext(absPath: string): RepoContext | null {
  let dir = resolve(absPath);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    dir = resolve(dir, '..');
  }
  while (true) {
    if (statSync(join(dir, '.git'), { throwIfNoEntry: false })) {
      const rel = relative(dir, absPath).split(/[\\/]/).join('/');
      return { dir, relpath: rel };
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the HEAD-committed contents of `relpath` as a UTF-8 string. Returns
 * `null` if HEAD has no such file (newly added in the working copy).
 */
export async function readHeadBlob(ctx: RepoContext): Promise<string | null> {
  try {
    const commitSha = await git.resolveRef({ fs, dir: ctx.dir, ref: 'HEAD' });
    const { blob } = await git.readBlob({
      fs,
      dir: ctx.dir,
      oid: commitSha,
      filepath: ctx.relpath,
    });
    return new TextDecoder('utf-8').decode(blob);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === 'NotFoundError' || code === 'ENOENT';
}
