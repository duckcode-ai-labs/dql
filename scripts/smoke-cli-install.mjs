#!/usr/bin/env node
// Install the ZLens CLI into clean folders and check that it runs.
//
//   node scripts/smoke-cli-install.mjs [@zlens/cli@X.Y.Z]
//     The published package, from the registry: a project-local install and a
//     global install. The release workflow runs this after publishing.
//
//   node scripts/smoke-cli-install.mjs --tarballs <dir> @zlens/cli@X.Y.Z
//     The tarballs `release-packages.mjs --dry-run` packed into <dir>, before
//     anything is published. The CLI tarball is installed with every sibling
//     @zlens/* tarball of the same version pinned through npm `overrides`, so
//     npm resolves the CLI's exact sibling versions from the tarballs and the
//     third-party dependencies from the registry, as a real install would. A
//     global install is skipped: it would fetch the unpublished siblings from
//     the registry.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * npm can answer 404 / "No matching version" for a version it published a
 * moment ago, until its CDN serves the new packument. Those errors are retried;
 * anything else fails at once.
 */
export function isRegistryPropagationError(output) {
  return /\bE404\b|\bETARGET\b|No matching version found|is not in this registry/i.test(output ?? '');
}

export function parseSmokeArguments(argv) {
  let tarballDir = null;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tarballs') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing directory for --tarballs.');
      tarballDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    rest.push(arg);
  }
  if (rest.length > 1) throw new Error(`Expected one package spec, received ${rest.join(' ')}`);
  const packageSpec = rest[0] ?? '@zlens/cli@latest';
  const expectedVersion = packageSpec.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? null;
  if (tarballDir && !expectedVersion) {
    throw new Error('--tarballs needs an exact version, for example @zlens/cli@0.2.0.');
  }
  return { packageSpec, expectedVersion, tarballDir };
}

/** The file name `pnpm pack` / `npm pack` gives a package: `@zlens/cli` 0.2.0 → zlens-cli-0.2.0.tgz. */
export function tarballFileName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * Map each packed release package of `version` in `dir` to its tarball. Every
 * `@zlens/*` tarball of that version, plus create-zlens-app.
 */
export function findReleaseTarballs(dir, version) {
  const suffix = `-${version}.tgz`;
  const found = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(suffix)) continue;
    const base = file.slice(0, -suffix.length);
    if (base.startsWith('zlens-')) found.set(`@zlens/${base.slice('zlens-'.length)}`, join(dir, file));
    else if (base === 'create-zlens-app') found.set('create-zlens-app', join(dir, file));
  }
  return found;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, cwd, { retries = 0, retryDelayMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status === 0) return result.stdout.trim();
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (attempt < retries && isRegistryPropagationError(output)) {
      console.log(`  … npm does not serve it yet (attempt ${attempt + 1}/${retries + 1}); retrying in ${Math.round(retryDelayMs / 1000)}s`);
      sleepSync(retryDelayMs);
      continue;
    }
    throw new Error([
      `${command} ${args.join(' ')} failed with exit code ${result.status}`,
      output,
    ].filter(Boolean).join('\n'));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

const binPath = (dir, name) => join(dir, process.platform === 'win32' ? `${name}.cmd` : name);

function checkLocalInstall(localDir, expectedVersion) {
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

  const installedPackage = JSON.parse(readFileSync(join(localDir, 'node_modules', '@zlens', 'cli', 'package.json'), 'utf-8'));
  assert(installedPackage.bin?.zlens?.replace(/^\.\//, '') === 'dist/index.js', 'installed package maps the zlens bin');
  assert(installedPackage.bin?.dql?.replace(/^\.\//, '') === 'dist/dql-alias.js', 'installed package maps the dql alias');
  return localVersion;
}

function smokePublished({ packageSpec, expectedVersion }, root) {
  const localDir = join(root, 'local');
  const globalPrefix = join(root, 'global');
  // A just-published version can 404 for a few minutes (see release-packages.mjs);
  // retry those errors for up to ten minutes.
  const registryRetry = { retries: 20, retryDelayMs: 30_000 };
  mkdirSync(localDir, { recursive: true });
  mkdirSync(globalPrefix, { recursive: true });
  run('npm', ['init', '--yes'], localDir);
  run('npm', ['install', '--save-dev', '--no-audit', '--no-fund', '--prefer-online', packageSpec], localDir, registryRetry);
  checkLocalInstall(localDir, expectedVersion);

  run('npm', ['install', '--global', '--prefix', globalPrefix, '--no-audit', '--no-fund', '--prefer-online', packageSpec], root, registryRetry);
  const globalBin = process.platform === 'win32'
    ? binPath(globalPrefix, 'zlens')
    : join(globalPrefix, 'bin', 'zlens');
  assert(existsSync(globalBin), 'global install links the zlens command');
  const globalVersion = run(globalBin, ['--version'], root);
  assert(globalVersion.startsWith('zlens '), `global zlens runs (${globalVersion})`);
  if (expectedVersion) assert(globalVersion === `zlens ${expectedVersion}`, `global version is ${expectedVersion}`);
}

function smokeTarballs({ packageSpec, expectedVersion, tarballDir }, root) {
  const dir = resolve(tarballDir);
  const tarballs = findReleaseTarballs(dir, expectedVersion);
  const cliTarball = tarballs.get('@zlens/cli');
  assert(Boolean(cliTarball), `packed ${tarballFileName('@zlens/cli', expectedVersion)} is in ${dir}`);
  const localDir = join(root, 'local');
  mkdirSync(localDir, { recursive: true });
  // npm refuses an override that differs from a direct dependency's spec, so
  // the CLI is the direct dependency and every sibling is an override.
  const overrides = Object.fromEntries(
    [...tarballs].filter(([name]) => name.startsWith('@zlens/') && name !== '@zlens/cli').map(([name, file]) => [name, `file:${file}`]),
  );
  writeFileSync(join(localDir, 'package.json'), `${JSON.stringify({
    name: 'zlens-tarball-smoke',
    private: true,
    devDependencies: { '@zlens/cli': `file:${cliTarball}` },
    overrides,
  }, null, 2)}\n`);
  console.log(`  installing ${packageSpec} from ${tarballs.size} packed tarball(s)`);
  run('npm', ['install', '--no-audit', '--no-fund'], localDir);
  checkLocalInstall(localDir, expectedVersion);

  // Every @zlens/* package the CLI pulled in must be the packed one, not a
  // registry copy of another version.
  const lock = JSON.parse(readFileSync(join(localDir, 'package-lock.json'), 'utf-8'));
  const zlensEntries = Object.entries(lock.packages ?? {}).filter(([key]) => /node_modules\/@zlens\//.test(key));
  const strays = zlensEntries.filter(([, entry]) => entry.version !== expectedVersion || !String(entry.resolved ?? '').startsWith('file:'));
  assert(zlensEntries.length > 1 && strays.length === 0, `all ${zlensEntries.length} installed @zlens/* packages come from the ${expectedVersion} tarballs`);

  const createTarball = tarballs.get('create-zlens-app');
  if (createTarball) {
    const createDir = join(root, 'create');
    mkdirSync(createDir, { recursive: true });
    run('npm', ['init', '--yes'], createDir);
    run('npm', ['install', '--no-audit', '--no-fund', `file:${createTarball}`], createDir);
    const help = run(binPath(join(createDir, 'node_modules', '.bin'), 'create-zlens-app'), ['--help'], createDir);
    assert(/create-zlens-app/.test(help), 'packed create-zlens-app prints its help');
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseSmokeArguments(argv);
  const root = mkdtempSync(join(tmpdir(), options.tarballDir ? 'zlens-tarball-install-' : 'zlens-published-install-'));
  try {
    if (options.tarballDir) {
      console.log(`\nVerifying packed CLI install: ${options.packageSpec} from ${options.tarballDir}`);
      smokeTarballs(options, root);
      console.log('\n✓ packed CLI install smoke passed');
    } else {
      console.log(`\nVerifying published CLI install: ${options.packageSpec}`);
      smokePublished(options, root);
      console.log('\n✓ published CLI local/global install smoke passed');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
