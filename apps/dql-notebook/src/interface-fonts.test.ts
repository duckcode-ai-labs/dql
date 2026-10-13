import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERFACE_FONT, INTERFACE_FONT_SAMPLE, INTERFACE_FONT_WAIT_MS, loadInterfaceFonts } from './interface-fonts';

const FONTS_CSS = fileURLToPath(new URL('../../../packages/dql-ui/src/styles/fonts.css', import.meta.url));

/** Every @font-face in the shared styles, with the code points its unicode-range covers. */
function fontFaces(): Array<{ family: string; weight: string; ranges: Array<[number, number]> }> {
  const css = readFileSync(FONTS_CSS, 'utf8');
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
    const family = /font-family:\s*"?([^";]+)"?;/.exec(body)?.[1] ?? '';
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1] ?? '';
    const ranges = (/unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? 'U+0-10FFFF')
      .split(',')
      .map((part) => part.trim().replace(/^U\+/i, ''))
      .map((part) => {
        const [from, to = from] = part.split('-');
        return [parseInt(from, 16), parseInt(to, 16)] as [number, number];
      });
    return { family, weight, ranges };
  });
}

describe('the interface font loads all its files as the app starts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a character from every Inter file, so no file stays "loading" while the app lays out text', () => {
    const faces = fontFaces().filter((face) => face.family === 'Inter');
    expect(faces.length, 'fonts.css declares Inter').toBeGreaterThan(1);
    expect(INTERFACE_FONT).toMatch(/\bInter$/);
    const weight = Number(/^(\d+)/.exec(INTERFACE_FONT)?.[1]);
    const sample = [...INTERFACE_FONT_SAMPLE].map((char) => char.codePointAt(0)!);
    for (const face of faces) {
      const [low, high = low] = face.weight.split(/\s+/).map(Number);
      expect(weight >= low && weight <= high, `weight ${weight} is in ${face.weight}`).toBe(true);
      const covered = sample.some((point) => face.ranges.some(([from, to]) => point >= from && point <= to));
      expect(covered, `the sample has a character in ${face.ranges.map(([from, to]) => `${from.toString(16)}-${to.toString(16)}`).join(',')}`).toBe(true);
    }
  });

  it('loads the files through the page\'s font set and resolves once they have loaded', async () => {
    let finish: () => void = () => undefined;
    const load = vi.fn(() => new Promise<FontFace[]>((resolve) => { finish = () => resolve([]); }));
    let settled = false;
    const loading = loadInterfaceFonts({ load }).then(() => { settled = true; });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(INTERFACE_FONT, INTERFACE_FONT_SAMPLE);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await loading;
    expect(settled).toBe(true);
  });

  it('never holds the app back: a failed load, a missing font set, or a slow file all resolve', async () => {
    await expect(loadInterfaceFonts({ load: () => Promise.reject(new Error('404')) })).resolves.toBeUndefined();
    await expect(loadInterfaceFonts({ load: () => { throw new SyntaxError('bad font'); } })).resolves.toBeUndefined();
    await expect(loadInterfaceFonts(undefined)).resolves.toBeUndefined();

    vi.useFakeTimers();
    let settled = false;
    const loading = loadInterfaceFonts({ load: () => new Promise<FontFace[]>(() => undefined) }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(INTERFACE_FONT_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await loading;
    expect(settled).toBe(true);
  });
});
