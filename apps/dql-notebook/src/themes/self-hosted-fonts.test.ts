import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_LICENCE_FILE, fontLicence } from '@duckcodeailabs/dql-ui/font-licence';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const STYLES = join(REPO, 'packages/dql-ui/src/styles');

describe('fonts are served by DQL itself', () => {
  it('the app page links nothing on another host (no font service, no CDN)', () => {
    const html = readFileSync(join(REPO, 'apps/dql-notebook/index.html'), 'utf8');
    expect(html).not.toMatch(/(href|src)=["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('the shared styles load Inter from files in the package, with its licence beside them', () => {
    const globals = readFileSync(join(STYLES, 'globals.css'), 'utf8');
    expect(globals).toMatch(/@import "\.\/fonts\.css";/);
    const fonts = readFileSync(join(STYLES, 'fonts.css'), 'utf8');
    const sources = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^\.\/fonts\/[\w-]+\.woff2$/);
      const file = join(STYLES, source);
      expect(existsSync(file), source).toBe(true);
      // Subset to Latin: each file stays small.
      expect(statSync(file).size).toBeLessThan(80_000);
    }
    expect(readFileSync(join(STYLES, 'fonts/OFL.txt'), 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    for (const path of ['globals.css', 'tokens.css', 'panel.css', 'fonts.css']) {
      expect(readFileSync(join(STYLES, path), 'utf8'), path).not.toMatch(/@import\s+url\(|https?:\/\/fonts\./);
    }
  });

  it('the built app ships the fonts\' licence beside the font files', () => {
    const config = readFileSync(join(REPO, 'apps/dql-notebook/vite.config.ts'), 'utf8');
    expect(config).toMatch(/from '@duckcodeailabs\/dql-ui\/font-licence'/);
    expect(config).toMatch(/plugins:\s*\[[^\]]*\bfontLicence\(\)/);
    const emitted: Array<{ fileName: string; source: string }> = [];
    const plugin = fontLicence();
    expect(plugin.apply).toBe('build');
    plugin.generateBundle.call(
      { emitFile: (file) => { emitted.push(file); return file.fileName; } },
      {},
      {
        'assets/index-1a2b.js': { type: 'chunk', fileName: 'assets/index-1a2b.js' },
        'assets/inter-latin-BaGv997l.woff2': { type: 'asset', fileName: 'assets/inter-latin-BaGv997l.woff2' },
        'assets/inter-latin-ext-Clr4y9_u.woff2': { type: 'asset', fileName: 'assets/inter-latin-ext-Clr4y9_u.woff2' },
      },
    );
    expect(emitted.map((file) => file.fileName)).toEqual([`assets/${FONT_LICENCE_FILE}`]);
    expect(emitted[0]!.source).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(emitted[0]!.source).toBe(readFileSync(join(STYLES, 'fonts/OFL.txt'), 'utf8'));
  });

  it('every font stack ends in a system face, so text still reads if a file is missing', () => {
    const tokens = readFileSync(join(STYLES, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--font-ui:\s*"Inter",[^;]*sans-serif;/);
    expect(tokens).toMatch(/--font-mono:[^;]*monospace;/);
  });
});
