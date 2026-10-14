import { useMemo, type MouseEvent } from 'react';
import { buildPivotGrid, type PivotGrid, type PivotHeader, type PivotLayout, type PivotRow } from '@zlens/core/apps/pivot';
import { conditionalCell, conditionalStats, CONDITIONAL_TONE_LABELS, type DashboardConditionalFormat } from '@zlens/core/apps/conditional-format';
import { escapeHtml } from '@zlens/core/apps/canvas-page';
import type { QueryResult } from '../../store/types';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import { formatDisplayValue } from '../../utils/value-format';
import { ConditionalToneIcon } from '../output/TableOutput';

type Meta = NonNullable<QueryResult['columnsMeta']>[number];

/** The name a reader sees for a result column. */
function columnLabel(result: QueryResult, column: string): string {
  const meta = result.columnsMeta?.find((entry) => entry.name === column);
  return meta?.label ?? column.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function display(result: QueryResult, column: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  const meta = result.columnsMeta?.find((entry) => entry.name === column) as Meta | undefined;
  return formatDisplayValue(column, value, [], { meta });
}

/** Each measure's scale or bar is drawn against the grid's own cells, never its totals. */
function cellStats(grid: PivotGrid, formats: DashboardConditionalFormat[]) {
  return new Map(formats.map((format) => {
    const values: unknown[] = [];
    for (const row of grid.rows) if (row.kind === 'cell') for (const column of grid.columns) if (!column.total) values.push(grid.value(row, column, format.column));
    return [format.column, { format, stats: conditionalStats(values) }];
  }));
}

/** Header rows for the column dimensions: one row per level, spans for repeated outer values. */
function headerSpans(columns: PivotHeader[], level: number): Array<{ value: unknown; span: number; total: boolean }> {
  const spans: Array<{ value: unknown; span: number; total: boolean; key: string }> = [];
  for (const column of columns) {
    const key = column.total ? 'total' : JSON.stringify(column.values.slice(0, level + 1));
    const last = spans[spans.length - 1];
    if (last && last.key === key) last.span += 1;
    else spans.push({ key, value: column.total ? undefined : column.values[level], span: 1, total: column.total });
  }
  return spans;
}

/**
 * A pivot tile (RFC 0009 step 4): row dimensions down the side, column
 * dimensions across the top, measures in the cells. Subtotals and totals are
 * the warehouse's own recomputed values from the tile's total levels.
 */
export function PivotTable({
  result,
  layout,
  themeMode,
  conditionalFormats,
  onCellClick,
  maxHeight = 440,
}: {
  result: QueryResult;
  layout: PivotLayout;
  themeMode: ThemeMode;
  conditionalFormats?: DashboardConditionalFormat[];
  /** A cell (not a total) was clicked: its row, column and measure values as one result row. */
  onCellClick?: (row: Record<string, unknown>, pointer: { x: number; y: number }) => void;
  maxHeight?: number;
}): JSX.Element {
  const t = themes[themeMode];
  const grid = useMemo(() => buildPivotGrid(result, layout), [result, layout]);
  const formats = useMemo(() => cellStats(grid, (conditionalFormats ?? []).filter((format) => layout.values.includes(format.column))), [grid, conditionalFormats, layout.values]);
  const values = layout.values;
  const levels = layout.columns.length;
  const measureRow = values.length > 1 || levels === 0;
  const headerRows = Math.max(1, levels + (measureRow ? 1 : 0));
  const border = `1px solid ${t.tableBorder}`;
  const th = { background: t.tableHeaderBg, color: t.textSecondary, fontWeight: 600, fontSize: 11, padding: '6px 10px', borderBottom: border, whiteSpace: 'nowrap' as const, position: 'sticky' as const, fontFamily: t.font, zIndex: 1 };
  const rowHeaderCells = (row: PivotRow, previous: PivotRow | undefined) => {
    if (row.kind === 'total') return [<th key="total" scope="row" colSpan={Math.max(1, layout.rows.length)} style={{ ...th, position: 'static', textAlign: 'left', color: t.textPrimary }}>Total</th>];
    return layout.rows.map((alias, index) => {
      if (row.kind === 'subtotal' && index === row.depth) return <th key={alias} scope="row" colSpan={layout.rows.length - index} style={{ ...th, position: 'static', textAlign: 'left', color: t.textPrimary, background: 'transparent' }}>{`${display(result, layout.rows[index - 1] ?? alias, row.values[index - 1])} total`}</th>;
      if (row.kind === 'subtotal' && index > row.depth) return null;
      // An outer value repeats down its group; it is shown once, where the group starts.
      const repeated = previous && previous.kind === 'cell' && row.kind === 'cell' && row.values.slice(0, index + 1).every((value, at) => value === previous.values[at]);
      return <th key={alias} scope="row" style={{ ...th, position: 'static', textAlign: 'left', fontWeight: index === layout.rows.length - 1 ? 400 : 600, color: repeated ? 'transparent' : t.textPrimary, background: 'transparent', borderBottom: border }}>{display(result, alias, row.values[index])}</th>;
    });
  };
  const click = (row: PivotRow, column: PivotHeader, event: MouseEvent) => {
    if (!onCellClick || row.kind !== 'cell' || column.total) return;
    const record: Record<string, unknown> = {};
    layout.rows.forEach((alias, index) => { record[alias] = row.values[index]; });
    layout.columns.forEach((alias, index) => { record[alias] = column.values[index]; });
    for (const measure of values) record[measure] = grid.value(row, column, measure);
    onCellClick(record, { x: event.clientX, y: event.clientY });
  };

  if (!values.length) return <p style={{ color: t.textMuted, fontSize: 12, fontFamily: t.font, padding: 8 }}>Put a measure on the shelves to fill the pivot.</p>;
  return (
    <div className="dql-pivot" style={{ maxHeight, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5, fontFamily: t.font, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {Array.from({ length: headerRows }, (_, headerIndex) => {
            const top = headerIndex * 31;
            const isMeasureRow = measureRow && headerIndex === headerRows - 1;
            return (
              <tr key={headerIndex}>
                {headerIndex === 0 ? layout.rows.map((alias) => <th key={alias} scope="col" rowSpan={headerRows} style={{ ...th, top: 0, textAlign: 'left', verticalAlign: 'bottom' }}>{columnLabel(result, alias)}</th>) : null}
                {headerIndex === 0 && !layout.rows.length ? <th rowSpan={headerRows} style={{ ...th, top: 0 }} aria-hidden="true" /> : null}
                {isMeasureRow
                  ? grid.columns.flatMap((column, columnIndex) => values.map((measure) => (
                    <th key={`${columnIndex}-${measure}`} scope="col" style={{ ...th, top, textAlign: 'right' }}>{columnLabel(result, measure)}</th>
                  )))
                  : headerSpans(grid.columns, headerIndex).map((span, spanIndex) => (
                    <th key={spanIndex} scope="colgroup" colSpan={span.span * values.length} style={{ ...th, top, textAlign: 'center', borderLeft: border }}>
                      {span.total ? 'Total' : display(result, layout.columns[headerIndex]!, span.value)}
                    </th>
                  ))}
              </tr>
            );
          })}
        </thead>
        <tbody>
          {grid.rows.map((row, rowIndex) => {
            const strong = row.kind !== 'cell';
            return (
              <tr key={rowIndex} style={{ background: row.kind === 'total' ? t.tableHeaderBg : row.kind === 'subtotal' ? `${t.tableHeaderBg}` : undefined }}>
                {rowHeaderCells(row, grid.rows[rowIndex - 1])}
                {grid.columns.flatMap((column, columnIndex) => values.map((measure) => {
                  const value = grid.value(row, column, measure);
                  const rule = !strong && !column.total ? formats.get(measure) : undefined;
                  const look = rule ? conditionalCell(rule.format, value, rule.stats) : undefined;
                  return (
                    <td
                      key={`${columnIndex}-${measure}`}
                      onClick={(event) => click(row, column, event)}
                      title={look?.tone ? CONDITIONAL_TONE_LABELS[look.tone] : undefined}
                      style={{
                        padding: '6px 10px',
                        borderBottom: border,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        color: value === undefined || value === null ? t.textMuted : t.textPrimary,
                        fontWeight: strong || column.total ? 600 : 400,
                        cursor: onCellClick && !strong && !column.total ? 'pointer' : undefined,
                        ...(look?.background ? { background: look.background } : {}),
                        ...(look?.bar ? { backgroundImage: `linear-gradient(90deg, ${look.bar.color} ${look.bar.width}%, transparent ${look.bar.width}%)` } : {}),
                        ...(column.total ? { borderLeft: border } : {}),
                      }}
                    >
                      {look?.tone ? <ConditionalToneIcon tone={look.tone} /> : null}
                      {display(result, measure, value)}
                    </td>
                  );
                }))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {grid.truncated ? <p style={{ color: t.textMuted, fontSize: 11, fontFamily: t.font, margin: '6px 8px' }}>Showing the first {grid.rows.length} rows and {grid.columns.length} columns. Filter the page or move a field to see the rest.</p> : null}
    </div>
  );
}

/** The same pivot as static markup, for Custom layouts and exported pages. */
export function pivotHtml(result: QueryResult, layout: PivotLayout, conditionalFormats?: DashboardConditionalFormat[]): string {
  const grid = buildPivotGrid(result, layout);
  const values = layout.values;
  if (!values.length) return '<p class="muted">No measure to show.</p>';
  const formats = cellStats(grid, (conditionalFormats ?? []).filter((format) => values.includes(format.column)));
  const levels = layout.columns.length;
  const measureRow = values.length > 1 || levels === 0;
  const headerRows = Math.max(1, levels + (measureRow ? 1 : 0));
  const head: string[] = [];
  for (let index = 0; index < headerRows; index += 1) {
    const cells: string[] = [];
    if (index === 0) cells.push(...(layout.rows.length ? layout.rows : ['']).map((alias) => `<th rowspan="${headerRows}">${escapeHtml(alias ? columnLabel(result, alias) : '')}</th>`));
    if (measureRow && index === headerRows - 1) {
      cells.push(...grid.columns.flatMap(() => values.map((measure) => `<th class="num">${escapeHtml(columnLabel(result, measure))}</th>`)));
    } else {
      cells.push(...headerSpans(grid.columns, index).map((span) => `<th colspan="${span.span * values.length}">${escapeHtml(span.total ? 'Total' : display(result, layout.columns[index]!, span.value))}</th>`));
    }
    head.push(`<tr>${cells.join('')}</tr>`);
  }
  const body = grid.rows.map((row) => {
    const headers = row.kind === 'total'
      ? [`<th colspan="${Math.max(1, layout.rows.length)}">Total</th>`]
      : layout.rows.flatMap((alias, index) => {
        if (row.kind === 'subtotal' && index === row.depth) return [`<th colspan="${layout.rows.length - index}">${escapeHtml(`${display(result, layout.rows[index - 1] ?? alias, row.values[index - 1])} total`)}</th>`];
        if (row.kind === 'subtotal' && index > row.depth) return [];
        return [`<th>${escapeHtml(display(result, alias, row.values[index]))}</th>`];
      });
    const cells = grid.columns.flatMap((column) => values.map((measure) => {
      const value = grid.value(row, column, measure);
      const rule = row.kind === 'cell' && !column.total ? formats.get(measure) : undefined;
      const look = rule ? conditionalCell(rule.format, value, rule.stats) : undefined;
      const style = [look?.background ? `background:${look.background}` : '', look?.bar ? `background-image:linear-gradient(90deg, ${look.bar.color} ${look.bar.width}%, transparent ${look.bar.width}%)` : ''].filter(Boolean).join(';');
      const mark = look?.tone ? `<span class="dql-cf-tone ${look.tone}" title="${escapeHtml(CONDITIONAL_TONE_LABELS[look.tone])}">${look.tone === 'good' ? '✓' : look.tone === 'warning' ? '!' : look.tone === 'bad' ? '✕' : '•'}</span> ` : '';
      return `<td class="num"${style ? ` style="${escapeHtml(style)}"` : ''}>${mark}${escapeHtml(display(result, measure, value))}</td>`;
    }));
    return `<tr${row.kind !== 'cell' ? ` class="${row.kind}"` : ''}>${headers.join('')}${cells.join('')}</tr>`;
  }).join('');
  return `<table class="dql-pivot"><thead>${head.join('')}</thead><tbody>${body}</tbody></table>${grid.truncated ? '<p class="muted">Showing the first rows and columns only.</p>' : ''}`;
}
