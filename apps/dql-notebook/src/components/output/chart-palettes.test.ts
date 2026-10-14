import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DQL_SERIES_DARK, DQL_SERIES_LIGHT, getPalette, isDarkThemeMode } from './chart-palettes';

const TOKENS = readFileSync(
  fileURLToPath(new URL('../../../../../packages/dql-ui/src/styles/tokens.css', import.meta.url)),
  'utf8',
);

/** The `--chart-N` values declared inside one theme block, in order. */
function chartTokens(selector: string): string[] {
  const start = TOKENS.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = TOKENS.slice(start, TOKENS.indexOf('\n}', start));
  return [...body.matchAll(/--chart-(\d+):\s*(#[0-9a-f]{6});/gi)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => match[2].toLowerCase());
}

describe('chart palettes', () => {
  it('uses the DQL series by default, chosen by the theme', () => {
    expect(getPalette(undefined, 'paper')).toEqual([...DQL_SERIES_LIGHT]);
    expect(getPalette(undefined, 'white')).toEqual([...DQL_SERIES_LIGHT]);
    expect(getPalette(undefined, 'obsidian')).toEqual([...DQL_SERIES_DARK]);
    expect(getPalette('dql', 'dark')).toEqual([...DQL_SERIES_DARK]);
  });

  it('resolves the old implicit defaults to the DQL series and keeps named alternates', () => {
    expect(getPalette('default', 'paper')).toEqual([...DQL_SERIES_LIGHT]);
    expect(getPalette('corporate', 'paper')).toEqual([...DQL_SERIES_LIGHT]);
    expect(getPalette('warm', 'paper')[0]).toBe('#f85149');
    expect(getPalette('unknown-name', 'obsidian')).toEqual([...DQL_SERIES_DARK]);
  });

  it('has eight distinct colours in each theme', () => {
    for (const series of [DQL_SERIES_LIGHT, DQL_SERIES_DARK]) {
      expect(series).toHaveLength(8);
      expect(new Set(series).size).toBe(8);
    }
  });

  it('matches the --chart-N tokens each theme declares', () => {
    expect(chartTokens(':root {')).toEqual([...DQL_SERIES_DARK]);
    expect(chartTokens('[data-theme="paper"] {')).toEqual([...DQL_SERIES_LIGHT]);
    expect(chartTokens('[data-theme="white"] {')).toEqual([...DQL_SERIES_LIGHT]);
  });

  it('treats only the dark themes as dark', () => {
    expect(['obsidian', 'dark', 'midnight'].every((mode) => isDarkThemeMode(mode as never))).toBe(true);
    expect(['paper', 'white', 'light', 'arctic'].some((mode) => isDarkThemeMode(mode as never))).toBe(false);
  });
});

describe('palette choices', () => {
  it('shows DQL for unset and old default palettes', async () => {
    const { selectedPaletteOption, CHART_PALETTE_OPTIONS } = await import('./chart-palettes');
    expect(CHART_PALETTE_OPTIONS[0]).toEqual({ value: 'dql', label: 'ZLens' });
    expect(selectedPaletteOption(undefined)).toBe('dql');
    expect(selectedPaletteOption('corporate')).toBe('dql');
    expect(selectedPaletteOption('warm')).toBe('warm');
  });
});

describe('magnitude ramp', () => {
  it('runs light to dark on paper and dark to bright on obsidian, with readable text', async () => {
    const { sequentialStep } = await import('./chart-palettes');
    expect(sequentialStep(0, 'paper')).toEqual({ fill: '#e6f2f1', text: '#0b4f4c' });
    expect(sequentialStep(1, 'paper')).toEqual({ fill: '#0b4f4c', text: '#ffffff' });
    expect(sequentialStep(1, 'obsidian').fill).toBe('#6fd3c7');
    expect(sequentialStep(Number.NaN, 'paper').fill).toBe('#e6f2f1');
  });
});

describe('magnitude ramp contrast', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('keeps every cell label at 4.5:1 or better', async () => {
    const { SEQUENTIAL_LIGHT, SEQUENTIAL_DARK } = await import('./chart-palettes');
    for (const step of [...SEQUENTIAL_LIGHT, ...SEQUENTIAL_DARK]) {
      expect(ratio(step.fill, step.text), `${step.text} on ${step.fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
