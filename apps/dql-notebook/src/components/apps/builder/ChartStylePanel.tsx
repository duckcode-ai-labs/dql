import { useEffect, useRef, useState } from 'react';
import type { DashboardVizStyle } from '@zlens/core/apps/viz-style';
import {
  CONDITIONAL_OP_SYMBOLS,
  CONDITIONAL_TONE_LABELS,
  type ConditionalRuleOp,
  type ConditionalTone,
  type DashboardConditionalFormat,
} from '@zlens/core/apps/conditional-format';
import { pivotTotalsWithDefaults, type PivotTotals } from '@zlens/core/apps/pivot';

const CARTESIAN = new Set(['bar', 'grouped_bar', 'stacked_bar', 'line', 'area']);
const HAS_LEGEND = new Set(['bar', 'grouped_bar', 'stacked_bar', 'line', 'area', 'pie', 'donut']);

type Line = { value: string; label: string };
type Band = { from: string; to: string; label: string };
type Note = { at: string; text: string };
type RuleRow = { op: ConditionalRuleOp; value: string; to: string; tone: ConditionalTone };
type FormatRow = { column: string; kind: DashboardConditionalFormat['kind']; rules: RuleRow[] };
const TABULAR = new Set(['table', 'pivot']);

/** Rows in the panel become formats; a rule without a number is left out until it has one. */
export function conditionalFromRows(rows: FormatRow[]): DashboardConditionalFormat[] {
  return rows.flatMap((row): DashboardConditionalFormat[] => {
    if (!row.column) return [];
    if (row.kind !== 'rules') return [{ column: row.column, kind: row.kind }];
    const rules = row.rules.flatMap((rule): NonNullable<DashboardConditionalFormat['rules']> => {
      const value = rule.value.trim() === '' ? NaN : Number(rule.value);
      const to = rule.to.trim() === '' ? NaN : Number(rule.to);
      if (!Number.isFinite(value)) return [];
      if (rule.op === 'between') return Number.isFinite(to) ? [{ op: rule.op, value: Math.min(value, to), to: Math.max(value, to), tone: rule.tone }] : [];
      return [{ op: rule.op, value, tone: rule.tone }];
    });
    return rules.length ? [{ column: row.column, kind: 'rules' as const, rules }] : [];
  });
}

/** Drop empty fields so an untouched style stays out of the page file. */
export function compactVizStyle(style: DashboardVizStyle): DashboardVizStyle | undefined {
  const next: DashboardVizStyle = { ...style };
  for (const key of Object.keys(next) as Array<keyof DashboardVizStyle>) {
    const value = next[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
  }
  return Object.keys(next).length ? next : undefined;
}

/** Rows typed in the panel become style entries; incomplete rows are left out. */
export function styleMarksFromRows(lines: Line[], bands: Band[], notes: Note[]): Pick<DashboardVizStyle, 'referenceLines' | 'bands' | 'annotations'> {
  const number = (value: string) => (value.trim() === '' ? NaN : Number(value));
  return {
    referenceLines: lines.flatMap((line) => {
      const value = number(line.value);
      return Number.isFinite(value) ? [{ value, ...(line.label.trim() ? { label: line.label.trim() } : {}) }] : [];
    }),
    bands: bands.flatMap((band) => {
      const from = number(band.from);
      const to = number(band.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
      return [{ from: Math.min(from, to), to: Math.max(from, to), ...(band.label.trim() ? { label: band.label.trim() } : {}) }];
    }),
    annotations: notes.flatMap((note) => (note.at.trim() && note.text.trim() ? [{ at: note.at.trim(), text: note.text.trim() }] : [])),
  };
}

/**
 * The Studio's chart style controls. Everything here writes `viz.style` on
 * the tile, the same fields the App AI writes, so a hand-styled chart and an
 * AI-styled chart are stored and rendered the same way.
 */
export function ChartStylePanel({ vizType, style, legacyFormat, disabled, onChange, measureColumns = [], onTotals, kpiUnit }: {
  vizType: string;
  style?: DashboardVizStyle;
  /** The number format a tile saved before `viz.style` existed. */
  legacyFormat?: string;
  disabled: boolean;
  onChange: (style: DashboardVizStyle | undefined) => void;
  /** Number columns a table or pivot can format: output name and the name readers see. */
  measureColumns?: Array<{ name: string; label: string }>;
  /** Pivots: totals change the tile's query too, so the caller saves them. */
  onTotals?: (totals: PivotTotals) => void;
  /** KPIs: the measure's unit, so a rate's target is typed as a percent. */
  kpiUnit?: string;
}): JSX.Element {
  const current = style ?? {};
  const cartesian = CARTESIAN.has(vizType);
  const tabular = TABULAR.has(vizType);
  const [formats, setFormats] = useState<FormatRow[]>(() => (current.conditional ?? []).map((format) => ({
    column: format.column,
    kind: format.kind,
    rules: (format.rules ?? []).map((rule) => ({ op: rule.op, value: String(rule.value), to: rule.to !== undefined ? String(rule.to) : '', tone: rule.tone })),
  })));
  const percentTarget = kpiUnit === 'percent';
  const [kpiTarget, setKpiTarget] = useState(() => (current.kpi?.target === undefined ? '' : String(percentTarget ? Math.round(current.kpi.target * 10000) / 100 : current.kpi.target)));
  const [kpiLabel, setKpiLabel] = useState(current.kpi?.targetLabel ?? '');
  const commitKpi = (patch: { better?: 'higher' | 'lower' } = {}) => {
    const typed = kpiTarget.trim() === '' ? NaN : Number(kpiTarget);
    const kpi = {
      ...(Number.isFinite(typed) ? { target: percentTarget ? typed / 100 : typed } : {}),
      ...(kpiLabel.trim() ? { targetLabel: kpiLabel.trim().slice(0, 60) } : {}),
      ...((patch.better ?? current.kpi?.better) === 'lower' ? { better: 'lower' as const } : {}),
    };
    onChange(compactVizStyle({ ...current, kpi: Object.keys(kpi).length ? kpi : undefined }));
  };
  const commitFormats = (next = formats) => {
    const conditional = conditionalFromRows(next);
    onChange(compactVizStyle({ ...current, conditional }));
  };
  // The rows start from the saved style once per tile (the caller keys this
  // panel by tile). A save must never reset a row the author is still typing.
  const [lines, setLines] = useState<Line[]>(() => (current.referenceLines ?? []).map((line) => ({ value: String(line.value), label: line.label ?? '' })));
  const [bands, setBands] = useState<Band[]>(() => (current.bands ?? []).map((band) => ({ from: String(band.from), to: String(band.to), label: band.label ?? '' })));
  const [notes, setNotes] = useState<Note[]>(() => (current.annotations ?? []).map((note) => ({ at: note.at, text: note.text })));

  const set = (patch: Partial<DashboardVizStyle>) => onChange(compactVizStyle({ ...current, ...patch }));
  // Rows typed since the last save. The panel closes when another tile is
  // selected, sometimes without a blur first, so it saves them on the way out.
  const pending = useRef(false);
  const commitMarks = (nextLines = lines, nextBands = bands, nextNotes = notes) => {
    pending.current = false;
    set(styleMarksFromRows(nextLines, nextBands, nextNotes));
  };
  const latest = useRef({ commitMarks, disabled });
  latest.current = { commitMarks, disabled };
  useEffect(() => () => {
    if (pending.current && !latest.current.disabled) latest.current.commitMarks();
  }, []);
  const edit = <T,>(setRows: (rows: T[]) => void) => (rows: T[]) => {
    pending.current = true;
    setRows(rows);
  };
  const editLines = edit(setLines);
  const editBands = edit(setBands);
  const editNotes = edit(setNotes);
  const format = current.format ?? (legacyFormat === 'currency' || legacyFormat === 'percent' ? legacyFormat : 'number');

  return <section className="chart-style-panel" aria-label="Chart style">
    <label>Style</label>
    <div className="chart-style-grid">
      <label htmlFor="chart-style-format">Numbers</label>
      <select id="chart-style-format" disabled={disabled} value={format} onChange={(event) => set({ format: event.target.value as DashboardVizStyle['format'] })}>
        <option value="number">Number</option>
        <option value="compact">Compact (1.2M)</option>
        <option value="currency">Currency</option>
        <option value="percent">Percent</option>
      </select>
      <label htmlFor="chart-style-palette">Colours</label>
      <select id="chart-style-palette" disabled={disabled} value={current.palette ?? 'dql'} onChange={(event) => set({ palette: event.target.value === 'dql' ? undefined : event.target.value as DashboardVizStyle['palette'] })}>
        <option value="dql">ZLens</option>
        <option value="cool">Cool</option>
        <option value="warm">Warm</option>
        <option value="mono">Mono</option>
        <option value="pastel">Pastel</option>
      </select>
      {HAS_LEGEND.has(vizType) ? <>
        <label htmlFor="chart-style-legend">Legend</label>
        <select id="chart-style-legend" disabled={disabled} value={current.legend ?? 'top'} onChange={(event) => set({ legend: event.target.value === 'top' ? undefined : event.target.value as DashboardVizStyle['legend'] })}>
          <option value="top">Top</option>
          <option value="right">Right</option>
          <option value="bottom">Bottom</option>
          <option value="none">Hidden</option>
        </select>
      </> : null}
      {cartesian ? <>
        <label htmlFor="chart-style-labels">Value labels</label>
        <select id="chart-style-labels" disabled={disabled} value={current.labels ?? 'none'} onChange={(event) => set({ labels: event.target.value === 'none' ? undefined : event.target.value as DashboardVizStyle['labels'] })}>
          <option value="none">None</option>
          <option value="last">Last point</option>
          <option value="all">Every mark</option>
        </select>
        <label htmlFor="chart-style-sort">Order</label>
        <select id="chart-style-sort" disabled={disabled} value={current.sort ?? 'none'} onChange={(event) => set({ sort: event.target.value === 'none' ? undefined : event.target.value as DashboardVizStyle['sort'] })}>
          <option value="none">As queried</option>
          <option value="desc">Largest first</option>
          <option value="asc">Smallest first</option>
        </select>
      </> : null}
    </div>
    {cartesian ? <label className="chart-style-check" htmlFor="chart-style-stack">
      <input id="chart-style-stack" type="checkbox" disabled={disabled} checked={Boolean(current.stack)} onChange={(event) => set({ stack: event.target.checked || undefined })} />
      Stack series
    </label> : null}

    {cartesian ? <div
      className="chart-style-marks"
      // One save when focus leaves the section, so a row's value and label
      // are written together and nothing is saved mid-typing.
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitMarks(); }}
    >
      <span className="chart-style-heading">Reference lines</span>
      {lines.map((line, index) => <div key={`line-${index}`} className="chart-style-row">
        <input aria-label="Reference value" inputMode="decimal" placeholder="Value" disabled={disabled} value={line.value}
          onChange={(event) => editLines(lines.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))} />
        <input aria-label="Reference label" placeholder="Label" disabled={disabled} value={line.label}
          onChange={(event) => editLines(lines.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))} />
        <button type="button" aria-label="Remove reference line" disabled={disabled} onClick={() => { const next = lines.filter((_, i) => i !== index); setLines(next); commitMarks(next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setLines([...lines, { value: '', label: '' }])}>Add reference line</button>

      <span className="chart-style-heading">Target bands</span>
      {bands.map((band, index) => <div key={`band-${index}`} className="chart-style-row">
        <input aria-label="Band from" inputMode="decimal" placeholder="From" disabled={disabled} value={band.from}
          onChange={(event) => editBands(bands.map((item, i) => (i === index ? { ...item, from: event.target.value } : item)))} />
        <input aria-label="Band to" inputMode="decimal" placeholder="To" disabled={disabled} value={band.to}
          onChange={(event) => editBands(bands.map((item, i) => (i === index ? { ...item, to: event.target.value } : item)))} />
        <input aria-label="Band label" placeholder="Label" disabled={disabled} value={band.label}
          onChange={(event) => editBands(bands.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))} />
        <button type="button" aria-label="Remove band" disabled={disabled} onClick={() => { const next = bands.filter((_, i) => i !== index); setBands(next); commitMarks(lines, next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setBands([...bands, { from: '', to: '', label: '' }])}>Add target band</button>

      <span className="chart-style-heading">Notes on the timeline</span>
      {notes.map((note, index) => <div key={`note-${index}`} className="chart-style-row">
        <input aria-label="Note position" placeholder="2026-07-14" disabled={disabled} value={note.at}
          onChange={(event) => editNotes(notes.map((item, i) => (i === index ? { ...item, at: event.target.value } : item)))} />
        <input aria-label="Note text" placeholder="What happened" disabled={disabled} value={note.text}
          onChange={(event) => editNotes(notes.map((item, i) => (i === index ? { ...item, text: event.target.value } : item)))} />
        <button type="button" aria-label="Remove note" disabled={disabled} onClick={() => { const next = notes.filter((_, i) => i !== index); setNotes(next); commitMarks(lines, bands, next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setNotes([...notes, { at: '', text: '' }])}>Add note</button>
      <small className="field-help">Notes are saved in the page file in git and appear on every run.</small>
    </div> : null}

    {vizType === 'single_value' || vizType === 'kpi' ? <div
      className="chart-style-marks"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitKpi(); }}
    >
      <span className="chart-style-heading">Target</span>
      <div className="chart-style-row">
        <input aria-label={percentTarget ? 'Target, in percent' : 'Target value'} inputMode="decimal" placeholder={percentTarget ? 'Target %' : 'Target'} disabled={disabled} value={kpiTarget} onChange={(event) => setKpiTarget(event.target.value)} />
        <input aria-label="Target name" placeholder="Plan" disabled={disabled} value={kpiLabel} onChange={(event) => setKpiLabel(event.target.value)} />
      </div>
      <div className="chart-style-row">
        <select aria-label="Which way is better" disabled={disabled} value={current.kpi?.better ?? 'higher'} onChange={(event) => commitKpi({ better: event.target.value as 'higher' | 'lower' })}>
          <option value="higher">Higher is better</option>
          <option value="lower">Lower is better</option>
        </select>
      </div>
      <small className="field-help">Put a date on the shelves to show the latest period, its change and the trend.</small>
    </div> : null}

    {vizType === 'pivot' && onTotals ? (() => {
      const totals = pivotTotalsWithDefaults(current.totals);
      const toggle = (key: keyof PivotTotals, on: boolean) => onTotals({ ...(current.totals ?? {}), [key]: on });
      return <fieldset className="chart-style-totals">
        <legend className="chart-style-heading">Totals</legend>
        <label className="chart-style-check" htmlFor="pivot-total-rows"><input id="pivot-total-rows" type="checkbox" disabled={disabled} checked={totals.rows} onChange={(event) => toggle('rows', event.target.checked)} /> Total row</label>
        <label className="chart-style-check" htmlFor="pivot-total-columns"><input id="pivot-total-columns" type="checkbox" disabled={disabled} checked={totals.columns} onChange={(event) => toggle('columns', event.target.checked)} /> Total column</label>
        <label className="chart-style-check" htmlFor="pivot-subtotals"><input id="pivot-subtotals" type="checkbox" disabled={disabled} checked={totals.subtotals} onChange={(event) => toggle('subtotals', event.target.checked)} /> Subtotals</label>
        <small className="field-help">Totals are recomputed from the rows by the warehouse, so a distinct count or a rate totals correctly.</small>
      </fieldset>;
    })() : null}

    {tabular ? <div
      className="chart-style-marks"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitFormats(); }}
    >
      <span className="chart-style-heading">Conditional formatting</span>
      {formats.map((row, index) => {
        const setRow = (patch: Partial<FormatRow>, commit = false) => {
          const next = formats.map((item, i) => (i === index ? { ...item, ...patch } : item));
          setFormats(next);
          if (commit) commitFormats(next);
        };
        return <div key={`format-${index}`} className="chart-style-format">
          <div className="chart-style-row">
            <select aria-label="Column to format" disabled={disabled} value={row.column} onChange={(event) => setRow({ column: event.target.value }, true)}>
              <option value="">Choose a number</option>
              {measureColumns.map((column) => <option key={column.name} value={column.name}>{column.label}</option>)}
            </select>
            <select aria-label="How to format it" disabled={disabled} value={row.kind} onChange={(event) => {
              const kind = event.target.value as FormatRow['kind'];
              setRow({ kind, rules: kind === 'rules' && !row.rules.length ? [{ op: 'gte', value: '', to: '', tone: 'good' }] : row.rules }, kind !== 'rules');
            }}>
              <option value="scale">Colour scale</option>
              <option value="bars">Data bars</option>
              <option value="rules">Rules</option>
            </select>
            <button type="button" aria-label="Remove formatting" disabled={disabled} onClick={() => { const next = formats.filter((_, i) => i !== index); setFormats(next); commitFormats(next); }}>×</button>
          </div>
          {row.kind === 'rules' ? <>
            {row.rules.map((rule, ruleIndex) => {
              const setRule = (patch: Partial<RuleRow>, commit = false) => setRow({ rules: row.rules.map((item, i) => (i === ruleIndex ? { ...item, ...patch } : item)) }, commit);
              return <div key={`rule-${ruleIndex}`} className="chart-style-row chart-style-rule">
                <select aria-label="Condition" disabled={disabled} value={rule.op} onChange={(event) => setRule({ op: event.target.value as ConditionalRuleOp }, true)}>
                  {(Object.keys(CONDITIONAL_OP_SYMBOLS) as ConditionalRuleOp[]).map((op) => <option key={op} value={op}>{CONDITIONAL_OP_SYMBOLS[op]}</option>)}
                </select>
                <input aria-label="Value" inputMode="decimal" placeholder="Value" disabled={disabled} value={rule.value} onChange={(event) => setRule({ value: event.target.value })} />
                {rule.op === 'between' ? <input aria-label="Up to" inputMode="decimal" placeholder="To" disabled={disabled} value={rule.to} onChange={(event) => setRule({ to: event.target.value })} /> : null}
                <select aria-label="Show as" disabled={disabled} value={rule.tone} onChange={(event) => setRule({ tone: event.target.value as ConditionalTone }, true)}>
                  {(Object.keys(CONDITIONAL_TONE_LABELS) as ConditionalTone[]).map((tone) => <option key={tone} value={tone}>{CONDITIONAL_TONE_LABELS[tone]}</option>)}
                </select>
                <button type="button" aria-label="Remove rule" disabled={disabled} onClick={() => setRow({ rules: row.rules.filter((_, i) => i !== ruleIndex) }, true)}>×</button>
              </div>;
            })}
            <button type="button" className="chart-style-add" disabled={disabled || row.rules.length >= 8} onClick={() => setRow({ rules: [...row.rules, { op: 'lt', value: '', to: '', tone: 'bad' }] })}>Add rule</button>
          </> : null}
        </div>;
      })}
      <button type="button" className="chart-style-add" disabled={disabled || !measureColumns.length || formats.length >= 12} onClick={() => setFormats([...formats, { column: measureColumns[0]?.name ?? '', kind: 'scale', rules: [] }])}>Add formatting</button>
      <small className="field-help">Rules are checked in order; the first that matches marks the cell with its icon and name.</small>
    </div> : null}
  </section>;
}
