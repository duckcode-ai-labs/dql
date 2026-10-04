import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DriverLogo } from './DriverLogo';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

describe('connection driver marks', () => {
  it('are drawn by the app itself: no image, no address, decorative beside the driver name', () => {
    for (const driver of ['duckdb', 'file', 'snowflake', 'databricks', 'sqlite', 'bigquery', 'postgresql', 'redshift', 'mysql', 'mssql', 'fabric', 'trino', 'clickhouse', 'athena', 'unknown-driver']) {
      const html = renderToStaticMarkup(<DriverLogo driver={driver} size={18} />);
      // (The SVG's own namespace is a name, not an address anything fetches.)
      expect(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ''), driver).not.toMatch(/<img|src=|url\(|https?:/i);
      expect(html, driver).toMatch(/aria-hidden="true"/);
      expect(html, driver).toMatch(/<svg|<span/);
    }
  });

  it('nothing in the app loads an image from another site (a logo service learns who opened DQL)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(tsx?|css)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const text = readFileSync(path, 'utf8');
        if (/cdn\.simpleicons\.org|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(text)) offenders.push(path.slice(SRC.length));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
