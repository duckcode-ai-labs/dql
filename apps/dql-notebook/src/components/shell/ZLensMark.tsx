import React from 'react';

/**
 * The ZLens symbol ("Signal" cut B, icon cut): a square-cut Z whose shortened
 * bottom bar ends in the green certified dot. Geometry and colours come from the
 * ZLens brand kit (`svg/zlens-symbol-icon*.svg`); the dot is the only curve and
 * the only green in the mark.
 *
 * `decorative` hides the mark from assistive technology when a visible product
 * name sits next to it, so a screen reader does not hear the name twice.
 */
export function ZLensMark({
  size = 28,
  tone = 'auto',
  decorative = false,
  title = 'ZLens',
}: {
  size?: number;
  /** `light` = ink mark for light surfaces, `dark` = paper mark for dark ones, `auto` follows the theme text colour. */
  tone?: 'auto' | 'light' | 'dark';
  decorative?: boolean;
  title?: string;
}) {
  const ink = tone === 'light' ? '#0F1216' : tone === 'dark' ? '#EEF0EA' : 'currentColor';
  const dot = tone === 'dark' ? '#2FD8A0' : '#0E9F74';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ display: 'block', flexShrink: 0 }}
      {...(decorative ? { 'aria-hidden': true, focusable: false } : { role: 'img', 'aria-label': title })}
      data-testid="zlens-mark"
    >
      <path d="M11 12H51V20L24 44H37V52H11V44L38 20H11Z" fill={ink} />
      <circle cx="47.9" cy="48" r="6.4" fill={dot} />
    </svg>
  );
}

/** Inline SVG markup of the mark for static HTML exports (no React at runtime). */
export const ZLENS_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="28" height="28" role="img" aria-label="ZLens">'
  + '<path d="M11 12H51V20L24 44H37V52H11V44L38 20H11Z" fill="#EEF0EA"/><circle cx="47.9" cy="48" r="6.4" fill="#2FD8A0"/></svg>';
