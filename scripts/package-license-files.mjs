#!/usr/bin/env node
// Copies the repository's LICENSE and NOTICE into a package directory so the
// npm tarball (and the VS Code .vsix) carries the licence text and the
// required notices. Every published package runs this as its `prepack`
// script, and scripts/release-packages.mjs calls it before packing too.
//
//   node ../../scripts/package-license-files.mjs                       # -> ./LICENSE, ./NOTICE
//   node ../../scripts/package-license-files.mjs --license-file LICENSE.txt
//
// The copies are build output: .gitignore keeps them out of git. The root
// LICENSE and NOTICE are the only sources of truth.
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copy the root LICENSE and NOTICE into `packageDir`.
 * Returns the absolute paths written.
 */
export function copyLicenseFiles(packageDir, { licenseFile = 'LICENSE', root = REPO_ROOT } = {}) {
  const target = path.resolve(packageDir);
  if (target === path.resolve(root)) {
    throw new Error('package-license-files: run this from a package directory, not the repository root.');
  }
  if (!existsSync(path.join(target, 'package.json'))) {
    throw new Error(`package-license-files: ${target} has no package.json.`);
  }
  const copies = [
    [path.join(root, 'LICENSE'), path.join(target, licenseFile)],
    [path.join(root, 'NOTICE'), path.join(target, 'NOTICE')],
  ];
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`package-license-files: ${from} is missing.`);
    copyFileSync(from, to);
  }
  return copies.map(([, to]) => to);
}

export function parseArguments(argv) {
  let licenseFile = 'LICENSE';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--license-file') {
      licenseFile = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--license-file=')) {
      licenseFile = arg.slice('--license-file='.length);
    } else {
      throw new Error(`package-license-files: unknown argument ${arg}`);
    }
    if (!licenseFile || licenseFile.includes('/') || licenseFile.includes('\\')) {
      throw new Error('package-license-files: --license-file takes a plain file name, e.g. LICENSE.txt');
    }
  }
  return { licenseFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { licenseFile } = parseArguments(process.argv.slice(2));
    copyLicenseFiles(process.cwd(), { licenseFile });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
