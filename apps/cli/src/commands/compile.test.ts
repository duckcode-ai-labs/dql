import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestCache, type TrackedFile } from '@zlens/project';
import { collectInputFiles, type DQLManifest } from '@zlens/core';
import { manifestCacheTrackedFiles, runCompile } from './compile.js';

const baseFlags = {
  format: 'text' as const,
  verbose: false,
  help: false,
  version: false,
  check: false,
  open: null,
  input: '',
  outDir: '',
  port: null,
  chart: '',
  domain: '',
  owner: '',
  queryOnly: false,
  template: '',
  connection: '',
  skipTests: false,
};

function seedProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-compile-'));
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'demo' }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'blocks', 'revenue.dql'),
    `block "Revenue" {
  domain = "sales"
  type = "custom"
  query = """SELECT SUM(amount) AS revenue FROM orders"""
}`,
  );
  return projectRoot;
}

describe('runCompile cache integration', () => {
  it('populates the SQLite cache and serves the next compile from it', async () => {
    const projectRoot = seedProject();
    try {
      // First compile — cold miss, builds and writes to cache.
      await runCompile(projectRoot, [], baseFlags);

      const manifestPath = join(projectRoot, 'dql-manifest.json');
      const firstManifest: DQLManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(firstManifest.blocks).toHaveProperty('Revenue');
      expect(() => readFileSync(join(projectRoot, '.dql', 'cache', 'metadata.sqlite'))).not.toThrow();

      // Cache file should exist and contain a hit for the current fingerprint.
      const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');
      const cache = new ManifestCache({ path: cachePath });
      try {
        const files: TrackedFile[] = manifestCacheTrackedFiles(collectInputFiles({ projectRoot }), firstManifest.dqlVersion);
        const fp = cache.fingerprint(files);
        const lookup = cache.lookup<DQLManifest>(fp, files);
        expect(lookup.hit).toBe(true);
        if (lookup.hit) {
          expect(lookup.value.blocks).toHaveProperty('Revenue');
        }
      } finally {
        cache.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('invalidates the cache entry when a tracked file changes', async () => {
    const projectRoot = seedProject();
    try {
      await runCompile(projectRoot, [], baseFlags);

      const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');
      const manifestPath = join(projectRoot, 'dql-manifest.json');
      const firstManifest: DQLManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const files1: TrackedFile[] = manifestCacheTrackedFiles(collectInputFiles({ projectRoot }), firstManifest.dqlVersion);

      let fp1: string;
      {
        const cache = new ManifestCache({ path: cachePath });
        fp1 = cache.fingerprint(files1);
        expect(cache.lookup(fp1, files1).hit).toBe(true);
        cache.close();
      }

      // Mutate a tracked block — fingerprint must change → miss under fp1.
      writeFileSync(
        join(projectRoot, 'blocks', 'revenue.dql'),
        `block "Revenue" {
  domain = "sales"
  type = "custom"
  query = """SELECT COUNT(*) AS revenue FROM orders"""
}`,
      );

      {
        const cache = new ManifestCache({ path: cachePath });
        const files2: TrackedFile[] = manifestCacheTrackedFiles(collectInputFiles({ projectRoot }), firstManifest.dqlVersion);
        const fp2 = cache.fingerprint(files2);
        expect(fp2).not.toBe(fp1);
        const lookup = cache.lookup(fp2, files2);
        expect(lookup.hit).toBe(false);
        if (!lookup.hit) {
          // Diff should report the block file as changed.
          expect(lookup.changedFiles).toContain(join(projectRoot, 'blocks', 'revenue.dql'));
        }
        cache.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('--no-cache skips the cache entirely (no .dql/cache directory created)', async () => {
    const projectRoot = seedProject();
    try {
      await runCompile(projectRoot, ['--no-cache'], baseFlags);
      expect(() => readFileSync(join(projectRoot, '.dql', 'cache', 'manifest.sqlite')))
        .toThrow();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('invalidates the cache entry when the compiler version changes', () => {
    const projectRoot = seedProject();
    try {
      const inputFiles = collectInputFiles({ projectRoot });
      const cachePath = join(projectRoot, '.dql', 'cache', 'manifest.sqlite');
      const cache = new ManifestCache({ path: cachePath });
      try {
        const filesV1 = manifestCacheTrackedFiles(inputFiles, '1.0.0');
        expect(filesV1.some((file) => file.path === '__dql_compiler_semantics__')).toBe(true);
        const fp1 = cache.fingerprint(filesV1);
        cache.put(fp1, { project: 'demo' }, filesV1);

        const filesV2 = manifestCacheTrackedFiles(inputFiles, '1.0.1');
        const fp2 = cache.fingerprint(filesV2);
        expect(fp2).not.toBe(fp1);
        expect(cache.lookup(fp2, filesV2).hit).toBe(false);
      } finally {
        cache.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
