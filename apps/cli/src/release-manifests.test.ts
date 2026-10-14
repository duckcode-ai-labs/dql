import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Guard against the class of silent shipping-config bug that broke `npm i -g
 * @zlens/cli@latest` for every user on Node 23/24: a too-tight
 * `engines` cap plus a native dependency (better-sqlite3) old enough to lack
 * prebuilt binaries for their Node. These are invisible to normal unit tests, so
 * assert them here.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate repo root (pnpm-workspace.yaml)');
}

function workspaceManifests(): Array<{ name: string; path: string; pkg: Record<string, unknown> }> {
  const root = repoRoot();
  const out: Array<{ name: string; path: string; pkg: Record<string, unknown> }> = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const path = join(base, entry, 'package.json');
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      out.push({ name: (pkg.name as string) ?? `${group}/${entry}`, path, pkg });
    }
  }
  return out;
}

describe('release manifests stay installable on current Node', () => {
  const manifests = workspaceManifests();

  it('no package caps engines.node below the current Node LTS (24)', () => {
    const capped = manifests
      .filter((m) => {
        const node = (m.pkg.engines as { node?: string } | undefined)?.node;
        // Reject an explicit upper bound that excludes Node 23/24 (e.g. "<23", "<=22").
        return typeof node === 'string' && /<\s*2[0-4]\b/.test(node);
      })
      .map((m) => m.name);
    expect(capped).toEqual([]);
  });

  it('better-sqlite3 stays on a major that ships prebuilt binaries for current Node (>=12)', () => {
    const offenders: string[] = [];
    for (const m of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const range = (m.pkg[field] as Record<string, string> | undefined)?.['better-sqlite3'];
        if (!range) continue;
        const major = Number(range.replace(/^[^0-9]*/, '').split('.')[0]);
        if (!Number.isFinite(major) || major < 12) offenders.push(`${m.name}:${field} -> ${range}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes the zlens executable and the dql alias (E2E-005)', () => {
    const cli = manifests.find((manifest) => manifest.name === '@zlens/cli');
    expect(cli).toBeDefined();
    expect(cli?.pkg.bin).toEqual({ zlens: './dist/index.js', dql: './dist/dql-alias.js' });
    expect(cli?.pkg.files).toContain('dist');

    for (const entry of ['index.ts', 'dql-alias.ts']) {
      const source = readFileSync(join(dirname(cli!.path), 'src', entry), 'utf-8');
      expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    }
  });
});
