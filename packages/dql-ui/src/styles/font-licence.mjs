// The licence of the fonts DQL serves itself (Inter, SIL Open Font License 1.1), shipped with them: a Vite plugin
// that writes fonts/OFL.txt beside the font files a build copies (as `Inter-OFL.txt` in the same folder). Any app
// that loads `@duckcodeailabs/dql-ui/styles` or `/styles/fonts` adds it to its Vite plugins.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_LICENCE_FILE = 'Inter-OFL.txt';

export function fontLicenceText() {
  return readFileSync(fileURLToPath(new URL('./fonts/OFL.txt', import.meta.url)), 'utf8');
}

/** @returns {{ name: string, apply: 'build', generateBundle(this: { emitFile(file: { type: 'asset', fileName: string, source: string }): string }, options: unknown, bundle: Record<string, { type: string, fileName: string }>): void }} */
export function fontLicence() {
  const text = fontLicenceText();
  return {
    name: 'dql-font-licence',
    apply: 'build',
    generateBundle(_options, bundle) {
      const folders = new Set(
        Object.values(bundle)
          .filter((file) => file.type === 'asset' && /(^|\/)inter-latin[\w-]*\.woff2$/.test(file.fileName))
          .map((file) => posix.dirname(file.fileName)),
      );
      for (const folder of folders) {
        this.emitFile({ type: 'asset', fileName: folder === '.' ? FONT_LICENCE_FILE : `${folder}/${FONT_LICENCE_FILE}`, source: text });
      }
    },
  };
}
