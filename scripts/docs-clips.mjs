#!/usr/bin/env node
// Record the docs feature clips: `pnpm docs:clips [id ...] [--record-ask] [--skip-build] [--encode-only]`.
//
//   1. runs the Playwright clip journeys (apps/dql-notebook/browser/clips/<id>.clip.ts)
//      against the Jaffle Shop sample served by the CLI built from this repo;
//   2. encodes each recording into docs/media/clips/<id>.{mp4,webm,png} (+ overview.gif);
//   3. checks every file against the size budget.
//
// Ask clips replay committed model responses (cassettes) by default, so a
// re-record needs no model. --record-ask records fresh responses with the
// locally configured subscription provider (ZLENS_CLIPS_PROVIDER, default
// claude-code: the `claude` CLI's own login). See docs/media/clips/README.md.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLIP_IDS, CLIPS_DIR, GIF_IDS, ROOT, budgetFor, targetFor } from './docs-clips/clips.mjs';
import { encodeClip, ffmpegBin } from './docs-clips/encode.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const known = new Set(['--record-ask', '--skip-build', '--encode-only', '--help']);
for (const flag of flags) {
  if (!known.has(flag)) {
    console.error(`Unknown flag ${flag}. Usage: pnpm docs:clips [id ...] [--record-ask] [--skip-build] [--encode-only]`);
    process.exit(2);
  }
}
if (flags.has('--help')) {
  console.log(`Usage: pnpm docs:clips [id ...] [--record-ask] [--skip-build] [--encode-only]\nClips: ${CLIP_IDS.join(', ')}`);
  process.exit(0);
}
const requested = args.filter((arg) => !arg.startsWith('--'));
const unknown = requested.filter((id) => !CLIP_IDS.includes(id));
if (unknown.length > 0) {
  console.error(`Unknown clip id(s): ${unknown.join(', ')}. Known: ${CLIP_IDS.join(', ')}`);
  process.exit(2);
}
const ids = requested.length > 0 ? requested : CLIP_IDS;
const workDir = process.env.ZLENS_CLIPS_WORK_DIR || join(ROOT, 'node_modules', '.cache', 'zlens-clips');

if (spawnSync(ffmpegBin(), ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg is required (with libx264 and libvpx-vp9). Install it, or set FFMPEG=/path/to/ffmpeg.');
  process.exit(1);
}

if (!flags.has('--encode-only')) {
  const result = spawnSync('pnpm', [
    '--filter', '@zlens/notebook-app', 'exec', 'playwright', 'test',
    '--config', 'playwright.clips.config.ts',
    ...ids.map((id) => `browser/clips/${id}.clip.ts`),
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZLENS_CLIPS_WORK_DIR: workDir,
      ZLENS_CLIPS_ASK_MODE: flags.has('--record-ask') ? 'record' : 'replay',
      ...(flags.has('--skip-build') ? { E2E_SKIP_BUILD: '1' } : {}),
    },
  });
  if (result.status !== 0) {
    console.error('\nA clip journey failed; nothing was encoded for the failing clip. Fix it and re-run `pnpm docs:clips <id>`.');
  }
}

const rows = [];
let failed = false;
for (const id of ids) {
  const rawDir = join(workDir, 'raw', id);
  if (!existsSync(join(rawDir, 'timeline.json'))) {
    console.error(`✗ ${id}: no recording at ${rawDir}`);
    failed = true;
    continue;
  }
  const gif = GIF_IDS.includes(id);
  const targets = {
    mp4: targetFor(id, 'mp4'),
    webm: targetFor(id, 'webm'),
    png: targetFor(id, 'png'),
    gif: targetFor(id, 'gif'),
  };
  const result = encodeClip({ id, rawDir, outDir: CLIPS_DIR, gif, targets });
  rows.push(result);
  for (const ext of ['mp4', 'webm', 'png', ...(gif ? ['gif'] : [])]) {
    if (result[ext].bytes > budgetFor(id, ext)) {
      console.error(`✗ ${id}.${ext} is ${(result[ext].bytes / 1048576).toFixed(2)} MB, over its budget`);
      failed = true;
    }
  }
}

const mb = (bytes) => (bytes / 1048576).toFixed(2);
console.log('\nid               seconds   mp4 MB   webm MB   png MB   gif MB');
for (const row of rows) {
  console.log(`${row.id.padEnd(16)} ${String(row.seconds).padStart(7)} ${mb(row.mp4.bytes).padStart(8)} ${mb(row.webm.bytes).padStart(9)} ${mb(row.png.bytes).padStart(8)} ${row.gif ? mb(row.gif.bytes).padStart(8) : '       -'}`);
}
console.log(`\nWrote ${rows.length} clip(s) to ${CLIPS_DIR}`);
process.exit(failed ? 1 : 0);
