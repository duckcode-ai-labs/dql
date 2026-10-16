/**
 * Story bindings (RFC 0008 step 8).
 *
 * A story page is prose whose every number is a binding to a governed tile
 * result, written `{{key}}`. The text never holds a literal figure, so a
 * story cannot drift from its data: each run fills the bindings from that
 * run's results, and a number with no binding is refused when the page is
 * saved. Browser-safe: no Node imports.
 */
import { rankResultRows } from './result-ranking.js';

export interface StoryBinding {
  key: string;
  tileId: string;
  label: string;
  kind: 'number' | 'text';
  value: number | string | null;
  unit?: { kind: 'currency' | 'percent' | 'number'; currency?: string };
  /** The value as readers see it. */
  display: string;
}

export type StoryBindingCatalog = Record<string, StoryBinding>;

/** The minimum of a run tile the catalog needs; matches the run response. */
export interface StoryBindingTileInput {
  tileId: string;
  status: string;
  title?: string;
  tileType?: string;
  result?: {
    columns?: unknown[];
    rows?: Array<Record<string, unknown>>;
    columnsMeta?: Array<{ name?: string; kind?: string; unit?: string }>;
  };
  driver?: {
    headline: { current?: string; prior?: string; delta?: string; percentDelta?: string };
    dimensions: Array<{ label: string; members: Array<{ label: string; delta?: string; role: string; other?: boolean }> }>;
  };
}

export const STORY_BINDING_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const MAX_STORY_TEXT = 4000;
export const MAX_STORY_BLOCKS = 40;
/** Members per grouped tile that get their own binding. */
export const MAX_STORY_MEMBERS = 20;

const slug = (value: string) => value.trim();

/** Every value a story on this page may bind to, from one run's results. */
export function buildStoryBindingCatalog(tiles: StoryBindingTileInput[], titles: Record<string, string | undefined> = {}): StoryBindingCatalog {
  const catalog: StoryBindingCatalog = {};
  const add = (binding: Omit<StoryBinding, 'display'> & { display?: string }) => {
    catalog[binding.key] = { ...binding, display: binding.display ?? formatStoryValue(binding.value, binding.unit) };
  };
  for (const tile of tiles) {
    if (tile.status !== 'ok' || tile.tileType === 'text') continue;
    const title = titles[tile.tileId] ?? tile.title ?? tile.tileId;
    if (tile.driver) {
      const { headline } = tile.driver;
      const number = (text: string | undefined) => (text === undefined ? null : Number(text));
      // The measure's unit travels on the driver result's column metadata.
      const measureMeta = (tile.result?.columnsMeta ?? []).find((entry) => entry?.name === 'current');
      const unit: StoryBinding['unit'] = measureMeta?.kind === 'currency' ? { kind: 'currency', currency: measureMeta.unit || 'USD' } : measureMeta?.kind === 'percent' ? { kind: 'percent' } : undefined;
      add({ key: `${tile.tileId}.current`, tileId: tile.tileId, label: `${title} — explained period`, kind: 'number', value: number(headline.current), unit });
      add({ key: `${tile.tileId}.prior`, tileId: tile.tileId, label: `${title} — comparison period`, kind: 'number', value: number(headline.prior), unit });
      add({ key: `${tile.tileId}.change`, tileId: tile.tileId, label: `${title} — change`, kind: 'number', value: number(headline.delta), unit, display: formatSigned(number(headline.delta), '', unit) });
      add({ key: `${tile.tileId}.change_percent`, tileId: tile.tileId, label: `${title} — change in percent`, kind: 'number', value: number(headline.percentDelta), unit: { kind: 'percent' }, display: formatSigned(number(headline.percentDelta), '%') });
      const top = tile.driver.dimensions[0];
      const lead = top?.members.find((member) => member.role === 'driver' && !member.other);
      if (top && lead) {
        add({ key: `${tile.tileId}.top_dimension`, tileId: tile.tileId, label: `${title} — dimension that explains most`, kind: 'text', value: top.label.toLowerCase(), display: top.label.toLowerCase() });
        add({ key: `${tile.tileId}.top_member`, tileId: tile.tileId, label: `${title} — member that moved most`, kind: 'text', value: lead.label, display: lead.label });
        add({ key: `${tile.tileId}.top_member_change`, tileId: tile.tileId, label: `${title} — change from that member`, kind: 'number', value: number(lead.delta), unit, display: formatSigned(number(lead.delta), '', unit) });
      }
      continue;
    }
    // A pivot's total rows are totals, not members; its flag columns are not figures.
    const rows = (tile.result?.rows ?? []).filter((row) => row && typeof row === 'object'
      && !Object.entries(row).some(([column, value]) => column.startsWith('__total_') && Number(value) === 1));
    if (rows.length === 0) continue;
    const columns = (tile.result?.columns ?? Object.keys(rows[0]!))
      .map((column) => (typeof column === 'string' ? column : String((column as { name?: unknown })?.name ?? column)))
      .filter((column) => !column.startsWith('__total_'));
    const meta = new Map((tile.result?.columnsMeta ?? []).filter((entry) => typeof entry?.name === 'string').map((entry) => [entry.name!, entry]));
    const numeric = columns.filter((column) => rows.some((row) => toNumber(row[column]) !== null) && rows.every((row) => row[column] === null || row[column] === undefined || toNumber(row[column]) !== null));
    const labelColumn = columns.find((column) => !numeric.includes(column) && rows.some((row) => typeof row[column] === 'string' || row[column] instanceof Date));
    const unitFor = (column: string): StoryBinding['unit'] => {
      const entry = meta.get(column);
      if (entry?.kind === 'currency') return { kind: 'currency', currency: entry.unit || 'USD' };
      if (entry?.kind === 'percent' || /percent|pct|_rate$|^rate$|ratio/i.test(column)) return { kind: 'percent' };
      return undefined;
    };
    if (rows.length === 1) {
      for (const column of numeric) {
        add({ key: `${tile.tileId}.${column}`, tileId: tile.tileId, label: `${title} — ${humanize(column)}`, kind: 'number', value: toNumber(rows[0]![column]), unit: unitFor(column) });
      }
      continue;
    }
    if (!labelColumn) continue;
    const first = numeric[0];
    // Which members get bindings, and which row a repeated member resolves
    // to, must not depend on the order the warehouse returned the rows in:
    // rank by the first measure's magnitude, then by member. Bindings keep
    // the result's own order.
    const boundRows = new Set<Record<string, unknown>>();
    const boundMembers = new Set<string>();
    for (const { row } of rankResultRows(rows, { measure: (row) => (first ? toNumber(row[first]) : null), member: (row) => row[labelColumn] })) {
      if (boundMembers.size >= MAX_STORY_MEMBERS) break;
      const member = memberText(row[labelColumn]);
      if (!member || boundMembers.has(member)) continue;
      boundMembers.add(member);
      boundRows.add(row);
    }
    for (const column of numeric) {
      const unit = unitFor(column);
      for (const row of rows) {
        if (!boundRows.has(row)) continue;
        const member = memberText(row[labelColumn]);
        add({ key: `${tile.tileId}.${column}[${member}]`, tileId: tile.tileId, label: `${title} — ${humanize(column)} for ${member}`, kind: 'number', value: toNumber(row[column]), unit });
      }
    }
    if (first) {
      // The highest value leads; an equal value is settled by member.
      const best = rankResultRows(rows, { measure: (row) => toNumber(row[first]), member: (row) => row[labelColumn], by: 'value' })
        .find((entry) => entry.value !== null)?.row;
      if (best) {
        const member = memberText(best[labelColumn]);
        add({ key: `${tile.tileId}.leader`, tileId: tile.tileId, label: `${title} — highest ${humanize(labelColumn)} by ${humanize(first)}`, kind: 'text', value: member, display: readableMember(member) });
        add({ key: `${tile.tileId}.leader_value`, tileId: tile.tileId, label: `${title} — ${humanize(first)} of that leader`, kind: 'number', value: toNumber(best[first]), unit: unitFor(first) });
      }
    }
  }
  return catalog;
}

/**
 * A figure's label for lists and alerts: "Revenue — revenue" reads as
 * "Revenue"; anything more specific is kept.
 */
export function figureLabel(label: string): string {
  const at = label.indexOf(' — ');
  if (at < 0) return label;
  const title = label.slice(0, at).trim();
  const field = label.slice(at + 3).trim();
  return title.toLowerCase() === field.toLowerCase() ? title : label;
}

/**
 * A binding's caption in plain words, as readers see it beside the number:
 * "Revenue by region — revenue for US" reads "Revenue for US", and a
 * leader's value names the leader: "Revenue of the top region (US)".
 */
export function bindingCaption(binding: Pick<StoryBinding, 'label'> & Partial<Pick<StoryBinding, 'key' | 'tileId'>>, catalog?: StoryBindingCatalog): string {
  if (binding.key?.endsWith('.leader_value') && binding.tileId && catalog) {
    const leader = catalog[`${binding.tileId}.leader`];
    const parts = leader ? / — highest (.+) by (.+)$/.exec(leader.label) : null;
    if (leader && parts) return `${parts[2]!.charAt(0).toUpperCase()}${parts[2]!.slice(1)} of the top ${parts[1]} (${leader.display})`;
  }
  const rest = binding.label.includes(' — ') ? binding.label.slice(binding.label.indexOf(' — ') + 3) : binding.label;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export interface StoryTextIssue {
  code: 'NAKED_NUMBER' | 'UNKNOWN_BINDING' | 'EMPTY_BINDING' | 'TOO_LONG';
  message: string;
  token?: string;
}

/**
 * Check story text: every number must be a binding, and (when a catalog is
 * given) every binding must exist. A four-digit year on its own and digits
 * inside words such as "Q1" are not figures and are allowed.
 */
export function validateStoryText(markdown: string, knownKeys?: ReadonlySet<string>): StoryTextIssue[] {
  const issues: StoryTextIssue[] = [];
  if (markdown.length > MAX_STORY_TEXT) issues.push({ code: 'TOO_LONG', message: `Story text must be at most ${MAX_STORY_TEXT} characters.` });
  for (const match of markdown.matchAll(STORY_BINDING_PATTERN)) {
    const key = slug(match[1] ?? '');
    if (!key) issues.push({ code: 'EMPTY_BINDING', message: 'A {{ }} binding is empty.' });
    else if (knownKeys && !knownKeys.has(key)) issues.push({ code: 'UNKNOWN_BINDING', message: `{{${key}}} is not a value on this page.`, token: key });
  }
  const prose = markdown.replace(STORY_BINDING_PATTERN, ' ');
  for (const match of prose.matchAll(/(?<![\p{L}\d_])[-+]?\$?\d[\d,.]*(?:%|[kKmMbB](?![\p{L}]))?/gu)) {
    const token = match[0].replace(/[.,]+$/, '');
    if (/^(19|20)\d{2}$/.test(token)) continue;
    issues.push({ code: 'NAKED_NUMBER', message: `"${token}" is a number written into the text. Bind it with {{…}} so it always matches the data.`, token });
  }
  return issues;
}

/** Story text split into prose and bound values, for rendering. */
export function splitStoryText(markdown: string): Array<{ kind: 'text'; text: string } | { kind: 'binding'; key: string }> {
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'binding'; key: string }> = [];
  let last = 0;
  for (const match of markdown.matchAll(STORY_BINDING_PATTERN)) {
    if (match.index! > last) parts.push({ kind: 'text', text: markdown.slice(last, match.index) });
    parts.push({ kind: 'binding', key: slug(match[1] ?? '') });
    last = match.index! + match[0].length;
  }
  if (last < markdown.length) parts.push({ kind: 'text', text: markdown.slice(last) });
  return parts;
}

export function storyBindingKeys(markdown: string): string[] {
  return Array.from(new Set(Array.from(markdown.matchAll(STORY_BINDING_PATTERN), (match) => slug(match[1] ?? '')).filter(Boolean)));
}

export function formatStoryValue(value: number | string | null, unit?: StoryBinding['unit']): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  if (unit?.kind === 'percent') {
    // Ratios are stored 0..1; percent deltas arrive as percent points.
    const points = Math.abs(value) <= 1.5 ? value * 100 : value;
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(points)}%`;
  }
  const compact = Math.abs(value) >= 1_000_000;
  if (unit?.kind === 'currency') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: unit.currency || 'USD',
      notation: compact ? 'compact' : 'standard',
      // Whole amounts read as "$70", not "$70.00".
      minimumFractionDigits: compact || Number.isInteger(value) || Math.abs(value) >= 100 ? 0 : 2,
      maximumFractionDigits: compact ? 1 : Math.abs(value) >= 100 ? 0 : 2,
    }).format(value);
  }
  return new Intl.NumberFormat('en-US', { notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2 }).format(value);
}

function formatSigned(value: number | null, suffix = '', unit?: StoryBinding['unit']): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const text = unit?.kind === 'currency' ? formatStoryValue(Math.abs(value), unit) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}${suffix}`;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(value.trim())) return Number(value);
  return null;
}

function memberText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z?$/.test(text) ? text.slice(0, 10) : text.replace(/[{}\]]/g, '');
}

/** A period start reads as a period ("Jan 2026"); other members as written. */
function readableMember(member: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(member);
  if (!match) return member;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return match[3] === '01'
    ? date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' })
    : date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function humanize(value: string): string {
  return value.replace(/__/g, ' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}
