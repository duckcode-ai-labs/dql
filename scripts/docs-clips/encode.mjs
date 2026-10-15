// Encode one recorded clip (timeline.json + JPEG frames written by
// apps/dql-notebook/browser/clips/support/recorder.ts) into the docs formats:
// MP4 (H.264, yuv420p, faststart), WebM (VP9), a PNG poster and, when asked,
// an optimized GIF. Waits marked as cuts are compressed to a short beat, the
// last frame is held briefly so the loop does not jump, and each file is
// re-encoded at a lower quality until it fits its size target.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CUT_KEEP = 0.45; // seconds a compressed wait still lasts
const END_HOLD = 1.2; // seconds the last frame is held
const FPS = 30;

export function ffmpegBin() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ffmpeg';
}

function ffmpeg(args) {
  const result = spawnSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${result.stderr}`);
}

function mergeCuts(cuts, start, end) {
  const sorted = cuts
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b - a > CUT_KEEP)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]);
    else merged.push([...cut]);
  }
  return merged;
}

/** Map a recording time to a clip time, compressing each cut to CUT_KEEP seconds. */
export function makeClock(timeline) {
  const cuts = mergeCuts(timeline.cuts ?? [], timeline.start, timeline.end);
  return (t) => {
    let v = Math.max(0, t - timeline.start);
    for (const [a, b] of cuts) {
      if (t <= a) break;
      const len = b - a;
      const inside = Math.min(t, b) - a;
      v -= inside - inside * (CUT_KEEP / len);
    }
    return v;
  };
}

/** Write an ffmpeg concat list giving each frame its on-screen duration. Returns the clip length. */
function writeConcatList(rawDir, timeline, listPath) {
  const clock = makeClock(timeline);
  const frames = timeline.frames.filter((frame) => frame.ts <= timeline.end);
  if (frames.length === 0) throw new Error(`No frames recorded in ${rawDir}`);
  const lines = ['ffconcat version 1.0'];
  let total = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const from = clock(Math.max(frames[i].ts, timeline.start));
    const to = i + 1 < frames.length ? clock(frames[i + 1].ts) : clock(timeline.end) + END_HOLD;
    const duration = to - from;
    if (duration <= 0.0005) continue;
    lines.push(`file '${join(rawDir, frames[i].file)}'`, `duration ${duration.toFixed(4)}`);
    total += duration;
  }
  // The concat demuxer ignores the last entry's duration unless the file repeats.
  lines.push(`file '${join(rawDir, frames[frames.length - 1].file)}'`);
  writeFileSync(listPath, `${lines.join('\n')}\n`);
  return total;
}

function sizeOf(path) {
  return statSync(path).size;
}

/** Encode with decreasing quality until the file fits `target` bytes. */
function fitTo(target, qualities, encode) {
  let size = 0;
  for (const quality of qualities) {
    encode(quality);
    size = encode.size();
    if (size <= target) return { quality, size };
  }
  return { quality: qualities[qualities.length - 1], size };
}

export function encodeClip({ id, rawDir, outDir, gif = false, targets }) {
  const timeline = JSON.parse(readFileSync(join(rawDir, 'timeline.json'), 'utf8'));
  const tmp = join(rawDir, 'encode');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const list = join(tmp, 'frames.ffconcat');
  const seconds = writeConcatList(rawDir, timeline, list);
  const input = ['-f', 'concat', '-safe', '0', '-i', list];
  const frameFilter = `fps=${FPS},scale=1440:900:flags=lanczos,format=yuv420p`;

  const mp4 = join(outDir, `${id}.mp4`);
  const mp4Encode = (crf) => ffmpeg([...input, '-vf', frameFilter, '-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage',
    '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  mp4Encode.size = () => sizeOf(mp4);
  const mp4Fit = fitTo(targets.mp4, [23, 26, 29, 32, 35, 38], mp4Encode);

  const webm = join(outDir, `${id}.webm`);
  const webmEncode = (crf) => ffmpeg([...input, '-vf', frameFilter, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf),
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', webm]);
  webmEncode.size = () => sizeOf(webm);
  const webmFit = fitTo(targets.webm, [33, 37, 41, 45, 49, 53], webmEncode);

  // Poster: the marked moment (or the last frame), from the sharp source frame.
  const posterAt = timeline.poster ?? timeline.end;
  const posterFrame = [...timeline.frames].reverse().find((frame) => frame.ts <= posterAt) ?? timeline.frames[timeline.frames.length - 1];
  const png = join(outDir, `${id}.png`);
  ffmpeg(['-i', join(rawDir, posterFrame.file), '-frames:v', '1', '-compression_level', '9', png]);
  if (sizeOf(png) > targets.png) {
    const quantized = join(tmp, 'poster.png');
    ffmpeg(['-i', join(rawDir, posterFrame.file), '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none',
      '-frames:v', '1', '-compression_level', '9', quantized]);
    renameSync(quantized, png);
  }

  const result = {
    id,
    seconds: Math.round(seconds * 10) / 10,
    mp4: { bytes: mp4Fit.size, crf: mp4Fit.quality },
    webm: { bytes: webmFit.size, crf: webmFit.quality },
    png: { bytes: sizeOf(png) },
  };

  if (gif) {
    const gifPath = join(outDir, `${id}.gif`);
    const variants = [
      { width: 960, fps: 8, colors: 128 },
      { width: 880, fps: 7, colors: 96 },
      { width: 800, fps: 6, colors: 64 },
      { width: 720, fps: 5, colors: 48 },
    ];
    const gifEncode = (v) => ffmpeg([...input, '-vf',
      `fps=${v.fps},scale=${v.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${v.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop', '0', gifPath]);
    gifEncode.size = () => sizeOf(gifPath);
    const gifFit = fitTo(targets.gif, variants, gifEncode);
    result.gif = { bytes: gifFit.size, ...gifFit.quality };
  }
  rmSync(tmp, { recursive: true, force: true });
  return result;
}
