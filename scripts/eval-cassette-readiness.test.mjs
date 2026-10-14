import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cassetteReadiness } from './eval-cassette-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withDir(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cassette-readiness-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const recorded = { kind: 'recorded_provider', replayClassification: 'recorded_provider', providerQuality: 'eligible' };
const synthetic = { kind: 'synthetic_deterministic_orchestration_fixture' };

test('a missing or empty directory is not ready', () => {
  assert.equal(cassetteReadiness(path.join(tmpdir(), 'does-not-exist-cassettes')).ready, false);
  withDir({}, (dir) => {
    const result = cassetteReadiness(dir);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'no provider cassettes are committed');
  });
});

test('legacy, synthetic, and unknown-provenance entries alone are not ready', () => {
  withDir({
    'a.json': { key: 'a', provenance: synthetic },
    'b.json': { key: 'b', provenance: { kind: 'migrated_legacy_deterministic_fixture' } },
    'c.json': { key: 'c' },
  }, (dir) => {
    const result = cassetteReadiness(dir);
    assert.equal(result.ready, false);
    assert.equal(result.totalEntries, 3);
    assert.equal(result.recordedProviderEntries, 0);
  });
});

test('one entry recorded from a real provider makes the directory ready', () => {
  withDir({
    'a.json': { key: 'a', provenance: synthetic },
    'b.json': { key: 'b', provenance: recorded },
  }, (dir) => {
    const result = cassetteReadiness(dir);
    assert.equal(result.ready, true);
    assert.equal(result.recordedProviderEntries, 1);
  });
});

test('entries load like CassetteStore: json only, keyed, corrupt files skipped', () => {
  withDir({
    'notes.txt': JSON.stringify({ key: 'txt', provenance: recorded }),
    'broken.json': '{ not json',
    'nokey.json': { provenance: recorded },
    'a.json': { key: 'a', provenance: synthetic },
  }, (dir) => {
    const result = cassetteReadiness(dir);
    assert.equal(result.totalEntries, 1);
    assert.equal(result.ready, false);
  });
});

test('the committed answerability cassettes are classified, not assumed', () => {
  const dir = path.join(root, 'apps/cli/test/fixtures/jaffle-supply-chain/test-cassettes/answerability');
  const result = cassetteReadiness(dir);
  assert.ok(result.totalEntries > 0, 'the fixture ships cassette entries');
  assert.equal(typeof result.ready, 'boolean');
  assert.equal(result.ready, result.recordedProviderEntries > 0);
});
