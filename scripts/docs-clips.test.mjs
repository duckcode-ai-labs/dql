// Light check for the docs feature clips (see scripts/docs-clips.mjs):
// every clip in docs/media/clips/clips.yml is a known id with a journey, has
// its MP4, WebM and PNG poster (and GIF where one is promised), each within its
// size budget, and a title, caption and steps for the accessible figcaption.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLIP_IDS, CLIPS_DIR, GIF_IDS, JOURNEYS_DIR, ROOT, budgetFor } from './docs-clips/clips.mjs';

// `js-yaml` is a dependency of the CLI; the repo root has no YAML parser of its own.
const { load: parse } = createRequire(join(ROOT, 'apps', 'cli', 'package.json'))('js-yaml');
const manifest = parse(readFileSync(join(CLIPS_DIR, 'clips.yml'), 'utf8')) ?? {};
const ids = Object.keys(manifest);

test('clips.yml lists only known clip ids, each with a journey', () => {
  assert.ok(ids.length > 0, 'clips.yml lists no clips');
  for (const id of ids) {
    assert.ok(CLIP_IDS.includes(id), `${id} is not a known clip id (scripts/docs-clips/clips.mjs)`);
    assert.ok(existsSync(join(JOURNEYS_DIR, `${id}.clip.ts`)), `no journey for ${id} at ${JOURNEYS_DIR}/${id}.clip.ts`);
  }
});

test('every clip has a title, caption and steps', () => {
  for (const id of ids) {
    const entry = manifest[id];
    assert.equal(typeof entry?.title, 'string', `${id}: title`);
    assert.equal(typeof entry?.caption, 'string', `${id}: caption`);
    assert.ok(Array.isArray(entry?.steps) && entry.steps.length > 0, `${id}: steps`);
    for (const step of entry.steps) assert.equal(typeof step, 'string', `${id}: every step is plain text`);
  }
});

test('every clip has its files, each within the size budget', () => {
  for (const id of ids) {
    const exts = ['mp4', 'webm', 'png', ...(GIF_IDS.includes(id) ? ['gif'] : [])];
    for (const ext of exts) {
      const file = join(CLIPS_DIR, `${id}.${ext}`);
      assert.ok(existsSync(file), `missing ${file}; run pnpm docs:clips ${id}`);
      const bytes = statSync(file).size;
      assert.ok(bytes > 1024, `${id}.${ext} is empty`);
      assert.ok(bytes <= budgetFor(id, ext), `${id}.${ext} is ${(bytes / 1048576).toFixed(2)} MB, over its ${(budgetFor(id, ext) / 1048576).toFixed(1)} MB budget`);
    }
  }
});
