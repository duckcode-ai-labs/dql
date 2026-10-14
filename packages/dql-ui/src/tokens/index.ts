/**
 * Design tokens — the single source of visual truth for the ZLens UI.
 *
 * Philosophy
 * - Tokens are abstract (role-based: `surface-raised`, not `gray-700`). A
 *   component asks for `surface-raised` and gets whatever the active theme
 *   decides it should be. This is what lets a theme pass change a color
 *   once and have it propagate everywhere.
 * - Dark first. Light is a mirror, not an afterthought.
 * - Emitted as CSS custom properties by ThemeProvider so DOM nodes inherit
 *   them without React re-rendering on theme change.
 *
 * Scales
 * - `space`:    4-pt grid (0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64)
 * - `radius`:   sharp → pill (0, 2, 4, 6, 8, 12, 999)
 * - `fontSize`: 11–24 px modular scale
 * - `shadow`:   3 elevation stops; dark theme uses deeper alpha, light uses softer
 * - `z`:        named layers so stacking doesn't turn into a lottery
 */

// --- primitives (do not consume these directly in components) ---
export const palette = {
  // neutrals — used as backgrounds and borders per theme
  gray0: '#ffffff',
  gray50: '#f6f8fa',
  gray100: '#eaeef2',
  gray200: '#d0d7de',
  gray300: '#afb8c1',
  gray400: '#8c959f',
  gray500: '#6e7781',
  gray600: '#57606a',
  gray700: '#424a53',
  gray800: '#32383f',
  gray900: '#24292f',
  gray950: '#1c2128',
  gray975: '#161b22',
  gray1000: '#0d1117',

  // accents — primary brand blue
  blue300: '#79c0ff',
  blue400: '#58a6ff',
  blue500: '#388bfd',
  blue600: '#0969da',
  blue700: '#0550ae',

  // semantic
  green500: '#56d364',
  green600: '#1f883d',
  red500: '#f85149',
  red600: '#cf222e',
  yellow500: '#e3b341',
  yellow600: '#9a6700',
} as const;

// --- scales (theme-independent) ---
export const space = {
  0: '0',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  7: '32px',
  8: '40px',
  9: '48px',
  10: '64px',
} as const;

export const radius = {
  none: '0',
  xs: '2px',
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  pill: '999px',
} as const;

export const fontSize = {
  xs: '11px',
  sm: '12px',
  base: '13px',
  md: '14px',
  lg: '16px',
  xl: '18px',
  '2xl': '20px',
  '3xl': '24px',
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeight = {
  tight: '1.2',
  snug: '1.35',
  normal: '1.5',
  relaxed: '1.65',
} as const;

export const font = {
  sans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  serif: "Georgia, 'Times New Roman', serif",
} as const;

export const z = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  overlay: 1000,
  modal: 1100,
  popover: 1200,
  tooltip: 1300,
  toast: 1400,
} as const;

// --- themes: role tokens that reference primitives ---
export interface ThemeTokens {
  // surfaces
  surfaceBase: string;       // app chrome background
  surfaceRaised: string;     // panels, sidebars
  surfaceElevated: string;   // popovers, menus
  surfaceOverlay: string;    // modal backdrop
  surfaceHover: string;
  surfaceActive: string;
  surfaceSunken: string;     // editor pits, input wells

  // borders
  borderSubtle: string;
  borderDefault: string;
  borderStrong: string;
  borderFocus: string;

  // text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDisabled: string;
  textInverse: string;

  // accent (primary action, focus, selection)
  accent: string;
  accentHover: string;
  accentMuted: string;
  accentContrast: string;    // text on an accent surface

  // semantic
  success: string;
  warning: string;
  danger: string;
  info: string;

  // shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

export const darkTokens: ThemeTokens = {
  surfaceBase: palette.gray1000,
  surfaceRaised: palette.gray975,
  surfaceElevated: palette.gray950,
  surfaceOverlay: 'rgba(0,0,0,0.7)',
  surfaceHover: palette.gray900,
  surfaceActive: '#1f2d3d',
  surfaceSunken: palette.gray1000,

  borderSubtle: '#21262d',
  borderDefault: '#30363d',
  borderStrong: '#484f58',
  borderFocus: palette.blue500,

  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  textDisabled: '#32383f',
  textInverse: palette.gray1000,

  accent: palette.blue500,
  accentHover: palette.blue400,
  accentMuted: 'rgba(56,139,253,0.15)',
  accentContrast: '#ffffff',

  success: palette.green500,
  warning: palette.yellow500,
  danger: palette.red500,
  info: palette.blue400,

  shadowSm: '0 1px 2px rgba(0,0,0,0.4)',
  shadowMd: '0 4px 10px rgba(0,0,0,0.45)',
  shadowLg: '0 12px 28px rgba(0,0,0,0.55)',
};

export const lightTokens: ThemeTokens = {
  surfaceBase: palette.gray0,
  surfaceRaised: palette.gray50,
  surfaceElevated: palette.gray0,
  surfaceOverlay: 'rgba(0,0,0,0.4)',
  surfaceHover: palette.gray100,
  surfaceActive: '#dbeafe',
  surfaceSunken: palette.gray50,

  borderSubtle: palette.gray100,
  borderDefault: palette.gray200,
  borderStrong: palette.gray300,
  borderFocus: palette.blue600,

  textPrimary: '#1f2328',
  textSecondary: palette.gray600,
  textMuted: palette.gray400,
  textDisabled: palette.gray300,
  textInverse: palette.gray0,

  accent: palette.blue600,
  accentHover: palette.blue700,
  accentMuted: 'rgba(9,105,218,0.12)',
  accentContrast: '#ffffff',

  success: palette.green600,
  warning: palette.yellow600,
  danger: palette.red600,
  info: palette.blue600,

  shadowSm: '0 1px 2px rgba(31,35,40,0.08)',
  shadowMd: '0 4px 10px rgba(31,35,40,0.1)',
  shadowLg: '0 12px 28px rgba(31,35,40,0.15)',
};

// v1.3.2 — three Luna themes (obsidian dark, paper warm light, white plain
// light). Tokens here drive the JS/TS Proxy shim only; actual colors are
// sourced from tokens.css via `[data-theme="..."]`. Legacy aliases
// (midnight/arctic/dark/light) remain so persisted state from v1.2 and
// early v1.3 releases still resolves.
export const themes = {
  obsidian: darkTokens,
  paper: lightTokens,
  white: lightTokens,
  dark: darkTokens,
  light: lightTokens,
  midnight: darkTokens,
  arctic: lightTokens,
} as const;
export type ThemeName = keyof typeof themes;

/** camelCase token key → CSS custom property name (`--dql-surface-base`) */
export function tokenToCssVar(key: string): string {
  return `--dql-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Emit a { [cssVar]: value } map for a given theme. Used by ThemeProvider. */
export function themeToCssVars(theme: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    out[tokenToCssVar(key)] = value;
  }
  return out;
}

/** `cssVar('surfaceBase')` → `'var(--dql-surface-base)'` — use in style props */
export function cssVar(key: keyof ThemeTokens): string {
  return `var(${tokenToCssVar(key as string)})`;
}
