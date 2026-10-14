import React from 'react';
import { themes, type Theme } from '../../themes/notebook-theme';
import type { Cell, ThemeMode } from '../../store/types';
import { CellChrome } from '@zlens/ui';

interface PlaceholderCellProps {
  cell: Cell;
  themeMode: ThemeMode;
  title: string;
  subtitle: string;
  color: string;
  badge?: string;
}

/**
 * Shared scaffold for cell types whose full renderer is not yet implemented.
 * Renders a typed, themed card so the palette is immediately usable; the
 * dedicated renderer replaces this in follow-up tracks (C for chart builder,
 * D for transform cells, etc.).
 */
export function PlaceholderCell({ cell, themeMode, title, subtitle, color, badge }: PlaceholderCellProps) {
  const t: Theme = themes[themeMode];
  return (
    <CellChrome
      typeLabel={title}
      typeColor={color}
      idleBorder={t.cellBorder}
      background={t.cellBg}
      headerBackground={`${t.tableHeaderBg}80`}
      title={
        cell.name ? (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>{cell.name}</span>
        ) : undefined
      }
      actions={
        badge ? (
          <span
            style={{
              fontSize: 9,
              fontFamily: t.fontMono,
              fontWeight: 600,
              letterSpacing: '0.1em',
              color: t.textMuted,
              textTransform: 'uppercase',
              padding: '2px 6px',
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 3,
            }}
          >
            {badge}
          </span>
        ) : undefined
      }
    >
      <div style={{ padding: '12px 14px', fontSize: 12, color: t.textSecondary, lineHeight: 1.5, fontFamily: t.font }}>
        {subtitle}
      </div>
    </CellChrome>
  );
}
