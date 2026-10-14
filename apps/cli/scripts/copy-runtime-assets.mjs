import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const DIST_ROOT = resolve(CLI_ROOT, 'dist');
const ASSETS_ROOT = join(DIST_ROOT, 'assets');

const assets = [
  {
    source: resolve(REPO_ROOT, 'apps/notebook-browser'),
    target: join(ASSETS_ROOT, 'notebook-browser'),
  },
  {
    source: resolve(REPO_ROOT, 'apps/dql-notebook/dist'),
    target: join(ASSETS_ROOT, 'dql-notebook'),
  },
];

mkdirSync(ASSETS_ROOT, { recursive: true });

for (const asset of assets) {
  if (!existsSync(asset.source)) {
    throw new Error(`Missing runtime asset directory: ${asset.source}`);
  }

  rmSync(asset.target, { recursive: true, force: true });
  cpSync(asset.source, asset.target, { recursive: true });
}

// ── Resolve workspace:* dependencies for npm install -g compatibility ───────
// pnpm's workspace:* protocol breaks `npm install -g .` because npm doesn't
// understand it. Replace workspace:* with the actual versions from each
// package's package.json so the CLI can be installed globally from source.
const cliPkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8'));
const deps = cliPkg.dependencies ?? {};
let changed = false;

// Package names no longer match folder names (`@zlens/core` lives in
// packages/dql-core), so index every workspace package by its declared name.
const workspaceVersions = new Map();
for (const group of ['packages', 'apps']) {
  const groupDir = join(REPO_ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(groupDir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
    if (pkg.name && pkg.version) workspaceVersions.set(pkg.name, pkg.version);
  }
}

for (const [name, version] of Object.entries(deps)) {
  if (typeof version === 'string' && version.startsWith('workspace:')) {
    // Find the package's actual version in the monorepo
    const resolvedVersion = workspaceVersions.get(name);
    if (resolvedVersion) {
      deps[name] = `^${resolvedVersion}`;
      changed = true;
    }
  }
}

if (changed) {
  cliPkg.dependencies = deps;
  // Fix paths for installing from dist/ directory directly:
  // bin points to ./dist/index.js from repo root, but from dist/ it's ./index.js
  if (cliPkg.bin) {
    for (const [cmd, path] of Object.entries(cliPkg.bin)) {
      cliPkg.bin[cmd] = path.replace('./dist/', './');
    }
  }
  // The generated package is published from dist/ itself. Let npm include the
  // full compiled tree instead of carrying the source package's files allowlist.
  delete cliPkg.files;
  // Published CLI artifacts should not carry workspace-only dev deps such as
  // the private notebook app package.
  delete cliPkg.devDependencies;
  writeFileSync(join(CLI_ROOT, 'dist', 'package.json'), JSON.stringify(cliPkg, null, 2) + '\n');
}
