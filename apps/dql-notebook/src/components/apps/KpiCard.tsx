import { useEffect, useMemo, useRef, useState } from 'react';
import { summarizeKpi, type DashboardKpiStyle, type KpiSummary } from '@zlens/core/apps/kpi';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { escapeHtml } from '@zlens/core/apps/canvas-page';
import type { QueryResult } from '../../store/types';
import { formatDisplayValue } from '../../utils/value-format';

/** The columns a KPI reads: its one measure, and its date when it has a trend. */
export function kpiColumns(query: TileQuery | undefined, result: QueryResult): { valueColumn?: string; timeColumn?: string; grain?: string } {
  const measure = query?.measures[0];
  const valueColumn = measure ? measure.alias ?? measure.measure : query?.calculations?.[0]?.id ?? result.columns.find((column) => typeof result.rows[0]?.[column] === 'number');
  const time = query?.dimensions.find((dimension) => dimension.timeGrain);
  const timeColumn = time ? time.alias ?? `${time.field}_${time.timeGrain}` : undefined;
  return { ...(valueColumn ? { valueColumn } : {}), ...(timeColumn ? { timeColumn, grain: time!.timeGrain! } : {}) };
}

/** Whether a KPI tile draws as the trend-and-target card rather than a bare number. */
export function usesKpiCard(query: TileQuery | undefined, style: { kpi?: DashboardKpiStyle } | undefined): boolean {
  return Boolean(query?.dimensions.some((dimension) => dimension.timeGrain) || style?.kpi?.target !== undefined);
}

interface KpiWords {
  label: string;
  value: string;
  period?: string;
  change?: { text: string; direction: 'up' | 'down' | 'flat'; versus: string };
  target?: { text: string; met: boolean; share: number | null };
}

/** The KPI's numbers in words, formatted with the measure's own unit. */
export function kpiWords(summary: KpiSummary, result: QueryResult, columns: { valueColumn: string; timeColumn?: string }, label: string): KpiWords {
  const meta = (column: string) => result.columnsMeta?.find((entry) => entry.name === column);
  const value = (number: number | null, compact = false) => (number === null ? '—' : formatDisplayValue(columns.valueColumn, number, [], { meta: meta(columns.valueColumn), ...(compact ? { compact: true } : {}) }));
  const period = (raw: unknown) => (columns.timeColumn ? formatDisplayValue(columns.timeColumn, raw, [], { meta: meta(columns.timeColumn) }) : '');
  const big = summary.value !== null && Math.abs(summary.value) >= 1_000_000;
  const words: KpiWords = { label, value: value(summary.value, big) };
  if (summary.period) words.period = `${period(summary.period.value)}${summary.period.partial ? ' so far' : ''}`;
  if (summary.change && summary.previous) {
    const unit = meta(columns.valueColumn);
    const absolute = unit?.kind === 'percent'
      ? `${summary.change.absolute >= 0 ? '+' : '−'}${Math.abs(Math.round(summary.change.absolute * 1000) / 10)} pts`
      : `${summary.change.absolute >= 0 ? '+' : '−'}${value(Math.abs(summary.change.absolute), true)}`;
    const percent = summary.change.percent !== null && unit?.kind !== 'percent' ? ` (${summary.change.percent >= 0 ? '+' : '−'}${Math.abs(Math.round(summary.change.percent * 1000) / 10)}%)` : '';
    words.change = { text: `${absolute}${percent}`, direction: summary.change.direction, versus: `vs ${period(summary.previous.period)}${summary.period?.partial ? ' (full period)' : ''}` };
  }
  if (summary.target) {
    const share = summary.target.share !== null ? `${Math.round(summary.target.share * 100)}% of ` : '';
    words.target = { text: `${share}${summary.target.label ?? 'target'} ${value(summary.target.value)}`, met: summary.target.met, share: summary.target.share };
  }
  return words;
}

function sparklinePath(series: KpiSummary['series'], width: number, height: number): { line: string; area: string; last?: { x: number; y: number } } {
  const points = series.map((point, index) => ({ index, value: point.value })).filter((point): point is { index: number; value: number } => point.value !== null);
  if (points.length < 2) return { line: '', area: '' };
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => (series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 4) + 2);
  const y = (value: number) => height - 3 - ((value - min) / span) * (height - 6);
  const coords = points.map((point) => ({ x: x(point.index), y: y(point.value) }));
  const line = coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1]!.x.toFixed(1)},${height} L${coords[0]!.x.toFixed(1)},${height} Z`;
  return { line, area, last: coords[coords.length - 1] };
}

const UP = 'var(--trust-governed, #3659c9)';
/** Read by screen readers, not drawn. */
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;
const DOWN = 'var(--status-warning, #b26b1f)';

/**
 * A KPI (RFC 0009 step 4): the latest value in large type, its change from
 * the period before (blue up, orange down, with the arrow and words, never
 * colour alone), the trend as a sparkline, and progress to a target with an
 * On track or Off track state.
 */
export function KpiCard({ result, query, style, label }: { result: QueryResult; query: TileQuery | undefined; style?: { kpi?: DashboardKpiStyle }; label: string }): JSX.Element {
  const columns = kpiColumns(query, result);
  // A short tile keeps the number, its period and its change; the trend and the target bar need room.
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Infinity);
  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setRoom(entry?.contentRect.height ?? Infinity));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const summary = useMemo(() => (columns.valueColumn ? summarizeKpi(result.rows, { valueColumn: columns.valueColumn, ...(columns.timeColumn ? { timeColumn: columns.timeColumn, grain: columns.grain } : {}), ...(style?.kpi ? { style: style.kpi } : {}) }) : null), [result.rows, columns.valueColumn, columns.timeColumn, columns.grain, style?.kpi]);
  if (!summary || !columns.valueColumn) return <p className="dql-kpi-empty">This KPI has no number yet.</p>;
  const words = kpiWords(summary, result, { valueColumn: columns.valueColumn, ...(columns.timeColumn ? { timeColumn: columns.timeColumn } : {}) }, label);
  const spark = sparklinePath(summary.series, 240, 40);
  const tone = summary.change?.direction === 'down' ? DOWN : UP;
  return (
    <div ref={frame} className="dql-kpi-trend" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 6, width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', fontVariantNumeric: 'tabular-nums' }}>
      {words.period ? <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{words.period}</span> : null}
      <strong style={{ fontSize: room < 90 ? 24 : 'clamp(24px, 4vw, 34px)', fontWeight: 600, lineHeight: 1.1, color: 'var(--text-primary)' }}>{words.value}</strong>
      {words.change ? (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
          <span style={{ color: words.change.direction === 'flat' ? 'var(--text-secondary)' : tone, fontWeight: 600 }}>
            <span aria-hidden="true">{words.change.direction === 'up' ? '▲' : words.change.direction === 'down' ? '▼' : '■'}</span>
            <span style={VISUALLY_HIDDEN}>{words.change.direction === 'up' ? 'Up' : words.change.direction === 'down' ? 'Down' : 'No change'} </span> {words.change.text}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{words.change.versus}</span>
        </span>
      ) : null}
      {spark.line && room >= (words.target ? 150 : 110) ? (
        <svg viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label={`Trend of ${label} over ${summary.series.length} periods`} style={{ width: '100%', height: 40, display: 'block' }}>
          <path d={spark.area} fill="color-mix(in srgb, var(--accent, #0b7a75) 12%, transparent)" />
          <path d={spark.line} fill="none" stroke="var(--accent, #0b7a75)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          {spark.last ? <circle cx={spark.last.x} cy={spark.last.y} r="3" fill="var(--accent, #0b7a75)" stroke="var(--bg-2, #fff)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
      ) : null}
      {words.target ? (
        <div style={{ display: 'grid', gap: 4 }}>
          {room >= 110 ? <div aria-hidden="true" style={{ height: 6, borderRadius: 999, background: 'var(--bg-1, #f3f0ea)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, (words.target.share ?? 0) * 100))}%`, height: '100%', borderRadius: 999, background: words.target.met ? 'var(--status-success, #0b7a75)' : DOWN }} />
          </div> : null}
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ color: words.target.met ? 'var(--status-success, #0b7a75)' : DOWN, fontWeight: 600 }}>{words.target.met ? '✓ On track' : '✕ Off track'}</strong>
            <span>{words.target.text}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The same KPI as static markup for Custom layouts and exported pages. */
export function kpiHtml(result: QueryResult, query: TileQuery | undefined, style: { kpi?: DashboardKpiStyle } | undefined, label: string): string | null {
  const columns = kpiColumns(query, result);
  if (!columns.valueColumn) return null;
  const summary = summarizeKpi(result.rows, { valueColumn: columns.valueColumn, ...(columns.timeColumn ? { timeColumn: columns.timeColumn, grain: columns.grain } : {}), ...(style?.kpi ? { style: style.kpi } : {}) });
  const words = kpiWords(summary, result, { valueColumn: columns.valueColumn, ...(columns.timeColumn ? { timeColumn: columns.timeColumn } : {}) }, label);
  const spark = sparklinePath(summary.series, 240, 40);
  const change = words.change
    ? `<p class="dql-kpi-change ${words.change.direction}">${words.change.direction === 'up' ? '▲ Up' : words.change.direction === 'down' ? '▼ Down' : 'No change'} ${escapeHtml(words.change.text)} <span class="muted">${escapeHtml(words.change.versus)}</span></p>`
    : '';
  const trend = spark.line ? `<svg viewBox="0 0 240 40" preserveAspectRatio="none" width="100%" height="40" role="img" aria-label="${escapeHtml(`Trend of ${label}`)}"><path d="${spark.area}" fill="rgba(11,122,117,0.12)"/><path d="${spark.line}" fill="none" stroke="#0b7a75" stroke-width="2"/></svg>` : '';
  const target = words.target ? `<p class="dql-kpi-target ${words.target.met ? 'met' : 'missed'}"><strong>${words.target.met ? '✓ On track' : '✕ Off track'}</strong> ${escapeHtml(words.target.text)}</p>` : '';
  return `${words.period ? `<p class="muted">${escapeHtml(words.period)}</p>` : ''}<div class="dql-tile-kpi">${escapeHtml(words.value)}</div>${change}${trend}${target}`;
}
