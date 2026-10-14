#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageSpec = process.argv[2] ?? '@zlens/cli@latest';
const expectedVersion = packageSpec.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? null;
const root = mkdtempSync(join(tmpdir(), 'zlens-published-install-'));
const localDir = join(root, 'local');
const globalPrefix = join(root, 'global');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit code ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

try {
  console.log(`\nVerifying published CLI install: ${packageSpec}`);
  mkdirSync(localDir, { recursive: true });
  mkdirSync(globalPrefix, { recursive: true });
  run('npm', ['init', '--yes'], localDir);
  run('npm', ['install', '--save-dev', '--no-audit', '--no-fund', packageSpec], localDir);

  const binPath = (dir, name) => join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  const localBin = binPath(join(localDir, 'node_modules', '.bin'), 'zlens');
  assert(existsSync(localBin), 'project-local install links node_modules/.bin/zlens');
  const localVersion = run(localBin, ['--version'], localDir);
  assert(localVersion.startsWith('zlens '), `project-local zlens runs (${localVersion})`);
  if (expectedVersion) assert(localVersion === `zlens ${expectedVersion}`, `project-local version is ${expectedVersion}`);

  // The old command name stays as an alias: same stdout, one notice on stderr.
  const localAlias = binPath(join(localDir, 'node_modules', '.bin'), 'dql');
  assert(existsSync(localAlias), 'project-local install links the dql alias');
  const alias = spawnSync(localAlias, ['--version'], { cwd: localDir, encoding: 'utf-8', env: process.env });
  assert(alias.status === 0 && alias.stdout.trim() === localVersion, 'dql alias prints the same version on stdout');
  assert(/dql is now called zlens/.test(alias.stderr), 'dql alias prints its rename notice on stderr');

  run('npm', ['install', '--global', '--prefix', globalPrefix, '--no-audit', '--no-fund', packageSpec], root);
  const globalBin = process.platform === 'win32'
    ? binPath(globalPrefix, 'zlens')
    : join(globalPrefix, 'bin', 'zlens');
  assert(existsSync(globalBin), 'global install links the zlens command');
  const globalVersion = run(globalBin, ['--version'], root);
  assert(globalVersion.startsWith('zlens '), `global zlens runs (${globalVersion})`);
  if (expectedVersion) assert(globalVersion === `zlens ${expectedVersion}`, `global version is ${expectedVersion}`);

  const installedPackage = JSON.parse(readFileSync(join(
    localDir,
    'node_modules',
    '@zlens',
    'cli',
    'package.json',
  ), 'utf-8'));
  assert(installedPackage.bin?.zlens?.replace(/^\.\//, '') === 'dist/index.js', 'installed package maps the zlens bin');
  assert(installedPackage.bin?.dql?.replace(/^\.\//, '') === 'dist/dql-alias.js', 'installed package maps the dql alias');
  console.log('\n✓ published CLI local/global install smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
