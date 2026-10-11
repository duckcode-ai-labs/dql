import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublishCredentials,
  publishCommandArgs,
  wantsProvenance,
} from './release-packages.mjs';

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
