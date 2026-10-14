/**
 * Inter, the interface font, comes in two files split by `unicode-range` (fonts.css in dql-ui): Latin and Latin
 * Extended. A browser fetches a file only once a page shows one of its characters, so the Latin Extended file is
 * normally never fetched and stays "loading" for the life of the page.
 *
 * While an Inter file is still loading, Chromium lays out every new size or weight of Inter by first asking the
 * system for a stand-in font, a call the page waits on. On Linux that call runs on the same small pool of renderer
 * threads that compiles JavaScript in the background, so on a machine with few cores a view that loads several
 * large chunks of the app at once and shows text in a new size (Notebooks) can leave the page waiting for good:
 * the font request waits for a free thread and every thread waits on the page (seen in CI, 4 cores, Chromium 136).
 *
 * Loading both files as the app starts takes the stand-in out of layout: once a file is loaded, Chromium lays out
 * with it directly. The files are small (under 80 kB each) and served by ZLens itself.
 */

/** One character from each of Inter's files: "A" (Latin) and "Ā" U+0100 (Latin Extended). */
export const INTERFACE_FONT_SAMPLE = 'AĀ';

/** The font shorthand that matches Inter's files (one variable file per range covers weights 400-800). */
export const INTERFACE_FONT = '400 1em Inter';

/** How long the app waits for the files before it shows anyway, with the system face where Inter has not arrived. */
export const INTERFACE_FONT_WAIT_MS = 3_000;

/**
 * Load every Inter file. Resolves when they have loaded, when loading fails, or after `waitMs`, whichever comes
 * first: a missing font file never stops the app from showing.
 */
export function loadInterfaceFonts(
  fonts: Pick<FontFaceSet, 'load'> | undefined,
  waitMs: number = INTERFACE_FONT_WAIT_MS,
): Promise<void> {
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
  let loading: Promise<unknown>;
  try {
    loading = fonts.load(INTERFACE_FONT, INTERFACE_FONT_SAMPLE);
  } catch {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve(loading).then(done, done);
  });
}
