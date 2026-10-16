import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REGISTRY_WAIT_MS,
  assertPublishCredentials,
  parseReleaseArguments,
  publishCommandArgs,
  registryWaitLimit,
  waitForRegistryVersions,
  wantsProvenance,
} from './release-packages.mjs';
import {
  findReleaseTarballs,
  isRegistryPropagationError,
  parseSmokeArguments,
  tarballFileName,
} from './smoke-cli-install.mjs';

test('on GitHub Actions publish refuses early, and says why, when NODE_AUTH_TOKEN is missing', () => {
  assert.throws(() => assertPublishCredentials({ GITHUB_ACTIONS: 'true' }), /NODE_AUTH_TOKEN is not set/);
  assert.throws(() => assertPublishCredentials({ GITHUB_ACTIONS: 'true', NODE_AUTH_TOKEN: '' }), /NPM_TOKEN/);
  assert.doesNotThrow(() => assertPublishCredentials({ GITHUB_ACTIONS: 'true', NODE_AUTH_TOKEN: 'npm_x' }));
});

test('a local fallback is not required to set NODE_AUTH_TOKEN (it uses npm login)', () => {
  assert.doesNotThrow(() => assertPublishCredentials({}));
});

test('provenance is requested only from GitHub Actions', () => {
  assert.equal(wantsProvenance({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(wantsProvenance({}), false);
  assert.equal(wantsProvenance({ GITHUB_ACTIONS: 'false' }), false);
});

test('--provenance is added only when asked for, before the otp', () => {
  assert.deepEqual(
    publishCommandArgs({ tag: 'latest', provenance: true, otp: '123456' }),
    ['publish', '--access', 'public', '--no-git-checks', '--tag', 'latest', '--provenance', '--otp', '123456'],
  );
  assert.ok(!publishCommandArgs({ tag: 'next' }).includes('--provenance'));
});

test('a forwarded `--` separator (pnpm release:dry-run -- ...) is ignored', () => {
  const release = parseReleaseArguments(['--dry-run', '--', '--tag', 'latest', '--expected-version', '1.17.3'], {});
  assert.equal(release.dryRun, true);
  assert.equal(release.tag, 'latest');
  assert.equal(release.expectedVersion, '1.17.3');
});


// --- the post-publish smoke waits for npm to list what was just published ---

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}

test('the smoke waits until npm lists every published version (0.1.0 smoke ran 8s after publish and got E404)', async () => {
  const clock = fakeClock();
  // npm listed @zlens/cli@0.1.0 about five minutes after `npm publish` returned.
  const listedAfter = { '@zlens/telemetry@0.2.0': 60_000, '@zlens/cli@0.2.0': 300_000 };
  const checks = [];
  const result = await waitForRegistryVersions(Object.keys(listedAfter), {
    ...clock,
    intervalMs: 20_000,
    timeoutMs: DEFAULT_REGISTRY_WAIT_MS,
    log: () => {},
    isVisible: async (spec) => {
      checks.push(spec);
      return clock.now() >= listedAfter[spec];
    },
  });
  assert.equal(result.elapsedMs, 300_000);
  // A version npm lists is not asked for again.
  assert.equal(checks.filter((spec) => spec === '@zlens/telemetry@0.2.0').length, 4);
});

test('the wait gives up after the limit and names what npm never listed', async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForRegistryVersions(['@zlens/cli@0.2.0', '@zlens/core@0.2.0'], {
      ...clock,
      intervalMs: 20_000,
      timeoutMs: 60_000,
      log: () => {},
      isVisible: async (spec) => spec === '@zlens/core@0.2.0',
    }),
    (error) => /did not list @zlens\/cli@0\.2\.0 within/.test(error.message) && !/core/.test(error.message),
  );
  assert.equal(clock.now(), 60_000);
});

test('ZLENS_RELEASE_REGISTRY_WAIT_MS overrides the wait, and rejects nonsense', () => {
  assert.equal(registryWaitLimit({}), DEFAULT_REGISTRY_WAIT_MS);
  assert.equal(registryWaitLimit({ ZLENS_RELEASE_REGISTRY_WAIT_MS: '0' }), 0);
  assert.equal(registryWaitLimit({ ZLENS_RELEASE_REGISTRY_WAIT_MS: '90000' }), 90_000);
  assert.throws(() => registryWaitLimit({ ZLENS_RELEASE_REGISTRY_WAIT_MS: 'soon' }), /milliseconds/);
});

test('the smoke retries npm propagation errors only', () => {
  // The exact 0.1.0 failure.
  assert.equal(isRegistryPropagationError("npm error code E404\nnpm error 404  '@zlens/cli@0.1.0' is not in this registry."), true);
  assert.equal(isRegistryPropagationError('npm error code ETARGET\nnpm error notarget No matching version found for @zlens/agent@0.2.0.'), true);
  assert.equal(isRegistryPropagationError('npm error code EACCES'), false);
  assert.equal(isRegistryPropagationError('Error: Cannot find module dist/index.js'), false);
});

test('the dry-run smoke installs the packed tarballs of the release version', () => {
  assert.deepEqual(parseSmokeArguments(['@zlens/cli@0.2.0']), {
    packageSpec: '@zlens/cli@0.2.0', expectedVersion: '0.2.0', tarballDir: null,
  });
  assert.deepEqual(parseSmokeArguments(['--tarballs', '.release-artifacts', '@zlens/cli@0.2.0']), {
    packageSpec: '@zlens/cli@0.2.0', expectedVersion: '0.2.0', tarballDir: '.release-artifacts',
  });
  assert.throws(() => parseSmokeArguments(['--tarballs', '.release-artifacts', '@zlens/cli@latest']), /exact version/);
  assert.equal(tarballFileName('@zlens/cli', '0.2.0'), 'zlens-cli-0.2.0.tgz');
  assert.equal(tarballFileName('create-zlens-app', '0.2.0'), 'create-zlens-app-0.2.0.tgz');
});

test('findReleaseTarballs picks only the release version', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'zlens-tarballs-'));
  try {
    for (const file of ['zlens-cli-0.2.0.tgz', 'zlens-cli-0.1.0.tgz', 'zlens-agent-0.2.0.tgz', 'create-zlens-app-0.2.0.tgz', 'dql-language-support-0.2.0.tgz']) {
      writeFileSync(path.join(dir, file), '');
    }
    assert.deepEqual([...findReleaseTarballs(dir, '0.2.0').keys()].sort(), ['@zlens/agent', '@zlens/cli', 'create-zlens-app']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tag-triggered publish job never needs VSCE_PAT; the extension job is manual only', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const publishJob = jobs.find((job) => job.startsWith('publish-packages:'));
  const extensionJob = jobs.find((job) => job.startsWith('package-extension:'));
  assert.ok(publishJob && extensionJob, 'release.yml has publish-packages and package-extension jobs');
  assert.doesNotMatch(publishJob, /VSCE_PAT/);
  assert.match(publishJob, /github\.event_name == 'push'/);
  assert.match(extensionJob, /github\.event_name == 'workflow_dispatch' && inputs\.publish_extension == true/);
});
