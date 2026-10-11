import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RELEASE_PACKAGE_PATHS = [
  // Order matters — leaf packages first, leaves of leaves before that. The
  // CLI is published last because it depends on every other workspace package.
  'packages/dql-telemetry',
  'packages/dql-openlineage',
  'packages/dql-plugin-api',
  'packages/dql-ui',
  'packages/dql-core',
  'packages/dql-compiler',
  'packages/dql-runtime',
  'packages/dql-charts',
  'packages/dql-project',
  'packages/dql-governance',
  'packages/dql-connectors',
  'packages/dql-notebook',
  'packages/dql-agent',
  'packages/dql-mcp',
  'packages/dql-slack',
  'packages/dql-lsp',
  'apps/vscode-extension',
  'apps/cli',
  'packages/create-dql-app',
];

export const RELEASE_TAGS = new Set(['latest', 'next']);

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;

export function parseReleaseArguments(argv, env = process.env) {
  let dryRun = false;
  let publish = false;
  let tag;
  let expectedVersion;
  let otp = env.NPM_CONFIG_OTP ?? env.npm_config_otp;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--publish') {
      publish = true;
      continue;
    }
    if (arg === '--tag') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --tag. Use --tag latest or --tag next.');
      }
      if (tag) throw new Error('Specify --tag exactly once.');
      tag = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--tag=')) {
      const value = arg.slice('--tag='.length);
      if (!value) throw new Error('Missing value for --tag. Use --tag latest or --tag next.');
      if (tag) throw new Error('Specify --tag exactly once.');
      tag = value;
      continue;
    }
    if (arg === '--expected-version') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --expected-version. Use the exact release SemVer version.');
      }
      if (expectedVersion) throw new Error('Specify --expected-version exactly once.');
      expectedVersion = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--expected-version=')) {
      const value = arg.slice('--expected-version='.length);
      if (!value) throw new Error('Missing value for --expected-version. Use the exact release SemVer version.');
      if (expectedVersion) throw new Error('Specify --expected-version exactly once.');
      expectedVersion = value;
      continue;
    }
    if (arg === '--otp') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --otp.');
      otp = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--otp=')) {
      const value = arg.slice('--otp='.length);
      if (!value) throw new Error('Missing value for --otp.');
      otp = value;
      continue;
    }
    throw new Error(`Unknown release argument: ${arg}`);
  }

  if (Number(dryRun) + Number(publish) !== 1) {
    throw new Error('Specify exactly one of --dry-run or --publish.');
  }
  if (!RELEASE_TAGS.has(tag)) {
    throw new Error('Release tag is required. Use --tag latest or --tag next.');
  }
  if (!expectedVersion) {
    throw new Error('Expected version is required. Use --expected-version <semver>.');
  }
  requiredReleaseTag(expectedVersion);

  return { dryRun, publish, tag, expectedVersion, otp };
}

export function requiredReleaseTag(version) {
  if (STABLE_VERSION.test(version)) return 'latest';
  if (PRERELEASE_VERSION.test(version)) return 'next';
  throw new Error(`Release version ${version} is not a valid stable or prerelease SemVer version.`);
}

export function assertReleaseTagCompatibility(version, tag) {
  const requiredTag = requiredReleaseTag(version);
  if (tag !== requiredTag) {
    throw new Error(
      `Release tag mismatch: ${version} must use --tag ${requiredTag}, received --tag ${tag}.`,
    );
  }
  return requiredTag;
}

export function assertExpectedReleaseVersion(manifestVersion, expectedVersion) {
  if (manifestVersion !== expectedVersion) {
    throw new Error(
      `Release version mismatch: manifests declare ${manifestVersion}, expected ${expectedVersion}.`,
    );
  }
  return manifestVersion;
}

export function exactPackageSpec(packageName, version) {
  return `${packageName}@${version}`;
}

export function publishCommandArgs({ tag, otp }) {
  return [
    'publish',
    '--access',
    'public',
    '--no-git-checks',
    '--tag',
    tag,
    ...(otp ? ['--otp', otp] : []),
  ];
}

export function assertSynchronizedReleaseVersions(packageManifests) {
  const versions = new Set(packageManifests.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    const entries = packageManifests
      .map(({ relPath, manifest }) => `${relPath}=${manifest.version}`)
      .join(', ');
    throw new Error(`Release package versions must be synchronized: ${entries}`);
  }
  const [version] = versions;
  requiredReleaseTag(version);
  return version;
}

export function readReleasePackageManifests(root) {
  return RELEASE_PACKAGE_PATHS.map((relPath) => {
    const packagePath = path.join(root, relPath, 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf-8'));
    if (!manifest.name || !manifest.version) {
      throw new Error(`${relPath}/package.json must declare name and version.`);
    }
    return { relPath, packagePath, manifest };
  });
}

async function run(command, args, cwd) {
  const redactedArgs = args.map((arg, index) => {
    if (arg === '--otp') return arg;
    if (args[index - 1] === '--otp') return '***';
    if (arg.startsWith('--otp=')) return '--otp=***';
    return arg;
  });
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${redactedArgs.join(' ')} failed in ${cwd} with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function packageVersionExists(root, packageName, version) {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['view', exactPackageSpec(packageName, version), 'version', '--silent'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Prepare package manifests for npm pack/publish.
 *
 * - Replace all "workspace:*" dependency versions with the actual package
 *   version. pnpm publish is supposed to do this automatically, but it doesn't
 *   always work reliably when running from the release script.
 * - Remove per-package prepublishOnly hooks. The script has already run the
 *   workspace build once, and those hooks rebuild dist/ after pruning compiled
 *   test files from the package payload.
 *
 * Returns a Map of filePath -> originalContent for restoration after publish.
 */
function preparePackageManifests(root) {
  // Build a map of package name -> version from every workspace package,
  // including private packages used only for local build/dev dependencies.
  const versionMap = new Map();
  for (const workspaceDir of ['packages', 'apps']) {
    const absWorkspaceDir = path.join(root, workspaceDir);
    if (!existsSync(absWorkspaceDir)) continue;
    for (const entry of readdirSync(absWorkspaceDir)) {
      const pkgPath = path.join(absWorkspaceDir, entry, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && pkg.version) {
        versionMap.set(pkg.name, pkg.version);
      }
    }
  }

  const originals = new Map();

  for (const relPath of RELEASE_PACKAGE_PATHS) {
    const pkgPath = path.join(root, relPath, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    let changed = false;

    for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[depField];
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          const resolvedVersion = versionMap.get(name);
          if (resolvedVersion) {
            deps[name] = `^${resolvedVersion}`;
            changed = true;
          } else {
            console.warn(`  Warning: ${relPath} depends on ${name} (${version}) but no workspace package found`);
          }
        }
      }
    }

    if (pkg.scripts?.prepublishOnly) {
      delete pkg.scripts.prepublishOnly;
      if (Object.keys(pkg.scripts).length === 0) {
        delete pkg.scripts;
      }
      changed = true;
    }

    if (changed) {
      originals.set(pkgPath, raw);
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`  Prepared ${relPath}/package.json`);
    }
  }

  return originals;
}

function restoreOriginals(originals) {
  for (const [filePath, content] of originals) {
    writeFileSync(filePath, content);
  }
  if (originals.size > 0) {
    console.log(`\n  Restored ${originals.size} package.json file(s)`);
  }
}

function pruneDistTestArtifacts(packageDir) {
  const distDir = path.join(packageDir, 'dist');
  if (!existsSync(distDir)) return;

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (entry === '__tests__') {
          rmSync(abs, { recursive: true, force: true });
          continue;
        }
        walk(abs);
        continue;
      }
      if (/\.(test|spec)\.(js|js\.map|d\.ts|d\.ts\.map)$/.test(entry)) {
        rmSync(abs, { force: true });
      }
    }
  };

  walk(distDir);
}

export async function main({ argv = process.argv.slice(2), cwd = process.cwd(), env = process.env } = {}) {
  const release = parseReleaseArguments(argv, env);
  assertReleaseTagCompatibility(release.expectedVersion, release.tag);
  const packageManifests = readReleasePackageManifests(cwd);
  const version = assertSynchronizedReleaseVersions(packageManifests);
  assertExpectedReleaseVersion(version, release.expectedVersion);
  const artifactsDir = path.join(cwd, '.release-artifacts');

  console.log(`\nRelease ${release.dryRun ? 'dry run' : 'publish'}: ${version} -> npm dist-tag ${release.tag}`);
  await mkdir(artifactsDir, { recursive: true });

  // Build everything first so the CLI tarball picks up a fresh notebook UI
  // bundle. The CLI's own `prepublishOnly` rebuilds `apps/cli` but not
  // `apps/dql-notebook`, whose `dist/` gets copied into the CLI's
  // `dist/assets/dql-notebook/` by copy-runtime-assets.mjs. Past releases
  // shipped a stale React build because that app wasn't rebuilt.
  console.log('\nBuilding all packages (so CLI ships fresh notebook UI)...');
  await run('pnpm', ['-w', 'build'], cwd);

  // Replace workspace:* with real versions and disable redundant package-level
  // publish hooks before pack/publish.
  console.log('\nPreparing package manifests...');
  const originals = preparePackageManifests(cwd);
  // `finally` does not run when the process is killed. Stopping a publish at
  // npm's approval prompt used to leave every manifest pointing at registry
  // versions instead of workspace:*, and the next build then ran the packages
  // in the wrong order.
  const restoreOnSignal = (signal) => {
    restoreOriginals(originals);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', restoreOnSignal);
  process.once('SIGTERM', restoreOnSignal);

  let exitCode = 0;
  try {
    for (const { relPath, manifest } of packageManifests) {
      const packageDir = path.join(cwd, relPath);
      pruneDistTestArtifacts(packageDir);
      if (release.dryRun) {
        console.log(`\n==> Packing ${relPath} for npm dist-tag ${release.tag}`);
        await run('pnpm', ['pack', '--pack-destination', artifactsDir], packageDir);
      } else if (await packageVersionExists(cwd, manifest.name, manifest.version)) {
        console.log(`\n==> Skipping ${relPath} (${exactPackageSpec(manifest.name, manifest.version)} already exists)`);
      } else {
        console.log(`\n==> Publishing ${relPath} to npm dist-tag ${release.tag}`);
        await run('pnpm', publishCommandArgs(release), packageDir);
      }
    }
    if (release.publish) {
      const cli = packageManifests.find(({ relPath }) => relPath === 'apps/cli')?.manifest;
      if (!cli) throw new Error('Release package list must include apps/cli for the post-publish smoke.');
      const cliSpec = exactPackageSpec(cli.name, cli.version);
      console.log(`\n==> Verifying clean local/global install for exact ${cliSpec}`);
      await run(process.execPath, [
        path.join(cwd, 'scripts/smoke-cli-install.mjs'),
        cliSpec,
      ], cwd);
    }
  } catch (err) {
    console.error(`\nRelease ${release.publish ? 'publish' : 'dry run'} failed: ${err.message}`);
    exitCode = 1;
  } finally {
    // Always restore originals so workspace:* stays in the repo.
    process.removeListener('SIGINT', restoreOnSignal);
    process.removeListener('SIGTERM', restoreOnSignal);
    restoreOriginals(originals);
  }

  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`Release setup failed: ${err.message}`);
    process.exitCode = 1;
  }
}
