import type { ThemeMode } from '../../themes/notebook-theme';

/**
 * DQL series colours, in assignment order. Both lists were checked with the
 * dataviz palette validator (lightness band, chroma floor, colour-blind
 * separation of neighbours, normal-vision floor) against their own surface:
 * light against paper/white cards, dark against the obsidian card #161a23.
 * They mirror `--chart-1..8` in packages/dql-ui/src/styles/tokens.css.
 * Amber and sky sit below 3:1 on white, so charts that use them keep
 * direct labels or a table view.
 */
export const DQL_SERIES_LIGHT = [
  '#00897b', // teal
  '#3659c9', // ink blue
  '#e08a1a', // amber
  '#a24c9c', // plum
  '#879a22', // olive
  '#35a3c9', // sky
  '#c95563', // rose
  '#5b4fd1', // violet
] as const;

export const DQL_SERIES_DARK = [
  '#1fa396',
  '#5577f0',
  '#cc7d18',
  '#b060aa',
  '#84972a',
  '#2e9cc4',
  '#d9636f',
  '#7a6ee6',
] as const;

export type ChartPaletteName = 'dql' | 'default' | 'warm' | 'cool' | 'mono' | 'pastel' | 'corporate';

/**
 * Older named palettes stay selectable so saved chart settings keep their
 * look. `default` and `corporate` were the implicit defaults before the DQL
 * series existed, so they now resolve to it.
 */
const NAMED_PALETTES: Record<'warm' | 'cool' | 'mono' | 'pastel', readonly string[]> = {
  warm: [
    '#f85149', '#f78166', '#ffa657', '#e3b341', '#d29922',
    '#db6d28', '#ff7b72', '#ffa198', '#ffdfb6', '#e6c174',
    '#c4a35a', '#b08c3e',
  ],
  cool: [
    '#388bfd', '#58a6ff', '#79c0ff', '#39c5cf', '#56d364',
    '#3fb950', '#a371f7', '#d2a8ff', '#bc8cff', '#6cb6ff',
    '#2ea043', '#1f6feb',
  ],
  mono: [
    '#c9d1d9', '#b1bac4', '#8b949e', '#6e7681', '#484f58',
    '#30363d', '#21262d', '#161b22', '#a0a8b2', '#9e9e9e',
    '#757575', '#616161',
  ],
  pastel: [
    '#b8d8f8', '#b4e6c8', '#f4e6a0', '#f8c4a4', '#d2b8f0',
    '#a8e0e0', '#f8d8a0', '#f4b8b4', '#c0e8c0', '#e0d0f8',
    '#a8d8f8', '#b0e8b0',
  ],
};

const DARK_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>(['obsidian', 'dark', 'midnight']);

export function isDarkThemeMode(themeMode: ThemeMode | undefined): boolean {
  return themeMode !== undefined && DARK_MODES.has(themeMode);
}

/** Series colours for a chart: the DQL series unless a named palette was chosen. */
export function getPalette(name: string | undefined, themeMode: ThemeMode | undefined): string[] {
  if (name && name in NAMED_PALETTES) return [...NAMED_PALETTES[name as keyof typeof NAMED_PALETTES]];
  return [...(isDarkThemeMode(themeMode) ? DQL_SERIES_DARK : DQL_SERIES_LIGHT)];
}

/** Choices offered in chart settings; the old implicit defaults show as ZLens (value stays 'dql'). */
export const CHART_PALETTE_OPTIONS: ReadonlyArray<{ value: ChartPaletteName; label: string }> = [
  { value: 'dql', label: 'ZLens' },
  { value: 'warm', label: 'Warm' },
  { value: 'cool', label: 'Cool' },
  { value: 'mono', label: 'Mono' },
  { value: 'pastel', label: 'Pastel' },
];

export function selectedPaletteOption(name: string | undefined): ChartPaletteName {
  return name && name in NAMED_PALETTES ? (name as ChartPaletteName) : 'dql';
}

/**
 * Magnitude ramps: one hue, low to high. On dark surfaces "more" is brighter.
 * Each step carries the text colour that stays readable on it.
 */
export const SEQUENTIAL_LIGHT: ReadonlyArray<{ fill: string; text: string }> = [
  { fill: '#e6f2f1', text: '#0b4f4c' },
  { fill: '#bfe0dc', text: '#0b4f4c' },
  { fill: '#8fcac3', text: '#0b3a38' },
  { fill: '#5aafa6', text: '#0b2e2c' },
  { fill: '#2a9187', text: '#0b0d12' },
  { fill: '#0b7a75', text: '#ffffff' },
  { fill: '#0b4f4c', text: '#ffffff' },
];

export const SEQUENTIAL_DARK: ReadonlyArray<{ fill: string; text: string }> = [
  { fill: '#16302f', text: '#cfe7e4' },
  { fill: '#1d4744', text: '#e6f2f1' },
  { fill: '#236059', text: '#ffffff' },
  { fill: '#2a7a70', text: '#ffffff' },
  { fill: '#309489', text: '#0b0d12' },
  { fill: '#44b3a7', text: '#0b0d12' },
  { fill: '#6fd3c7', text: '#0b0d12' },
];

/** The ramp step for a value's position between the smallest and largest value (0–1). */
export function sequentialStep(position: number, themeMode: ThemeMode | undefined): { fill: string; text: string } {
  const ramp = isDarkThemeMode(themeMode) ? SEQUENTIAL_DARK : SEQUENTIAL_LIGHT;
  const clamped = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;
  return ramp[Math.min(ramp.length - 1, Math.floor(clamped * ramp.length))];
}
