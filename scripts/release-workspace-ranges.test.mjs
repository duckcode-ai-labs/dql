import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_PATHS, publishedWorkspaceRange } from './release-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('workspace:* publishes the exact sibling version, never a caret range', () => {
  // dql-cli@1.7.1 shipped "^1.7.1" for its siblings; npm then resolved
  // dql-agent 1.17.2 and the old CLI crashed on a removed export.
  assert.equal(publishedWorkspaceRange('workspace:*', '1.17.3'), '1.17.3');
  assert.equal(publishedWorkspaceRange('workspace:', '1.17.3'), '1.17.3');
  assert.equal(publishedWorkspaceRange('workspace:*', '1.18.0-rc.1'), '1.18.0-rc.1');
});

test('explicit workspace operators and ranges follow pnpm publish semantics', () => {
  assert.equal(publishedWorkspaceRange('workspace:^', '1.17.3'), '^1.17.3');
  assert.equal(publishedWorkspaceRange('workspace:~', '1.17.3'), '~1.17.3');
  assert.equal(publishedWorkspaceRange('workspace:^1.2.0', '1.17.3'), '^1.2.0');
});

test('every release package depends on its siblings through workspace:*', () => {
  // The exact pin above only protects users while the manifests keep using
  // workspace:*; a hand-written range would bypass it.
  const names = new Set(RELEASE_PACKAGE_PATHS.map((relPath) => (
    JSON.parse(readFileSync(path.join(root, relPath, 'package.json'), 'utf-8')).name
  )));
  for (const relPath of RELEASE_PACKAGE_PATHS) {
    const manifest = JSON.parse(readFileSync(path.join(root, relPath, 'package.json'), 'utf-8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!names.has(name)) continue;
        assert.equal(spec, 'workspace:*', `${relPath} ${field}.${name} must be workspace:*`);
      }
    }
  }
});
